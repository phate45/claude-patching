/**
 * Chunk-scope analysis — the guard against cross-chunk symbol injection.
 *
 * Since CC 2.1.246 the native bundle is ~1700 separately-scoped Bun chunk
 * modules, each with its own `import{...}from"/$bunfs/root/chunk-xxxx.js"` list.
 * Patches run against the transparent concat of those chunks and are therefore
 * chunk-blind: a minified identifier captured at one offset may simply not be
 * bound at another, even though both offsets sit in the same flat string.
 *
 * That failure is invisible to everything else in the pipeline. The pattern
 * matched, so `--check` passes; the file parses, so the syntax check passes; the
 * binary assembles and loads. It only detonates when the injected expression is
 * finally evaluated at runtime, as a `ReferenceError`. The real case:
 * teammate-workflow-gate injecting the Workflow gate into SendMessage's prompt
 * builder, which killed the session on the first `ToolSearch select:SendMessage`.
 *
 * The check is a shadow apply: run each patch for real against a scratch copy of
 * the pristine extract, diff it, map every inserted span back to the chunk that
 * owns it, and verify each identifier the span *references* appears somewhere in
 * that chunk's text. Presence-anywhere is a deliberately loose test for the
 * binding — it cannot be fooled in the direction that matters, since an absent
 * token is unambiguously free.
 *
 * All the precision work is on the other side: deciding which tokens in a span
 * are references at all. Three things make that hard, and each has a fix here:
 *
 *  - A span is an arbitrary fragment, so its lexical state is inherited. The
 *    prose of a prompt patch reads as a stream of identifiers unless you know
 *    you are inside a template literal. `lexicalStateAt()` recovers the true
 *    state by scanning the pristine chunk up to the insertion point.
 *  - A patch's injected code is one logical unit spread over several spans: it
 *    may declare `_seen` in one and use it in the next. Declarations are
 *    therefore pooled across all of a patch's spans before references are judged.
 *  - Property keys, span-local bindings and ambient globals are not references
 *    to anything a chunk must provide, and are dropped.
 *
 * What survives is reported. Read a finding as "prove this one is fine" — the
 * analysis is a lexer, not a type checker.
 */

// Identifiers that resolve without any chunk-local binding.
const AMBIENT = new Set([
  'globalThis', 'process', 'console', 'Math', 'Date', 'JSON', 'Object', 'Array',
  'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Set', 'Map', 'WeakSet',
  'WeakMap', 'Promise', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Proxy',
  'Reflect', 'Buffer', 'URL', 'TextEncoder', 'TextDecoder', 'Intl', 'NaN',
  'Infinity', 'undefined', 'isNaN', 'parseInt', 'parseFloat', 'require',
  'module', 'exports', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'queueMicrotask', 'structuredClone', 'AbortController',
  'arguments', 'Function', 'Int8Array', 'Uint8Array', 'Float64Array',
]);

const KEYWORDS = new Set([
  'var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while',
  'do', 'in', 'of', 'new', 'typeof', 'void', 'delete', 'instanceof', 'this',
  'true', 'false', 'null', 'async', 'await', 'yield', 'throw', 'try', 'catch',
  'finally', 'switch', 'case', 'default', 'break', 'continue', 'class',
  'extends', 'super', 'import', 'export', 'from', 'as', 'get', 'set', 'static',
  'with', 'debugger',
]);

// ============ Lexical state machine ============

/**
 * A lexer state: which of code / string body / template body we are in, plus the
 * template nesting stack, since `${...}` returns to code and its closing brace
 * has to be told apart from an ordinary one.
 */
function freshState() {
  return { mode: 'code', quote: '', stack: [], prev: '' };
}

function cloneState(s) {
  return { mode: s.mode, quote: s.quote, stack: s.stack.map(f => ({ ...f })), prev: s.prev };
}

/**
 * Advance `state` across `src`, appending every character that is *code* to an
 * accumulator. String and template bodies contribute a `0` placeholder, which
 * keeps the regex-vs-division heuristic honest without leaking prose.
 *
 * @returns {{ code: string, state: object }}
 */
function lex(src, state) {
  const s = state;
  let out = '';
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (s.mode === 'str') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === s.quote) { s.mode = 'code'; s.prev = '0'; out += ' 0 '; }
      i++;
      continue;
    }

    if (s.mode === 'tmpl') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') {
        s.stack.pop();
        s.mode = 'code';
        s.prev = '0';
        out += ' 0 ';
        i++;
        continue;
      }
      if (ch === '$' && src[i + 1] === '{') {
        s.stack.push({ interp: true, depth: 1 });
        s.mode = 'code';
        s.prev = '';
        out += ' ';
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // ---- code ----
    if (ch === '"' || ch === "'") { s.mode = 'str'; s.quote = ch; i++; continue; }
    if (ch === '`') { s.stack.push({ interp: false }); s.mode = 'tmpl'; i++; continue; }

    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) { i = src.length; break; }
      i = end + 2;
      continue;
    }
    // A `/` following a value is division; following an operator, a regex.
    if (ch === '/' && !/[\w$)\]]/.test(s.prev)) {
      i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        i++;
      }
      i++;
      while (i < src.length && /[a-z]/.test(src[i])) i++;
      out += ' 0 ';
      s.prev = '0';
      continue;
    }

    const top = s.stack[s.stack.length - 1];
    if (ch === '{' && top?.interp) top.depth++;
    else if (ch === '}' && top?.interp && --top.depth === 0) {
      s.stack.pop();
      s.mode = 'tmpl';
      i++;
      continue;
    }

    out += ch;
    if (!/\s/.test(ch)) s.prev = ch;
    i++;
  }

  return { code: out, state: s };
}

/**
 * The lexical state at each of `offsets` within `text`, plus the last `TAIL`
 * characters of code seen on the way — the immediate context an insertion lands
 * in, which is what distinguishes `{inverse:` (an object key) from a reference
 * when the span itself starts at the identifier.
 *
 * Offsets must be ascending; the text is walked once and a snapshot taken at
 * each. A chunk can be several MB, so this matters — it is the difference
 * between one pass and one pass per span.
 *
 * @returns {Map<number, {state: object, tail: string}>}
 */
function lexicalStatesAt(text, offsets, TAIL = 40) {
  const out = new Map();
  const state = freshState();
  let cursor = 0;
  let tail = '';
  for (const offset of offsets) {
    if (offset > cursor) {
      tail = (tail + lex(text.slice(cursor, offset), state).code).slice(-TAIL);
      cursor = offset;
    }
    out.set(offset, { state: cloneState(state), tail });
  }
  return out;
}

// ============ Reference extraction ============

/**
 * Names a fragment binds locally: `let a,b=1`, `function f(x)`, `(a,b)=>`,
 * `x=>`, `catch(e)`, `for(let k of ...)`.
 */
function collectDeclarations(code, into) {
  // Run to the statement's `;`, not to the first brace: initialisers are
  // routinely object literals (`var _HS={...},_HP={...}`), and stopping at `{`
  // loses every declarator after the first. String and regex bodies are already
  // placeholders by this point, so no `;` here came from prose. Stop early at a
  // nested declaration keyword, though: `for(let p of x){if(y){let q=...;` has
  // no `;` before `let q`, so a plain `[^;]*` swallows the inner declarator and
  // reports `q` as free.
  for (const m of code.matchAll(/\b(?:var|let|const)\s+((?:(?!\b(?:var|let|const)\b)[^;])*)/g)) {
    // Walk declarators: take the name at the head of each top-level comma group.
    let depth = 0;
    let head = true;
    let word = '';
    for (const ch of m[1]) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      // Flush on the separator too: `var _dl,_st` has no `=` to trigger the
      // commit below, so a bare middle declarator is otherwise lost.
      if (depth === 0 && ch === ',') { if (head && word) into.add(word); head = true; word = ''; continue; }
      if (head && /[\w$]/.test(ch)) { word += ch; continue; }
      if (head && word) { into.add(word); head = false; word = ''; }
      else if (head && !/\s/.test(ch)) head = false;
    }
    if (head && word) into.add(word);
  }
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([\w$]*)\s*\(([^)]*)\)/g)) {
    if (m[1]) into.add(m[1]);
    for (const p of m[2].split(',')) { const n = p.trim().match(/^[\w$]+/); if (n) into.add(n[0]); }
  }
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const p of m[1].split(',')) { const n = p.trim().match(/^[\w$]+/); if (n) into.add(n[0]); }
  }
  for (const m of code.matchAll(/(?:^|[^\w$.])([\w$]+)\s*=>/g)) into.add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([\w$]+)/g)) into.add(m[1]);
  for (const m of code.matchAll(/\bclass\s+([\w$]+)/g)) into.add(m[1]);
}

/**
 * Identifiers used as references, given a set of names known to be local.
 *
 * `code` may be prefixed with a little pristine context — `from` says where the
 * injected part starts. The context is not reported, but it is what tells an
 * object key from a bare reference when the insertion begins mid-literal.
 */
function collectReferences(code, declared, from = 0) {
  const refs = new Set();
  const idRe = /[\w$]+/g;
  let m;
  while ((m = idRe.exec(code)) !== null) {
    if (m.index < from) continue;
    const name = m[0];
    if (/^\d/.test(name)) continue;
    if (KEYWORDS.has(name) || AMBIENT.has(name) || declared.has(name)) continue;

    const before = code.slice(Math.max(0, m.index - 24), m.index);
    if (/(?:\?\.|\.)\s*$/.test(before)) continue;             // member access
    const after = code.slice(m.index + name.length, m.index + name.length + 24);
    if (/^\s*:/.test(after) && /[{,]\s*$/.test(before)) continue;        // object key
    if (/^\s*\(/.test(after) && /[{,]\s*$/.test(before)) continue;       // shorthand method

    refs.add(name);
  }
  return refs;
}

// ============ Diffing ============

/** First index at which the two strings differ, found in blocks to stay native. */
function commonPrefix(a, b, from = 0) {
  const limit = Math.min(a.length, b.length);
  const BLOCK = 1 << 16;
  let i = from;
  while (i + BLOCK <= limit && a.substr(i, BLOCK) === b.substr(i, BLOCK)) i += BLOCK;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

/**
 * Diff `before` against `after` and return the inserted fragments, each with the
 * `before`-offset it was inserted at.
 *
 * Both sides are ~35 MB and a patch changes a handful of short spans, so this
 * walks forward from the common prefix and resynchronises on a literal probe
 * after each divergence rather than computing a real edit script.
 */
function insertedSpans(before, after, { probe = 40, window = 8192 } = {}) {
  const spans = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const advanced = commonPrefix(before.slice(i), after.slice(j));
    i += advanced;
    j += advanced;
    if (i >= before.length || j >= after.length) break;

    let resynced = false;
    for (let k = 0; k < window && !resynced; k++) {
      const needle = before.substr(i + k, probe);
      if (needle.length < probe) break;
      const at = after.indexOf(needle, j);
      if (at !== -1 && at - j < window) {
        if (at > j) spans.push({ offset: i, text: after.slice(j, at) });
        i += k;
        j = at;
        resynced = true;
      }
    }
    if (!resynced) break;
  }
  return spans;
}

/**
 * Build an offset → chunk lookup over a concat boundary list.
 * A patch produces few spans, but each lookup would otherwise scan ~1700 entries.
 */
function chunkLocator(boundaries) {
  return (offset) => {
    let lo = 0;
    let hi = boundaries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = boundaries[mid];
      if (offset < b.start) hi = mid - 1;
      else if (offset >= b.end) lo = mid + 1;
      else return b;
    }
    return null;
  };
}

// ============ Analysis ============

/**
 * Analyse one patch's edits.
 *
 * @param {object}   opts
 * @param {string}   opts.pristine  - the concat as extracted, matching `boundaries`
 * @param {string}   opts.before    - state before this patch ran
 * @param {string}   opts.after     - state after this patch ran
 * @param {object[]} opts.boundaries- `[{ index, name, start, end }]` over `pristine`
 * @param {(index:number)=>string} opts.chunkText - chunk body by index
 * @returns {{identifier:string, chunk:number, chunkName:string, span:string}[]}
 */
function analysePatch({ pristine, before, after, boundaries, chunkText }) {
  const locate = chunkLocator(boundaries);

  // Anchor every span in pristine coordinates. `before` already carries earlier
  // patches' edits, so its own offsets are shifted; the unpatched text just
  // ahead of the insertion is what ties the two coordinate spaces together.
  const located = [];
  for (const span of insertedSpans(before, after)) {
    const anchor = before.slice(Math.max(0, span.offset - 60), span.offset);
    if (anchor.length < 60) continue;
    const at = pristine.indexOf(anchor);
    if (at === -1 || pristine.indexOf(anchor, at + 1) !== -1) continue; // not unique
    const offset = at + anchor.length;
    const chunk = locate(offset);
    if (chunk) located.push({ ...span, offset, chunk });
  }
  if (located.length === 0) return [];

  // Lex each span from the true state at its insertion point, one pass per chunk.
  const byChunk = new Map();
  for (const span of located) {
    if (!byChunk.has(span.chunk.index)) byChunk.set(span.chunk.index, []);
    byChunk.get(span.chunk.index).push(span);
  }
  for (const [index, spans] of byChunk) {
    const body = chunkText(index);
    const base = boundaries.find(b => b.index === index).start;
    spans.sort((a, b) => a.offset - b.offset);
    const states = lexicalStatesAt(body, spans.map(s => s.offset - base));
    for (const span of spans) {
      const { state, tail } = states.get(span.offset - base);
      span.code = tail + lex(span.text, state).code;
      span.codeStart = tail.length;
    }
  }

  // Declarations pool across the whole patch: injected code is one logical unit.
  const declared = new Set();
  for (const span of located) collectDeclarations(span.code.slice(span.codeStart), declared);

  const findings = [];
  const seen = new Set();
  for (const span of located) {
    for (const id of collectReferences(span.code, declared, span.codeStart)) {
      const key = `${span.chunk.index}:${id}`;
      if (seen.has(key)) continue;
      const body = chunkText(span.chunk.index);
      const re = new RegExp(`(?:^|[^\\w$.])${id.replace(/\$/g, '\\$')}(?![\\w$])`);
      if (re.test(body)) continue;
      seen.add(key);
      findings.push({
        identifier: id,
        chunk: span.chunk.index,
        chunkName: span.chunk.name,
        span: span.text.length > 120 ? span.text.slice(0, 117) + '...' : span.text,
      });
    }
  }
  return findings;
}

/**
 * Char-space boundaries over the JS chunks of a binary.
 *
 * `concatJsModules` measures in bytes, but patches read the extract as UTF-8 and
 * every offset here is a string index, so the lengths are recomputed from
 * decoded text. Each chunk is a whole module, so no multi-byte sequence straddles
 * a boundary and the concatenation of the decoded parts is exactly the decoded
 * concatenation.
 *
 * The decoded parts are joined into the pristine concat and chunk bodies are
 * sliced back out of it on demand, so the ~35 MB is held once rather than twice.
 *
 * @param {object[]} chunks - from `bun-binary.extractAllJsModules()`
 * @returns {{concat: string, boundaries: object[], chunkText: (i:number)=>string}}
 */
function buildChunkIndex(chunks) {
  const boundaries = [];
  const parts = [];
  const byIndex = new Map();
  let cursor = 0;
  for (const chunk of chunks) {
    const text = chunk.contents.toString('utf8');
    const record = { index: chunk.index, name: chunk.name, start: cursor, end: cursor + text.length };
    boundaries.push(record);
    byIndex.set(chunk.index, record);
    parts.push(text);
    cursor += text.length;
  }
  const concat = parts.join('');
  const chunkText = (index) => {
    const b = byIndex.get(index);
    return b ? concat.slice(b.start, b.end) : '';
  };
  return { concat, boundaries, chunkText };
}

module.exports = {
  analysePatch,
  buildChunkIndex,
  insertedSpans,
  collectDeclarations,
  collectReferences,
  lexicalStatesAt,
  chunkLocator,
};

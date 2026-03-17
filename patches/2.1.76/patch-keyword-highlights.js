#!/usr/bin/env node
/**
 * Patch to add configurable keyword highlighting, inline code styling,
 * and markdown text formatting in the input box and message history.
 *
 * Stock CC highlights "ultrathink" with a rainbow shimmer. This patch
 * extends the detection + rendering to support additional keywords with
 * configurable colors, shimmer animation, and text effects. It also
 * detects inline `code` spans, **bold**, *italic*, and ~~strikethrough~~
 * markdown formatting.
 *
 * Color values: hex codes ("#8B8CC7"), CSS rgb ("rgb(...)"), or theme
 * names ("rainbow_indigo", "claude", etc.) — all passed through to chalk.
 *
 * Match modes:
 *   - (default) prefix: keyword\w* matches all word forms
 *   - "exact": only the literal keyword
 *   - ["a","b"]: keyword + listed variants (all exact)
 *
 * Touch points:
 *   1. Match finder — expanded regex with prefix/exact/array modes,
 *      returns {word,start,end,style} with two-tier lookup (_HS + _HP).
 *      Also detects inline `code` spans, **bold**, *italic*, ~~strike~~
 *      and returns them with appropriate styles.
 *      Priority: keywords > code spans > markdown formatting.
 *   2. Input box highlight builder — branches on color/colors for assignment
 *   3. Message history renderer — branches on color/colors for per-char coloring
 *   4. Notification trigger — filter to only fire for ultrathink matches
 *   5. Text line renderer — pass bold/italic/underline/strikethrough from
 *      highlight spans, including effect-only (no color) for markdown
 *
 * Does NOT touch CuA/WhL (the boolean "has ultrathink?" test) or the
 * ultrathink_effort system message — only the original keyword triggers that.
 *
 * Usage:
 *   node patch-keyword-highlights.js <cli.js path>
 *   node patch-keyword-highlights.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../lib/output');

// ============================================================
// CONFIGURATION — keyword → style mapping
//
// Nord-inspired palette (https://www.nordtheme.com/)
// ============================================================
//
// color:  single hex/theme → solid color
// colors: array of hex/theme → cycles through them per character
// (ultrathink keeps its stock rainbow behavior — no entry here)
//
// match modes (optional):
//   omitted     — prefix (default): keyword\w* matches all word forms
//   "exact"     — only the literal keyword
//   ["a", "b"]  — keyword + listed variants (all exact)
//
// text effects: bold, italic, underline, strikethrough (optional, default false)
// shimmer: glimmer sweep animation in the input box (optional)
//
// Inline code: `backtick` spans are detected automatically.
// CODE_STYLE controls the content color, DELIM_STYLE the backtick chars.
//
// Markdown formatting: **bold**, *italic* / _italic_, ~~strikethrough~~ detected.
// _italic_ uses alnum boundaries (won't trigger on snake_case identifiers).
// Content gets text effects only (no color change). Delimiters get dim styling.

const CODE_STYLE = { color: "#7ABED9" };           // soft steel cyan (Nord frost neighbor)
const DELIM_STYLE = { color: "#4C566A" };           // Nord comment gray (subtle)

// Markdown formatting — effect-only styles (no color, just text decoration)
const MD_BOLD_STYLE = { bold: true };
const MD_ITALIC_STYLE = { italic: true };
const MD_STRIKE_STYLE = { strikethrough: true };

const KEYWORD_STYLES = {
  // ═══ POP — shimmer + effects ═══
  // Shimmer colors need high contrast from base (~+70 on secondary channels)
  // to be visible as the 3-char glow sweeps across
  "claude":   { color: "#8B8CC7",  shimmer: true, shimmerColor: "#D1D2FF", bold: true },
  "yolo":     { colors: ["#BF616A", "#D08770", "#EBCB8B"], shimmer: true, shimmerColors: ["#FF9CA3", "#FFB89E", "#FFF0C0"] },

  // ═══ ACTION — solid Nord Aurora/Frost ═══
  "commit":   { color: "#A3BE8C",  bold: true },
  "ship":     { color: "#88C0D0" },
  "push":     { color: "#88C0D0" },
  "deploy":   { color: "#D08770",  bold: true },
  "nuke":     { color: "#BF616A",  bold: true },
  "review":   { color: "#B48EAD" },
  "plan":     { color: "#EBCB8B",  match: ["plans", "planned", "planning", "planner"] },
  "spec":     { color: "#EBCB8B",  match: ["specs"] },
  "proposal": { color: "#EBCB8B" },
  "design":   { color: "#B48EAD" },
  "task":     { color: "#88C0D0" },
  "vault":    { color: "#8FBCBB" },
  "worktree": { color: "#A3BE8C" },
  "work log": { color: "#A3BE8C",  bold: true, match: ["work logs"] },

  // ═══ MUTED — subtle italic tint ═══
  "debug":    { color: "#81A1C1",  italic: true },
  "test":     { color: "#D08770",  italic: true },
  "merge":    { color: "#8FBCBB",  italic: true },
  "revert":   { color: "#C88B93",  italic: true },
  "implement":{ color: "#A3BE8C",  italic: true },
  "refactor": { color: "#8FBCBB",  italic: true },
  "research": { color: "#5E81AC",  italic: true },
  "document": { color: "#A3BE8C",  italic: true },
};

// ============================================================
// PATCH IMPLEMENTATION
// ============================================================

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-keyword-highlights.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Build the regex alternation from config + "ultrathink"
const customWords = Object.keys(KEYWORD_STYLES);
const allPatterns = ['ultrathink']; // ultrathink is always exact match

// Build lookup structures: _HS for exact/array, _HP for prefix
const hsEntries = {};  // direct word → style (O(1) lookup)
const hpEntries = {};  // prefix keyword → style (startsWith fallback)

for (const [word, cfg] of Object.entries(KEYWORD_STYLES)) {
  // Strip match from injected style (build-time metadata only)
  const style = { ...cfg };
  delete style.match;

  if (Array.isArray(cfg.match)) {
    // Array mode: base word + explicit variants, all exact
    allPatterns.push(word, ...cfg.match);
    hsEntries[word] = style;
    for (const v of cfg.match) hsEntries[v] = style;
  } else if (cfg.match === 'exact') {
    // Exact mode: literal keyword only
    allPatterns.push(word);
    hsEntries[word] = style;
  } else {
    // Default: prefix mode — keyword + alphanumeric suffix (excludes underscore
    // so "claude_test" highlights just "claude", not the whole snake_case token)
    allPatterns.push(word + '[a-zA-Z0-9]*');
    hpEntries[word] = style;
  }
}

// Sort by base length descending (strip suffix quantifier for comparison)
allPatterns.sort((a, b) => b.replace(/\[a-zA-Z0-9\]\*$/, '').length - a.replace(/\[a-zA-Z0-9\]\*$/, '').length);
const wordPattern = allPatterns.join('|');

// Serialize lookup structures for injection
const hsJson = JSON.stringify(hsEntries);
const hpJson = JSON.stringify(hpEntries);
const codeStyleJson = JSON.stringify(CODE_STYLE);
const delimStyleJson = JSON.stringify(DELIM_STYLE);
const mdBoldJson = JSON.stringify(MD_BOLD_STYLE);
const mdItalicJson = JSON.stringify(MD_ITALIC_STYLE);
const mdStrikeJson = JSON.stringify(MD_STRIKE_STYLE);

// ============================================================
// Step 1: Replace the match-finder function (n41 / j9$)
//
// Original: finds /\bultrathink\b/gi matches, returns [{word,start,end}]
// Patched:  finds all keywords + inline code spans + markdown formatting,
//           returns [{word,start,end,style}] where style is the entry
//           from KEYWORD_STYLES (or null for ultrathink).
//
//           Priority order (higher clips around lower):
//             1. Keywords — always on top
//             2. Inline `code` — clips around keywords
//             3. Markdown **bold** / *italic* / ~~strike~~ — clips around
//                keywords, skips regions covered by code spans
// ============================================================

const fnPattern = new RegExp(
  'function ([$\\w]+)\\(([$\\w]+)\\)\\{' +
  'let ([$\\w]+)=\\[\\],' +
  '([$\\w]+)=\\2\\.matchAll\\(/\\\\bultrathink\\\\b/gi\\);' +
  'for\\(let ([$\\w]+) of \\4\\)' +
  'if\\(\\5\\.index!==void 0\\)\\3\\.push\\(\\{' +
  'word:\\5\\[0\\],' +
  'start:\\5\\.index,' +
  'end:\\5\\.index\\+\\5\\[0\\]\\.length' +
  '\\}\\);' +
  'return \\3\\}'
);

const fnMatch = content.match(fnPattern);

if (!fnMatch) {
  output.error('Could not find match-finder function pattern', [
    'Expected: function NAME(ARG){let R=[],M=ARG.matchAll(/\\bultrathink\\b/gi);...}',
    'The ultrathink detection structure may have changed',
  ]);
  process.exit(1);
}

const [fnOriginal, fnName, argName, resultVar, matchVar, iterVar] = fnMatch;

output.discovery('match-finder function', fnName + '()', {
  'arg': argName,
  'result var': resultVar,
});

const fnReplacement =
  `function ${fnName}(${argName}){` +
  `var _HS=${hsJson},` +
  `_HP=${hpJson},` +
  `_CS=${codeStyleJson},` +
  `_DS=${delimStyleJson},` +
  `_MB=${mdBoldJson},` +
  `_MI=${mdItalicJson},` +
  `_MS=${mdStrikeJson};` +
  `function _HL(w){var s=_HS[w];if(s)return s;for(var k in _HP)if(w.startsWith(k))return _HP[k];return null}` +
  `let ${resultVar}=[],` +
  `${matchVar}=${argName}.matchAll(/(?<![a-zA-Z0-9])(${wordPattern})(?![a-zA-Z0-9])/gi);` +
  `for(let ${iterVar} of ${matchVar})` +
  `if(${iterVar}.index!==void 0)${resultVar}.push({` +
  `word:${iterVar}[0],` +
  `start:${iterVar}.index,` +
  `end:${iterVar}.index+${iterVar}[0].length,` +
  `style:_HL(${iterVar}[0].toLowerCase())||null` +
  `});` +
  // Inline code span detection — track ranges for markdown overlap exclusion
  `var _cR=[],_cr=/\`([^\`\\n]+)\`/g,_cm;` +
  `while((_cm=_cr.exec(${argName}))!==null){` +
  `var _s=_cm.index,_e=_s+_cm[0].length,_cs=_s+1,_ce=_e-1;` +
  `_cR.push({s:_s,e:_e});` +
  // Always render backtick delimiters (dim)
  `${resultVar}.push({word:"\`",start:_s,end:_s+1,style:_DS});` +
  `${resultVar}.push({word:"\`",start:_e-1,end:_e,style:_DS});` +
  // Collect keyword matches overlapping the content region, sorted by start
  `var _ov=${resultVar}.filter(function(r){return r.start<_ce&&r.end>_cs})` +
  `.sort(function(a,b){return a.start-b.start});` +
  // Fill code-styled segments in the gaps between keywords
  `var _pos=_cs;` +
  `for(var _k=0;_k<_ov.length;_k++){` +
  `if(_ov[_k].start>_pos)${resultVar}.push({word:${argName}.slice(_pos,_ov[_k].start),start:_pos,end:_ov[_k].start,style:_CS});` +
  `_pos=Math.max(_pos,_ov[_k].end)}` +
  `if(_pos<_ce)${resultVar}.push({word:${argName}.slice(_pos,_ce),start:_pos,end:_ce,style:_CS})` +
  `}` +
  // Markdown formatting: **bold**, *italic*, _italic_, ~~strikethrough~~
  // Combined regex with alternation priority: bold > *italic* > _italic_ > strikethrough
  // _italic_ uses alnum boundaries to avoid triggering on snake_case
  // Skips matches that overlap code spans
  `var _mr=/\\*\\*([^*\\n]+)\\*\\*|\\*([^*\\n]+?)\\*|(?<![a-zA-Z0-9])_([^_\\n]+?)_(?![a-zA-Z0-9])|~~([^~\\n]+)~~/g,_mm;` +
  `while((_mm=_mr.exec(${argName}))!==null){` +
  `var _s=_mm.index,_e=_s+_mm[0].length;` +
  // Skip if overlapping any code span
  `if(_cR.some(function(c){return _s<c.e&&_e>c.s}))continue;` +
  // Determine delimiter length and style based on which group matched
  `var _dl,_st;` +
  `if(_mm[1]!==void 0){_dl=2;_st=_MB}` +
  `else if(_mm[2]!==void 0||_mm[3]!==void 0){_dl=1;_st=_MI}` +
  `else{_dl=2;_st=_MS}` +
  `var _cs=_s+_dl,_ce=_e-_dl;` +
  // Delimiter segments (dim)
  `${resultVar}.push({word:${argName}.slice(_s,_cs),start:_s,end:_cs,style:_DS});` +
  `${resultVar}.push({word:${argName}.slice(_ce,_e),start:_ce,end:_e,style:_DS});` +
  // Clip content around keyword overlaps (same logic as code spans)
  `var _ov=${resultVar}.filter(function(r){return r.start<_ce&&r.end>_cs&&r.style!==_DS})` +
  `.sort(function(a,b){return a.start-b.start});` +
  `var _pos=_cs;` +
  `for(var _k=0;_k<_ov.length;_k++){` +
  `if(_ov[_k].start>_pos)${resultVar}.push({word:${argName}.slice(_pos,_ov[_k].start),start:_pos,end:_ov[_k].start,style:_st});` +
  `_pos=Math.max(_pos,_ov[_k].end)}` +
  `if(_pos<_ce)${resultVar}.push({word:${argName}.slice(_pos,_ce),start:_pos,end:_ce,style:_st})` +
  `}` +
  // Sort all matches by start position for the Vyf renderer
  `${resultVar}.sort(function(a,b){return a.start-b.start});` +
  `return ${resultVar}}`;

output.modification('match-finder function', fnOriginal.slice(0, 80) + '...', fnReplacement.slice(0, 80) + '...');

// ============================================================
// Step 2: Replace the input box highlight builder loop
//
// Adds bold/italic/underline/strikethrough to the highlight span
// so the text line renderer (Step 5) can pass them through to <T>.
// ============================================================

const inputPattern = new RegExp(
  'for\\(let ([$\\w]+) of ([$\\w]+)\\)' +
  'for\\(let ([$\\w]+)=\\1\\.start;\\3<\\1\\.end;\\3\\+\\+\\)' +
  '([$\\w]+)\\.push\\(\\{' +
  'start:\\3,' +
  'end:\\3\\+1,' +
  'color:([$\\w]+)\\(\\3-\\1\\.start\\),' +
  'shimmerColor:\\5\\(\\3-\\1\\.start,!0\\),' +
  'priority:10' +
  '\\}\\)'
);

const inputMatch = content.match(inputPattern);

if (!inputMatch) {
  output.error('Could not find input box highlight loop', [
    'Expected: for(let X of G)for(let Y=X.start;Y<X.end;Y++)R.push({...color:PH(Y-X.start),...})',
    'The input highlight builder structure may have changed',
  ]);
  process.exit(1);
}

const [inputOriginal, matchIterVar, matchArrayVar, charIdxVar, pushTarget, colorFn] = inputMatch;

output.discovery('input highlight loop', inputOriginal.slice(0, 60) + '...', {
  'match iter': matchIterVar,
  'match array': matchArrayVar,
  'color fn': colorFn,
});

const inputReplacement =
  `for(let ${matchIterVar} of ${matchArrayVar})` +
  `for(let ${charIdxVar}=${matchIterVar}.start;${charIdxVar}<${matchIterVar}.end;${charIdxVar}++){` +
  `let _s=${matchIterVar}.style,_o=${charIdxVar}-${matchIterVar}.start;` +
  `${pushTarget}.push({start:${charIdxVar},end:${charIdxVar}+1,` +
  `color:_s?_s.colors?_s.colors[_o%_s.colors.length]:_s.color:${colorFn}(_o),` +
  `shimmerColor:_s?_s.shimmer?_s.colors?_s.shimmerColors[_o%_s.shimmerColors.length]:_s.shimmerColor:void 0:${colorFn}(_o,!0),` +
  `bold:_s?.bold,italic:_s?.italic,underline:_s?.underline,strikethrough:_s?.strikethrough,` +
  `priority:10})}`;

output.modification('input highlight loop',
  inputOriginal.slice(0, 60) + '...',
  inputReplacement.slice(0, 60) + '...',
);

// ============================================================
// Step 3: Replace the message history rainbow loop
//
// Adds bold/italic/underline/strikethrough to the per-char <T> elements.
// ============================================================

const historyPattern = new RegExp(
  'for\\(let ([$\\w]+)=([$\\w]+)\\.start;\\1<\\2\\.end;\\1\\+\\+\\)' +
  '([$\\w]+)\\.push\\(([$\\w]+)\\.createElement\\(([$\\w]+),' +
  '\\{key:`rb-\\$\\{\\1\\}`,color:([$\\w]+)\\(\\1-\\2\\.start\\)\\},' +
  '([$\\w]+)\\[\\1\\]\\)\\)'
);

const historyMatch = content.match(historyPattern);

if (!historyMatch) {
  output.error('Could not find message history rainbow loop', [
    'Expected: for(let M=J.start;M<J.end;M++)_.push(R.createElement(T,{key:`rb-${M}`,color:PH(M-J.start)},K[M]))',
    'The message history renderer structure may have changed',
  ]);
  process.exit(1);
}

const [histOriginal, hCharIdx, hMatchObj, hPushArr, hReact, hTextComp, hColorFn, hTextVar] = historyMatch;

output.discovery('message history loop', histOriginal.slice(0, 60) + '...', {
  'React var': hReact,
  'Text component': hTextComp,
  'color fn': hColorFn,
  'text var': hTextVar,
});

const histReplacement =
  `for(let ${hCharIdx}=${hMatchObj}.start;${hCharIdx}<${hMatchObj}.end;${hCharIdx}++){` +
  `let _s=${hMatchObj}.style,_o=${hCharIdx}-${hMatchObj}.start;` +
  `${hPushArr}.push(${hReact}.createElement(${hTextComp},` +
  `{key:\`rb-\${${hCharIdx}}\`,` +
  `color:_s?_s.colors?_s.colors[_o%_s.colors.length]:_s.color:${hColorFn}(_o),` +
  `bold:_s?.bold,italic:_s?.italic,underline:_s?.underline,strikethrough:_s?.strikethrough},` +
  `${hTextVar}[${hCharIdx}]))}`;

output.modification('message history loop',
  histOriginal.slice(0, 60) + '...',
  histReplacement.slice(0, 60) + '...',
);

// ============================================================
// Step 4: Filter notification trigger to ultrathink only
// ============================================================

const notifPattern = new RegExp(
  'if\\(!([$\\w]+)\\.length\\|\\|!([$\\w]+)\\(\\)\\)return;([$\\w]+)\\(\\{key:"ultrathink-active"'
);

const notifMatch = content.match(notifPattern);

if (!notifMatch) {
  output.error('Could not find notification trigger pattern', [
    'Expected: if(!ARR.length||!GATE())return;NOTIFY({key:"ultrathink-active"',
    'The notification trigger structure may have changed',
  ]);
  process.exit(1);
}

const [notifOriginal, notifArrayVar, notifGateVar, notifFnVar] = notifMatch;

output.discovery('notification trigger', notifOriginal.slice(0, 60) + '...', {
  'match array': notifArrayVar,
  'gate fn': notifGateVar,
});

const notifReplacement = `if(!${notifArrayVar}.some(m=>!m.style)||!${notifGateVar}())return;${notifFnVar}({key:"ultrathink-active"`;

output.modification('notification trigger',
  notifOriginal.slice(0, 60) + '...',
  notifReplacement.slice(0, 60) + '...',
);

// ============================================================
// Step 5: Text line renderer — pass bold/italic/underline/strikethrough
//
// The text line renderer has two branches we modify + one we add:
//
// a) Shimmer path: wraps OQ6 chars in <T key={L}>
//    → add bold/italic/underline/strikethrough to the wrapper
//
// b) Color path: <T key={L} color={color}>
//    → add bold/italic/underline/strikethrough props
//
// c) NEW — Effect-only path: no color, but has text effects
//    → catches markdown formatting (bold/italic/strikethrough without color)
//    → renders <T> with effects, wrapping aq component
//
// Pattern (both original branches, contiguous):
//   if(V.highlight?.shimmerColor&&V.highlight.color)return R.createElement(T,{key:L},
//     V.text.split("").map((c,i)=>R.createElement(OQ6,{key:i,char:c,index:V.start+i,
//     glimmerIndex:W,messageColor:V.highlight.color,shimmerColor:V.highlight.shimmerColor})));
//   if(V.highlight?.color)return R.createElement(T,{key:L,color:V.highlight.color},
//     R.createElement(aq,null,V.text))
// ============================================================

const renderPattern = new RegExp(
  'if\\(([$\\w]+)\\.highlight\\?\\.shimmerColor&&\\1\\.highlight\\.color\\)' +
  'return ([$\\w]+)\\.createElement\\(([$\\w]+),\\{key:([$\\w]+)\\},' +
  '\\1\\.text\\.split\\(""\\)\\.map\\(\\(([$\\w]+),([$\\w]+)\\)=>' +
  '\\2\\.createElement\\(([$\\w]+),\\{key:\\6,char:\\5,index:\\1\\.start\\+\\6,' +
  'glimmerIndex:([$\\w]+),messageColor:\\1\\.highlight\\.color,' +
  'shimmerColor:\\1\\.highlight\\.shimmerColor\\}\\)\\)\\);' +
  'if\\(\\1\\.highlight\\?\\.color\\)' +
  'return \\2\\.createElement\\(\\3,\\{key:\\4,color:\\1\\.highlight\\.color\\},' +
  '\\2\\.createElement\\(([$\\w]+),null,\\1\\.text\\)\\)'
);

const renderMatch = content.match(renderPattern);

if (!renderMatch) {
  output.error('Could not find text line renderer pattern', [
    'Expected: if(V.highlight?.shimmerColor&&...)...if(V.highlight?.color)...',
    'The text line renderer structure may have changed',
  ]);
  process.exit(1);
}

const [renderOriginal, rSpanVar, rReactVar, rTextComp2, rKeyVar, rCharVar, rIdxVar, rOQ6Comp, rGlimmerVar, rAqComp] = renderMatch;

output.discovery('text line renderer', renderOriginal.slice(0, 60) + '...', {
  'span var': rSpanVar,
  'React var': rReactVar,
  'OQ6 component': rOQ6Comp,
});

// In the shimmer path, add bold/italic/underline/strikethrough to the outer <T> wrapper.
// In the color path, add bold/italic/underline/strikethrough to the <T> element.
// NEW: effect-only path for markdown formatting (no color, just text decoration).
// Text styles on the outer <T> cascade to inner children in Ink.
const h = rSpanVar;  // shorthand
const renderReplacement =
  // (a) Shimmer path — add all four text effects
  `if(${h}.highlight?.shimmerColor&&${h}.highlight.color)` +
  `return ${rReactVar}.createElement(${rTextComp2},{key:${rKeyVar},` +
  `bold:${h}.highlight.bold,italic:${h}.highlight.italic,underline:${h}.highlight.underline,strikethrough:${h}.highlight.strikethrough},` +
  `${h}.text.split("").map((${rCharVar},${rIdxVar})=>` +
  `${rReactVar}.createElement(${rOQ6Comp},{key:${rIdxVar},char:${rCharVar},index:${h}.start+${rIdxVar},` +
  `glimmerIndex:${rGlimmerVar},messageColor:${h}.highlight.color,` +
  `shimmerColor:${h}.highlight.shimmerColor})));` +
  // (b) Color path — add all four text effects
  `if(${h}.highlight?.color)` +
  `return ${rReactVar}.createElement(${rTextComp2},{key:${rKeyVar},color:${h}.highlight.color,` +
  `bold:${h}.highlight.bold,italic:${h}.highlight.italic,underline:${h}.highlight.underline,strikethrough:${h}.highlight.strikethrough},` +
  `${rReactVar}.createElement(${rAqComp},null,${h}.text));` +
  // (c) Effect-only path — markdown formatting with no color
  `if(${h}.highlight&&(${h}.highlight.bold||${h}.highlight.italic||${h}.highlight.underline||${h}.highlight.strikethrough))` +
  `return ${rReactVar}.createElement(${rTextComp2},{key:${rKeyVar},` +
  `bold:${h}.highlight.bold,italic:${h}.highlight.italic,underline:${h}.highlight.underline,strikethrough:${h}.highlight.strikethrough},` +
  `${rReactVar}.createElement(${rAqComp},null,${h}.text))`;

output.modification('text line renderer',
  renderOriginal.slice(0, 60) + '...',
  renderReplacement.slice(0, 60) + '...',
);

// ============================================================
// Apply
// ============================================================

const totalSteps = 5;

if (dryRun) {
  output.result('dry_run', `Keyword highlights patch ready (${totalSteps} changes, ${customWords.length} custom keywords, ${allPatterns.length} patterns, markdown formatting)`);
  process.exit(0);
}

let patched = content;
patched = patched.replace(fnMatch[0], () => fnReplacement);
patched = patched.replace(inputMatch[0], () => inputReplacement);
patched = patched.replace(historyMatch[0], () => histReplacement);
patched = patched.replace(notifMatch[0], () => notifReplacement);
patched = patched.replace(renderMatch[0], () => renderReplacement);

if (patched === content) {
  output.error('Patches had no effect');
  process.exit(1);
}

try {
  fs.writeFileSync(targetPath, patched);
  output.result('success', `Patched keyword highlights in ${targetPath} (${totalSteps} changes, ${customWords.length} custom keywords, markdown formatting)`);
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

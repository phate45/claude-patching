#!/usr/bin/env node
/**
 * Patch to render fenced code blocks in user messages with hljs syntax
 * highlighting — the same treatment assistant messages get.
 *
 * Without this patch, user messages render as plain text. Code blocks
 * (```lang ... ```) appear as raw text with backticks visible.
 *
 * Touch points:
 *   1. Discover hljs cacher function — the lazy-init getter that returns
 *      a promise resolving to {highlight, supportsLanguage}
 *   2. Discover the ANSI text component (f9) — the React.memo wrapper
 *      that parses ANSI escape sequences into styled Ink elements
 *   3. Patch the user message wrapper (pxf/Vhf) — replace the single Vyf
 *      call with code-block-aware rendering that splits text on fenced
 *      blocks, renders code via hljs → f9, and delegates the rest to Vyf
 *
 * This patch is INDEPENDENT of keyword-highlights. It targets the wrapper
 * (caller of Vyf) while keyword-highlights targets Vyf internals.
 *
 * 2.1.78 change: hljs is no longer stored in module-scope variables via
 * .then() callbacks. Instead, an async function returns the hljs object
 * and a cacher function (lazy ??= init) wraps it. Consumers use React
 * use() to resolve the promise. Our injected code uses globalThis.__hljs
 * with lazy init via the cacher — avoids hooks, degrades gracefully on
 * first render before hljs loads.
 *
 * 2.1.80 change: The wrapper function gained a new `K=REACT.useContext()`
 * variable for messageActions background. The backgroundColor prop is now
 * a three-way ternary: K?"messageActionsBackground":_?void 0:"userMessageBackground"
 * The regex and replacement account for both patterns.
 *
 * 2.1.81 fix: The minifier chose `p` for the Box component variable.
 * Our injected code used `p` as a callback parameter in .map(function(p,i){})
 * and as a local in the IIFE, shadowing the Box component. When rendering
 * code blocks, CE(p,...) created elements with the part object instead of
 * Box → React crash. All injected locals now use _-prefixed names to avoid
 * collisions with any single-letter minified variable.
 *
 * 2.1.109 change: The hljs cacher was rewritten from
 *   function X(){return Y??=Z(),Y}
 * to
 *   function X(){return Y??=Promise.resolve(obj),Y}
 * hljs is now a plain object wrapped in Promise.resolve instead of loaded via
 * async function. The cacher's signature (lazy ??= + return) is unchanged, so
 * our `.then()` access still works. Loosened the regex to accept any expression
 * in the ??= slot, not just a bare function call.
 *
 * Usage:
 *   node patch-code-blocks.js <cli.js path>
 *   node patch-code-blocks.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-code-blocks.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// ============================================================
// Step 1: Discover hljs cacher function
//
// In 2.1.78+, hljs is loaded asynchronously and accessed via a
// lazy-init cacher: function X(){return Y??=Z(),Y}
// where Z is an async function returning {highlight:..., supportsLanguage:...}.
//
// There's exactly one function in the codebase matching the ??= cacher
// shape. We verify it's the hljs one by checking that the nearby context
// contains "highlight" and "supportsLanguage".
//
// Fallback: for ≤2.1.77, the old pattern (VAR=H.highlight,VAR=H.supportsLanguage)
// is checked. This makes the patch work across version boundaries.
// ============================================================

let hljsMode; // 'cacher' (2.1.78+) or 'legacy' (≤2.1.77)
let cacherFn; // name of the cacher function (2.1.78+)
let hljsHighlight, hljsSupports; // variable names (≤2.1.77 legacy)

// Try 2.1.78+ cacher pattern first.
// 2.1.78–2.1.107: `return cacheVar ??= asyncFn(), cacheVar`
// 2.1.109+:       `return cacheVar ??= Promise.resolve(obj), cacheVar`
// We accept any non-comma expression in the ??= slot — the surrounding
// context check (highlight + supportsLanguage) disambiguates.
const cacherPattern = /function ([$\w]+)\(\)\{return ([$\w]+)\?\?=([^,{}]+),\2\}/g;

let cacherMatch = null;
for (const m of content.matchAll(cacherPattern)) {
  const idx = m.index;
  // 2.1.109: supportsLanguage landed ~800 chars after the cacher in minified,
  // past the async loader closure. Widen the window to both sides.
  const context = content.slice(Math.max(0, idx - 1500), idx + m[0].length + 1500);
  if (context.includes('highlight') && context.includes('supportsLanguage')) {
    cacherMatch = m;
    break;
  }
}

if (cacherMatch) {
  cacherFn = cacherMatch[1];
  hljsMode = 'cacher';
  output.discovery('hljs cacher function', cacherFn, {
    'cache var': cacherMatch[2],
    'resolver expr': cacherMatch[3],
  });
}

// Fallback: try legacy pattern (≤2.1.77)
if (!hljsMode) {
  const legacyPattern = /([$\w]+)=([$\w]+)\.highlight,([$\w]+)=\2\.supportsLanguage/;
  const legacyMatch = content.match(legacyPattern);
  if (legacyMatch) {
    hljsHighlight = legacyMatch[1];
    hljsSupports = legacyMatch[3];
    hljsMode = 'legacy';
    output.discovery('hljs variables (legacy)', `highlight=${hljsHighlight}, supportsLanguage=${hljsSupports}`);
  }
}

if (!hljsMode) {
  output.error('Could not find hljs assignment pattern', [
    'Expected (2.1.78+): function X(){return Y??=Z(),Y} near highlight/supportsLanguage',
    'Expected (legacy): VAR1 = H.highlight, VAR2 = H.supportsLanguage',
    'The hljs import structure may have changed',
  ]);
  process.exit(1);
}

// ============================================================
// Step 2: Discover the ANSI text component (f9)
//
// The ANSI text component is a React.memo wrapper that:
//   - Takes {children, dimColor} props
//   - Checks typeof children !== "string"
//   - Uses a memo cache of size 12
//
// Pattern: VAR = REACT[.default].memo(function(P){ let C = HOOK(12), {children:X, dimColor:Y} = P; ...
// The ".default" is present in native builds, absent in bare.
// The memo cache hook varies: REACT.c(12) in native, standalone e(12) in bare.
// ============================================================

const ansiCompPattern = new RegExp(
  '([$\\w]+)=([$\\w]+)(?:\\.default)?\\.memo\\(function\\(([$\\w]+)\\)\\{' +
  'let ([$\\w]+)=[$\\w]+(?:\\.[$\\w]+)?\\(12\\),' +
  '\\{children:([$\\w]+),dimColor:([$\\w]+)\\}=\\3;'
);

const ansiCompMatch = content.match(ansiCompPattern);

if (!ansiCompMatch) {
  output.error('Could not find ANSI text component pattern', [
    'Expected: VAR = REACT[.default].memo(function(P){ let C = HOOK(12), {children:X, dimColor:Y} = P; ...',
    'The ANSI text component structure may have changed',
  ]);
  process.exit(1);
}

const [, ansiComp] = ansiCompMatch;

output.discovery('ANSI text component', ansiComp);

// ============================================================
// Step 3: Patch the user message wrapper (pxf/Vhf)
//
// Original: The wrapper returns a Box containing a single Vyf call.
// Patched:  Splits text on fenced code blocks (```...```),
//           renders code blocks via hljs → f9, and renders
//           text segments via Vyf.
//
// 2.1.80+: The wrapper gained a useContext() call before the guard,
// and backgroundColor is a three-way ternary:
//   K?"messageActionsBackground":_?void 0:"userMessageBackground"
//
// Pre-2.1.80: backgroundColor was a two-way ternary:
//   _?void 0:"userMessageBackground"
//
// The function is identified by its unique error string.
// ============================================================

// 2.1.80+ pattern with useContext and three-way backgroundColor
const hyfPatternNew = new RegExp(
  // Group 1: actions var, 2: React var, 3: context obj
  '([$\\w]+)=([$\\w]+)\\.useContext\\(([$\\w]+)\\);' +
  // Group 4: guard var, 5: error fn
  'if\\(!([$\\w]+)\\)return ([$\\w]+)\\(Error\\("No content found in user prompt message"\\)\\),null;' +
  // return REACT.default.createElement(BOX, {flexDirection:"column",
  'return \\2\\.default\\.createElement\\(([$\\w]+),\\{' +  // Group 6: Box comp
  'flexDirection:"column",' +
  // Group 7: margin var
  'marginTop:([$\\w]+)\\?1:0,' +
  // backgroundColor:ACTIONS?"messageActionsBackground":BRIEF?void 0:"userMessageBackground"
  'backgroundColor:\\1\\?"messageActionsBackground":([$\\w]+)\\?void 0:"userMessageBackground",' +  // Group 8: brief var
  'paddingRight:\\8\\?0:1' +
  // },REACT.default.createElement(VYF,{text:TEXT,useBriefLayout:BRIEF,timestamp:BRIEF?TS:void 0}))
  '\\},\\2\\.default\\.createElement\\(([$\\w]+),\\{' +  // Group 9: Vyf comp
  'text:([$\\w]+),' +  // Group 10: text prop var
  'useBriefLayout:\\8,' +
  'timestamp:\\8\\?([$\\w]+):void 0' +  // Group 11: timestamp var
  '\\}\\)\\)\\}'
);

// Pre-2.1.80 pattern with two-way backgroundColor
const hyfPatternOld = new RegExp(
  'if\\(!([$\\w]+)\\)return ([$\\w]+)\\(Error\\("No content found in user prompt message"\\)\\),null;' +
  'return ([$\\w]+)\\.default\\.createElement\\(([$\\w]+),\\{' +
  'flexDirection:"column",' +
  'marginTop:([$\\w]+)\\?1:0,' +
  'backgroundColor:([$\\w]+)\\?void 0:"userMessageBackground",' +
  'paddingRight:\\6\\?0:1' +
  '\\},\\3\\.default\\.createElement\\(([$\\w]+),\\{' +
  'text:([$\\w]+),' +
  'useBriefLayout:\\6,' +
  'timestamp:\\6\\?([$\\w]+):void 0' +
  '\\}\\)\\)\\}'
);

let hyfMatch = content.match(hyfPatternNew);
let hyfMode = 'new';

if (!hyfMatch) {
  hyfMatch = content.match(hyfPatternOld);
  hyfMode = 'old';
}

if (!hyfMatch) {
  output.error('Could not find user message wrapper return pattern', [
    'Expected: if(!GUARD)return...;return REACT.createElement(m,{flexDirection:"column",...},REACT.createElement(Vyf,{text:TEXT,...}))',
    'The user message wrapper structure may have changed',
  ]);
  process.exit(1);
}

let reactVar, boxComp, marginVar, briefVar, vyfComp, memoTextVar, tsVar, errorFn, guardVar, actionsVar;

if (hyfMode === 'new') {
  [, actionsVar, reactVar, , guardVar, errorFn, boxComp, marginVar, briefVar, vyfComp, memoTextVar, tsVar] = hyfMatch;
} else {
  [, guardVar, errorFn, reactVar, boxComp, marginVar, briefVar, vyfComp, memoTextVar, tsVar] = hyfMatch;
  actionsVar = null;
}

output.discovery('user message wrapper return', hyfMatch[0].slice(0, 80) + '...', {
  'mode': hyfMode,
  'guard var': guardVar,
  'text prop var': memoTextVar,
  'React var': reactVar,
  'Box component': boxComp,
  'Vyf component': vyfComp,
  'brief var': briefVar,
  'error fn': errorFn,
  'actions var': actionsVar || '(none — pre-2.1.80)',
  'hljs mode': hljsMode,
});

// Build the replacement. The strategy:
// 1. Define a helper _SCB (split code blocks) inline
// 2. Split user text on fenced code blocks
// 3. If no code blocks: render normally (single Vyf — unchanged behavior)
// 4. If code blocks found: render array of elements:
//    - Text segments → Vyf (first one gets timestamp, all get brief layout)
//    - Code blocks → hljs highlight → f9 ANSI component
//
// hljs access differs by mode:
// - cacher (2.1.78+): globalThis.__hljs populated lazily via cacher().then()
// - legacy (≤2.1.77): module-scope variables directly

const G = guardVar;     // the guard variable (raw text, for null check)
const T = memoTextVar;  // the text prop variable (may be memo'd/truncated)
const CE = `${reactVar}.default.createElement`;  // shorthand for readability

// Build hljs initialization and access code based on mode
let hljsInit, hljsAccess, hljsHighlightCall, hljsSupportsCall;

if (hljsMode === 'cacher') {
  // 2.1.78+: Use globalThis.__hljs with lazy cacher init
  hljsInit =
    `if(!globalThis.__hljs){try{${cacherFn}().then(function(r){globalThis.__hljs=r})}catch{}}`;
  hljsAccess = 'var _hljs=globalThis.__hljs;';
  hljsHighlightCall = '_hljs.highlight';
  hljsSupportsCall = '_hljs.supportsLanguage';
} else {
  // Legacy: direct module-scope variables
  hljsInit = '';
  hljsAccess = '';
  hljsHighlightCall = hljsHighlight;
  hljsSupportsCall = hljsSupports;
}

const hljsGuard = hljsMode === 'cacher' ? '_hljs' : hljsHighlight;

// Build backgroundColor prop based on mode
const bgProp = actionsVar
  ? `backgroundColor:${actionsVar}?"messageActionsBackground":${briefVar}?void 0:"userMessageBackground"`
  : `backgroundColor:${briefVar}?void 0:"userMessageBackground"`;

const hyfReplacement =
  // useContext call (2.1.80+ only — must precede the guard)
  // This MUST come first: the regex match starts at the useContext assignment,
  // and whatever precedes it in the source is an expression context (e.g. ],[$]),)
  // where an `if` statement would be a syntax error.
  (actionsVar ? `${actionsVar}=${reactVar}.useContext(${hyfMatch[3]});` : '') +
  // Trigger lazy hljs load (cacher mode only) — safe here, we're in statement context
  hljsInit +
  `if(!${G})return ${errorFn}(Error("No content found in user prompt message")),null;` +
  // Split code blocks helper (inline IIFE to avoid polluting scope)
  `var _parts=(function(_t){` +
  hljsAccess +
  `var _re=/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,_a=[],_l=0,_m;` +
  `while((_m=_re.exec(_t))!==null){` +
  `if(_m.index>_l)_a.push({t:"x",c:_t.slice(_l,_m.index)});` +
  `_a.push({t:"c",c:_m[2],g:_m[1]||""});` +
  `_l=_m.index+_m[0].length` +
  `}` +
  `if(_l<_t.length)_a.push({t:"x",c:_t.slice(_l)});` +
  `if(_a.length===0)_a.push({t:"x",c:_t});` +
  `return _a` +
  `})(${T});` +
  // Check if we have any code blocks
  `var _hasCode=_parts.some(function(_e){return _e.t==="c"});` +
  // Render children
  `var _ch;` +
  `if(!_hasCode){` +
  // No code blocks — unchanged behavior
  `_ch=${CE}(${vyfComp},{text:${T},useBriefLayout:${briefVar},timestamp:${briefVar}?${tsVar}:void 0})` +
  `}else{` +
  // Has code blocks — render mixed
  (hljsMode === 'cacher' ? `${hljsAccess}` : '') +
  `var _first=!0;` +
  `_ch=_parts.map(function(_e,_i){` +
  `if(_e.t==="x"){` +
  // Text segment: first one gets Vyf (with pointer/timestamp), rest get Vyf without timestamp
  `if(_first){_first=!1;return ${CE}(${vyfComp},{key:"t"+_i,text:_e.c,useBriefLayout:${briefVar},` +
  `timestamp:${briefVar}?${tsVar}:void 0})}` +
  `return ${CE}(${vyfComp},{key:"t"+_i,text:_e.c,useBriefLayout:${briefVar}})` +
  `}else{` +
  // Code block: dim fences + hljs → f9 (auto-detection when no language tag)
  `var _opts={};` +
  `if(_e.g&&${hljsGuard}&&${hljsSupportsCall}(_e.g))_opts={language:_e.g};` +
  `var _hl=${hljsGuard}?${hljsHighlightCall}(_e.c,_opts):_e.c;` +
  `var _fence="\`\`\`"+(_e.g||"");` +
  `return ${CE}(${boxComp},{key:"c"+_i,flexDirection:"column",paddingLeft:2},` +
  `${CE}(${ansiComp},{dimColor:!0},_fence),` +
  `${CE}(${ansiComp},null,_hl),` +
  `${CE}(${ansiComp},{dimColor:!0},"\`\`\`"))` +
  `}` +
  `})` +
  `}` +
  // Return the container
  `return ${CE}(${boxComp},{` +
  `flexDirection:"column",` +
  `marginTop:${marginVar}?1:0,` +
  `${bgProp},` +
  `paddingRight:${briefVar}?0:1` +
  `},_ch)}`;

output.modification('user message wrapper',
  hyfMatch[0].slice(0, 80) + '...',
  hyfReplacement.slice(0, 80) + '...',
);

// ============================================================
// Apply
// ============================================================

const totalSteps = 3;

if (dryRun) {
  output.result('dry_run', `Code blocks patch ready (${totalSteps} steps: hljs discovery [${hljsMode}], f9 discovery, wrapper replacement [${hyfMode}])`);
  process.exit(0);
}

let patched = content;
patched = patched.replace(hyfMatch[0], () => hyfReplacement);

if (patched === content) {
  output.error('Patch had no effect');
  process.exit(1);
}

try {
  fs.writeFileSync(targetPath, patched);
  output.result('success', `Patched code blocks in ${targetPath} (${totalSteps} steps, hljs mode: ${hljsMode}, wrapper mode: ${hyfMode})`);
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

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
 *   3. Patch the user message wrapper (Vhf) — replace the single Vyf
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

// Try 2.1.78+ cacher pattern first
const cacherPattern = /function ([$\w]+)\(\)\{return ([$\w]+)\?\?=([$\w]+)\(\),\2\}/;
const cacherMatch = content.match(cacherPattern);

if (cacherMatch) {
  // Verify it's the hljs cacher by checking surrounding context
  const idx = cacherMatch.index;
  const context = content.slice(Math.max(0, idx - 300), idx + cacherMatch[0].length + 100);
  if (context.includes('highlight') && context.includes('supportsLanguage')) {
    cacherFn = cacherMatch[1];
    hljsMode = 'cacher';
    output.discovery('hljs cacher function', cacherFn, {
      'cache var': cacherMatch[2],
      'async fn': cacherMatch[3],
    });
  }
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
// Step 3: Patch the user message wrapper (Vhf)
//
// Original: Vhf returns a Box containing a single Vyf call.
// Patched:  Vhf splits text on fenced code blocks (```...```),
//           renders code blocks via hljs → f9, and renders
//           text segments via Vyf.
//
// Pattern matches the return statement of Vhf:
//   return REACT.default.createElement(m, {flexDirection:"column",...},
//     REACT.default.createElement(Vyf, {text:TEXTPROP, useBriefLayout:_,...}))
//
// The function is identified by its unique error string.
// ============================================================

const hyfPattern = new RegExp(
  // Match from the if(!TEXT) guard through the return and closing }
  // Group 1: guard var, 2: error fn, 3: React var, 4: Box comp,
  // 5: margin var, 6: brief var, 7: Vyf comp, 8: text prop var, 9: timestamp var
  'if\\(!([$\\w]+)\\)return ([$\\w]+)\\(Error\\("No content found in user prompt message"\\)\\),null;' +
  'return ([$\\w]+)\\.default\\.createElement\\(([$\\w]+),\\{' +
  'flexDirection:"column",' +
  'marginTop:([$\\w]+)\\?1:0,' +
  'backgroundColor:([$\\w]+)\\?void 0:"userMessageBackground",' +
  'paddingRight:\\6\\?0:1' +
  '\\},\\3\\.default\\.createElement\\(([$\\w]+),\\{' +
  'text:([$\\w]+),' +          // independent capture, not backreference
  'useBriefLayout:\\6,' +
  'timestamp:\\6\\?([$\\w]+):void 0' +
  '\\}\\)\\)\\}'
);

const hyfMatch = content.match(hyfPattern);

if (!hyfMatch) {
  output.error('Could not find user message wrapper return pattern', [
    'Expected: if(!GUARD)return...;return REACT.createElement(m,{flexDirection:"column",...},REACT.createElement(Vyf,{text:TEXT,...}))',
    'The user message wrapper structure may have changed',
  ]);
  process.exit(1);
}

const [hyfOriginal, guardVar, errorFn, reactVar, boxComp, marginVar, briefVar, vyfComp, memoTextVar, tsVar] = hyfMatch;

output.discovery('user message wrapper return', hyfOriginal.slice(0, 80) + '...', {
  'guard var': guardVar,
  'text prop var': memoTextVar,
  'same variable': guardVar === memoTextVar ? 'yes (pre-2.1.77)' : `no (guard=${guardVar}, text=${memoTextVar})`,
  'React var': reactVar,
  'Box component': boxComp,
  'Vyf component': vyfComp,
  'brief var': briefVar,
  'error fn': errorFn,
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

const hyfReplacement =
  // Trigger lazy hljs load (cacher mode only)
  hljsInit +
  `if(!${G})return ${errorFn}(Error("No content found in user prompt message")),null;` +
  // Split code blocks helper (inline IIFE to avoid polluting scope)
  `var _parts=(function(t){` +
  hljsAccess +
  `var re=/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,p=[],l=0,m;` +
  `while((m=re.exec(t))!==null){` +
  `if(m.index>l)p.push({t:"x",c:t.slice(l,m.index)});` +
  `p.push({t:"c",c:m[2],g:m[1]||""});` +
  `l=m.index+m[0].length` +
  `}` +
  `if(l<t.length)p.push({t:"x",c:t.slice(l)});` +
  `if(p.length===0)p.push({t:"x",c:t});` +
  `return p` +
  `})(${T});` +
  // Check if we have any code blocks
  `var _hasCode=_parts.some(function(p){return p.t==="c"});` +
  // Render children
  `var _ch;` +
  `if(!_hasCode){` +
  // No code blocks — unchanged behavior
  `_ch=${CE}(${vyfComp},{text:${T},useBriefLayout:${briefVar},timestamp:${briefVar}?${tsVar}:void 0})` +
  `}else{` +
  // Has code blocks — render mixed
  (hljsMode === 'cacher' ? `${hljsAccess}` : '') +
  `var _first=!0;` +
  `_ch=_parts.map(function(p,i){` +
  `if(p.t==="x"){` +
  // Text segment: first one gets Vyf (with pointer/timestamp), rest get Vyf without timestamp
  `if(_first){_first=!1;return ${CE}(${vyfComp},{key:"t"+i,text:p.c,useBriefLayout:${briefVar},` +
  `timestamp:${briefVar}?${tsVar}:void 0})}` +
  `return ${CE}(${vyfComp},{key:"t"+i,text:p.c,useBriefLayout:${briefVar}})` +
  `}else{` +
  // Code block: dim fences + hljs → f9 (auto-detection when no language tag)
  `var _opts={};` +
  `if(p.g&&${hljsGuard}&&${hljsSupportsCall}(p.g))_opts={language:p.g};` +
  `var _hl=${hljsGuard}?${hljsHighlightCall}(p.c,_opts):p.c;` +
  `var _fence="\`\`\`"+(p.g||"");` +
  `return ${CE}(${boxComp},{key:"c"+i,flexDirection:"column",paddingLeft:2},` +
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
  `backgroundColor:${briefVar}?void 0:"userMessageBackground",` +
  `paddingRight:${briefVar}?0:1` +
  `},_ch)}`;

output.modification('user message wrapper',
  hyfOriginal.slice(0, 80) + '...',
  hyfReplacement.slice(0, 80) + '...',
);

// ============================================================
// Apply
// ============================================================

const totalSteps = 3;

if (dryRun) {
  output.result('dry_run', `Code blocks patch ready (${totalSteps} steps: hljs discovery [${hljsMode}], f9 discovery, wrapper replacement)`);
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
  output.result('success', `Patched code blocks in ${targetPath} (${totalSteps} steps, hljs mode: ${hljsMode})`);
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

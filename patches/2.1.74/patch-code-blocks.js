#!/usr/bin/env node
/**
 * Patch to render fenced code blocks in user messages with hljs syntax
 * highlighting — the same treatment assistant messages get.
 *
 * Without this patch, user messages render as plain text. Code blocks
 * (```lang ... ```) appear as raw text with backticks visible.
 *
 * Touch points:
 *   1. Discover hljs variables — find the highlight + supportsLanguage
 *      assignment from the async hljs import
 *   2. Discover the ANSI text component (f9) — the React.memo wrapper
 *      that parses ANSI escape sequences into styled Ink elements
 *   3. Patch the user message wrapper (hyf) — replace the single Vyf
 *      call with code-block-aware rendering that splits text on fenced
 *      blocks, renders code via hljs → f9, and delegates the rest to Vyf
 *
 * This patch is INDEPENDENT of keyword-highlights. It targets hyf (the
 * caller of Vyf) while keyword-highlights targets Vyf internals.
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
// Step 1: Discover hljs highlight wrapper (VX4)
//
// Pattern: VAR1 = PARAM.highlight, VAR2 = PARAM.supportsLanguage
// inside a .then() callback from the async hljs import.
// There may be multiple sites — we take the first.
//
// VX4 (= VAR1) is already a wrapper that:
//   - With {language: "x"}: calls raw hljs.highlight(code, {language}).value
//   - With {} (no language):  calls raw hljs.highlightAuto(code).value
//   - Then pipes through Io9() (HTML→ANSI converter)
// So calling VAR1(code, {}) gives auto-detection for free.
// ============================================================

const hljsPattern = new RegExp(
  '([$\\w]+)=([$\\w]+)\\.highlight,([$\\w]+)=\\2\\.supportsLanguage'
);

const hljsMatch = content.match(hljsPattern);

if (!hljsMatch) {
  output.error('Could not find hljs assignment pattern', [
    'Expected: VAR1 = H.highlight, VAR2 = H.supportsLanguage',
    'The hljs async import structure may have changed',
  ]);
  process.exit(1);
}

const [, hljsHighlight, , hljsSupports] = hljsMatch;

output.discovery('hljs variables', `highlight=${hljsHighlight}, supportsLanguage=${hljsSupports}`);

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
// Step 3: Patch the user message wrapper (hyf)
//
// Original: hyf returns a Box containing a single Vyf call.
// Patched:  hyf splits text on fenced code blocks (```...```),
//           renders code blocks via hljs → f9, and renders
//           text segments via Vyf.
//
// Pattern matches the return statement of hyf:
//   return REACT.default.createElement(m, {flexDirection:"column",...},
//     REACT.default.createElement(Vyf, {text:$, useBriefLayout:_,...}))
//
// The function is identified by its unique parameter destructuring:
//   {addMargin:H, param:{text:$}, isTranscriptMode:A, timestamp:L}
// ============================================================

const hyfPattern = new RegExp(
  // Match from the if(!TEXT) guard through the return and closing }
  // Group 1: text var, 2: error fn, 3: React var, 4: Box comp,
  // 5: margin var, 6: brief var, 7: Vyf comp, 8: timestamp var
  'if\\(!([$\\w]+)\\)return ([$\\w]+)\\(Error\\("No content found in user prompt message"\\)\\),null;' +
  'return ([$\\w]+)\\.default\\.createElement\\(([$\\w]+),\\{' +
  'flexDirection:"column",' +
  'marginTop:([$\\w]+)\\?1:0,' +
  'backgroundColor:([$\\w]+)\\?void 0:"userMessageBackground",' +
  'paddingRight:\\6\\?0:1' +
  '\\},\\3\\.default\\.createElement\\(([$\\w]+),\\{' +
  'text:\\1,' +
  'useBriefLayout:\\6,' +
  'timestamp:\\6\\?([$\\w]+):void 0' +
  '\\}\\)\\)\\}'
);

const hyfMatch = content.match(hyfPattern);

if (!hyfMatch) {
  output.error('Could not find hyf return pattern', [
    'Expected: if(!TEXT)return...;return REACT.createElement(m,{flexDirection:"column",...},REACT.createElement(Vyf,{text:TEXT,...}))',
    'The user message wrapper structure may have changed',
  ]);
  process.exit(1);
}

const [hyfOriginal, textVar, errorFn, reactVar, boxComp, marginVar, briefVar, vyfComp, tsVar] = hyfMatch;

output.discovery('hyf return', hyfOriginal.slice(0, 80) + '...', {
  'text var': textVar,
  'React var': reactVar,
  'Box component': boxComp,
  'Vyf component': vyfComp,
  'brief var': briefVar,
  'error fn': errorFn,
});

// Build the replacement. The strategy:
// 1. Define a helper _SCB (split code blocks) inline
// 2. Split user text on fenced code blocks
// 3. If no code blocks: render normally (single Vyf — unchanged behavior)
// 4. If code blocks found: render array of elements:
//    - Text segments → Vyf (first one gets timestamp, all get brief layout)
//    - Code blocks → hljs highlight → f9 ANSI component
//
// The helper returns [{type:"text"|"code", content, lang?}]
// Code blocks use hljs when available, fall back to plain text.

const T = textVar;  // shorthand — the user message text variable
const CE = `${reactVar}.default.createElement`;  // shorthand for readability

const hyfReplacement =
  `if(!${T})return ${errorFn}(Error("No content found in user prompt message")),null;` +
  // Split code blocks helper (inline IIFE to avoid polluting scope)
  `var _parts=(function(t){` +
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
  `var _first=!0;` +
  `_ch=_parts.map(function(p,i){` +
  `if(p.t==="x"){` +
  // Text segment: first one gets Vyf (with pointer/timestamp), rest get Vyf without timestamp
  `if(_first){_first=!1;return ${CE}(${vyfComp},{key:"t"+i,text:p.c,useBriefLayout:${briefVar},` +
  `timestamp:${briefVar}?${tsVar}:void 0})}` +
  `return ${CE}(${vyfComp},{key:"t"+i,text:p.c,useBriefLayout:${briefVar}})` +
  `}else{` +
  // Code block: dim fences + hljs → f9 (auto-detection when no language tag)
  // VX4 wrapper handles both: {language:"x"} for explicit, {} for auto-detect
  `var _opts={};` +
  `if(p.g&&${hljsSupports}&&${hljsSupports}(p.g))_opts={language:p.g};` +
  `var _hl=${hljsHighlight}?${hljsHighlight}(p.c,_opts):p.c;` +
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

output.modification('hyf return',
  hyfOriginal.slice(0, 80) + '...',
  hyfReplacement.slice(0, 80) + '...',
);

// ============================================================
// Apply
// ============================================================

const totalSteps = 3;

if (dryRun) {
  output.result('dry_run', `Code blocks patch ready (${totalSteps} steps: hljs discovery, f9 discovery, hyf replacement)`);
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
  output.result('success', `Patched code blocks in ${targetPath} (${totalSteps} steps)`);
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

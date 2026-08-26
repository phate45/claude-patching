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
 *   1. Match finder — expanded regex with prefix/exact/array modes.
 *   2. Input box highlight builder — branches on color/colors for assignment
 *   3. Message history renderer — branches on color/colors for per-char coloring
 *   4. Notification trigger — filter to only fire for ultrathink matches
 *   5. Text line renderer — pass bold/italic/underline/strikethrough from spans
 *
 * 2.1.246 change (steps 3 + 5): the JSX element factory dropped from the member
 * form `RUNTIME.jsx(COMP,{…},key)` to a BARE import-aliased call `o(COMP,{…},key)`
 * — no `.jsx(` substring (2.1.234 render rework + module-split import aliasing).
 * The step-3 rainbow loop is now in `Pi()` (`zy.push(o(t,{color:Vy(…),children:
 * _i[Bf]},`+"`rb-${Bf}`"+`))`) and the step-5 text-line renderer uses a bare `c(…)`.
 * Both patterns now match a bare `FACTORY(` and both replacements emit bare
 * factory calls. Steps 1, 2 (pure JS) and 4 (notification, Form B) are unchanged.
 *
 * Usage:
 *   node patch-keyword-highlights.js <cli.js path>
 *   node patch-keyword-highlights.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

// ============================================================
// CONFIGURATION — keyword → style mapping (Nord-inspired palette)
// ============================================================

const CODE_STYLE = { color: "#7ABED9" };           // soft steel cyan (Nord frost neighbor)
const DELIM_STYLE = { color: "#4C566A" };           // Nord comment gray (subtle)

// Markdown formatting — effect-only styles (no color, just text decoration)
const MD_BOLD_STYLE = { bold: true };
const MD_ITALIC_STYLE = { italic: true };
const MD_STRIKE_STYLE = { strikethrough: true };

const KEYWORD_STYLES = {
  // ═══ POP — shimmer + effects ═══
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

const hsEntries = {};  // direct word → style (O(1) lookup)
const hpEntries = {};  // prefix keyword → style (startsWith fallback)

for (const [word, cfg] of Object.entries(KEYWORD_STYLES)) {
  const style = { ...cfg };
  delete style.match;

  if (Array.isArray(cfg.match)) {
    allPatterns.push(word, ...cfg.match);
    hsEntries[word] = style;
    for (const v of cfg.match) hsEntries[v] = style;
  } else if (cfg.match === 'exact') {
    allPatterns.push(word);
    hsEntries[word] = style;
  } else {
    allPatterns.push(word + '[a-zA-Z0-9]*');
    hpEntries[word] = style;
  }
}

allPatterns.sort((a, b) => b.replace(/\[a-zA-Z0-9\]\*$/, '').length - a.replace(/\[a-zA-Z0-9\]\*$/, '').length);
const wordPattern = allPatterns.join('|');

const hsJson = JSON.stringify(hsEntries);
const hpJson = JSON.stringify(hpEntries);
const codeStyleJson = JSON.stringify(CODE_STYLE);
const delimStyleJson = JSON.stringify(DELIM_STYLE);
const mdBoldJson = JSON.stringify(MD_BOLD_STYLE);
const mdItalicJson = JSON.stringify(MD_ITALIC_STYLE);
const mdStrikeJson = JSON.stringify(MD_STRIKE_STYLE);

// ============================================================
// Step 1: Replace the match-finder function (pure JS — unchanged shape)
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
  `var _cR=[],_cr=/\`([^\`\\n]+)\`/g,_cm;` +
  `while((_cm=_cr.exec(${argName}))!==null){` +
  `var _s=_cm.index,_e=_s+_cm[0].length,_cs=_s+1,_ce=_e-1;` +
  `_cR.push({s:_s,e:_e});` +
  `${resultVar}.push({word:"\`",start:_s,end:_s+1,style:_DS});` +
  `${resultVar}.push({word:"\`",start:_e-1,end:_e,style:_DS});` +
  `var _ov=${resultVar}.filter(function(r){return r.start<_ce&&r.end>_cs})` +
  `.sort(function(a,b){return a.start-b.start});` +
  `var _pos=_cs;` +
  `for(var _k=0;_k<_ov.length;_k++){` +
  `if(_ov[_k].start>_pos)${resultVar}.push({word:${argName}.slice(_pos,_ov[_k].start),start:_pos,end:_ov[_k].start,style:_CS});` +
  `_pos=Math.max(_pos,_ov[_k].end)}` +
  `if(_pos<_ce)${resultVar}.push({word:${argName}.slice(_pos,_ce),start:_pos,end:_ce,style:_CS})` +
  `}` +
  `var _mr=/\\*\\*([^*\\n]+)\\*\\*|\\*([^*\\n]+?)\\*|(?<![a-zA-Z0-9])_([^_\\n]+?)_(?![a-zA-Z0-9])|~~([^~\\n]+)~~/g,_mm;` +
  `while((_mm=_mr.exec(${argName}))!==null){` +
  `var _s=_mm.index,_e=_s+_mm[0].length;` +
  `if(_cR.some(function(c){return _s<c.e&&_e>c.s}))continue;` +
  `var _dl,_st;` +
  `if(_mm[1]!==void 0){_dl=2;_st=_MB}` +
  `else if(_mm[2]!==void 0||_mm[3]!==void 0){_dl=1;_st=_MI}` +
  `else{_dl=2;_st=_MS}` +
  `var _cs=_s+_dl,_ce=_e-_dl;` +
  `${resultVar}.push({word:${argName}.slice(_s,_cs),start:_s,end:_cs,style:_DS});` +
  `${resultVar}.push({word:${argName}.slice(_ce,_e),start:_ce,end:_e,style:_DS});` +
  `var _ov=${resultVar}.filter(function(r){return r.start<_ce&&r.end>_cs&&r.style!==_DS})` +
  `.sort(function(a,b){return a.start-b.start});` +
  `var _pos=_cs;` +
  `for(var _k=0;_k<_ov.length;_k++){` +
  `if(_ov[_k].start>_pos)${resultVar}.push({word:${argName}.slice(_pos,_ov[_k].start),start:_pos,end:_ov[_k].start,style:_st});` +
  `_pos=Math.max(_pos,_ov[_k].end)}` +
  `if(_pos<_ce)${resultVar}.push({word:${argName}.slice(_pos,_ce),start:_pos,end:_ce,style:_st})` +
  `}` +
  `${resultVar}.sort(function(a,b){return a.start-b.start});` +
  `return ${resultVar}}`;

output.modification('match-finder function', fnOriginal.slice(0, 80) + '...', fnReplacement.slice(0, 80) + '...');

// ============================================================
// Step 2: Replace the input box highlight builder loop (pure JS — unchanged)
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
// Step 3: Replace the message history rainbow loop (BARE factory in 2.1.246)
//   for(let Bf=Tm.start;Bf<Tm.end;Bf++)zy.push(o(t,{color:Vy(Bf-Tm.start),children:_i[Bf]},`rb-${Bf}`))
// ============================================================

const historyPattern = new RegExp(
  'for\\(let ([$\\w]+)=([$\\w]+)\\.start;\\1<\\2\\.end;\\1\\+\\+\\)' +
  '([$\\w]+)\\.push\\(([$\\w]+)\\(([$\\w]+),' +               // PUSHARR.push(FACTORY(COMP,
  '\\{color:([$\\w]+)\\(\\1-\\2\\.start\\),children:([$\\w]+)\\[\\1\\]\\}' +
  ',`rb-\\$\\{\\1\\}`\\)\\)'
);

const historyMatch = content.match(historyPattern);

if (!historyMatch) {
  output.error('Could not find message history rainbow loop', [
    'Expected: for(let M=J.start;M<J.end;M++)_.push(o(T,{color:PH(M-J.start),children:K[M]},`rb-${M}`))',
    'The message history renderer structure may have changed',
  ]);
  process.exit(1);
}

const [histOriginal, hCharIdx, hMatchObj, hPushArr, hFactory, hTextComp, hColorFn, hTextVar] = historyMatch;

output.discovery('message history loop', histOriginal.slice(0, 60) + '...', {
  'factory var': hFactory,
  'Text component': hTextComp,
  'color fn': hColorFn,
  'text var': hTextVar,
});

const histReplacement =
  `for(let ${hCharIdx}=${hMatchObj}.start;${hCharIdx}<${hMatchObj}.end;${hCharIdx}++){` +
  `let _s=${hMatchObj}.style,_o=${hCharIdx}-${hMatchObj}.start;` +
  `${hPushArr}.push(${hFactory}(${hTextComp},` +
  `{color:_s?_s.colors?_s.colors[_o%_s.colors.length]:_s.color:${hColorFn}(_o),` +
  `bold:_s?.bold,italic:_s?.italic,underline:_s?.underline,strikethrough:_s?.strikethrough,` +
  `children:${hTextVar}[${hCharIdx}]},` +
  `\`rb-\${${hCharIdx}}\`))}`;

output.modification('message history loop',
  histOriginal.slice(0, 60) + '...',
  histReplacement.slice(0, 60) + '...',
);

// ============================================================
// Step 4: Filter notification trigger to ultrathink only (Form B unchanged)
// ============================================================

const notifPatternA = new RegExp(
  'if\\(!([$\\w]+)\\.length\\|\\|!([$\\w]+)\\(\\)\\)return;([$\\w]+)\\(\\{key:"ultrathink-active"'
);
const notifPatternB = new RegExp(
  'if\\(([$\\w]+)\\.length&&([$\\w]+)\\(\\)\\)([$\\w]+)\\(\\{key:"ultrathink-active"'
);

let notifMatch = content.match(notifPatternA);
let notifForm = 'A';

if (!notifMatch) {
  notifMatch = content.match(notifPatternB);
  notifForm = 'B';
}

if (!notifMatch) {
  output.error('Could not find notification trigger pattern', [
    'Expected form A: if(!ARR.length||!GATE())return;NOTIFY({key:"ultrathink-active"',
    'Expected form B: if(ARR.length&&GATE())NOTIFY({key:"ultrathink-active"',
    'The notification trigger structure may have changed',
  ]);
  process.exit(1);
}

const [notifOriginal, notifArrayVar, notifGateVar, notifFnVar] = notifMatch;

output.discovery('notification trigger', notifOriginal.slice(0, 60) + '...', {
  'match array': notifArrayVar,
  'gate fn': notifGateVar,
  'form': notifForm,
});

let notifReplacement;
if (notifForm === 'A') {
  notifReplacement = `if(!${notifArrayVar}.some(m=>!m.style)||!${notifGateVar}())return;${notifFnVar}({key:"ultrathink-active"`;
} else {
  notifReplacement = `if(${notifArrayVar}.some(m=>!m.style)&&${notifGateVar}())${notifFnVar}({key:"ultrathink-active"`;
}

output.modification('notification trigger',
  notifOriginal.slice(0, 60) + '...',
  notifReplacement.slice(0, 60) + '...',
);

// ============================================================
// Step 5: Text line renderer — pass effects (BARE factory in 2.1.246)
//   if(C.highlight?.shimmerColor&&C.highlight.color){return c(u,{children:
//     C.text.split("").map((Io,kt)=>c(G,{char:Io,index:C.start+kt,glimmerIndex:q,
//     messageColor:C.highlight.color,shimmerColor:C.highlight.shimmerColor},kt))},Pt)}
//   return c(u,{color:C.highlight?.color,dimColor:C.highlight?.dimColor,
//     inverse:C.highlight?.inverse,children:c(AQ,{children:C.text})},Pt)
// ============================================================

const renderPattern = new RegExp(
  'if\\(([$\\w]+)\\.highlight\\?\\.shimmerColor&&\\1\\.highlight\\.color\\)\\{' +
  'return ([$\\w]+)\\(([$\\w]+),\\{children:' +
  '\\1\\.text\\.split\\(""\\)\\.map\\(\\(([$\\w]+),([$\\w]+)\\)=>' +
  '\\2\\(([$\\w]+),\\{char:\\4,index:\\1\\.start\\+\\5,' +
  'glimmerIndex:([$\\w]+),messageColor:\\1\\.highlight\\.color,' +
  'shimmerColor:\\1\\.highlight\\.shimmerColor\\},\\5\\)\\)\\},([$\\w]+)\\)\\}' +
  'return \\2\\(\\3,\\{' +
  'color:\\1\\.highlight\\?\\.color,' +
  'dimColor:\\1\\.highlight\\?\\.dimColor,' +
  'inverse:\\1\\.highlight\\?\\.inverse,' +
  'underline:\\1\\.highlight\\?\\.underline,children:' +   // 2.1.246: native now passes underline here
  '\\2\\(([$\\w]+),\\{children:\\1\\.text\\}\\)\\},\\8\\)'
);

const renderMatch = content.match(renderPattern);

if (!renderMatch) {
  output.error('Could not find text line renderer pattern', [
    'Expected: if(V.highlight?.shimmerColor&&...)...return c(T,{...,children:c(AQ,{children:V.text})},KEY)',
    'The text line renderer structure may have changed',
  ]);
  process.exit(1);
}

const [renderOriginal, rSpanVar, rFactoryVar, rTextComp2, rCharVar, rIdxVar, rOQ6Comp, rGlimmerVar, rKeyVar, rAqComp] = renderMatch;

output.discovery('text line renderer', renderOriginal.slice(0, 60) + '...', {
  'span var': rSpanVar,
  'factory var': rFactoryVar,
  'OQ6 component': rOQ6Comp,
});

const h = rSpanVar;  // shorthand
const renderReplacement =
  // (a) Shimmer path — add all four text effects
  `if(${h}.highlight?.shimmerColor&&${h}.highlight.color)` +
  `return ${rFactoryVar}(${rTextComp2},{` +
  `bold:${h}.highlight.bold,italic:${h}.highlight.italic,underline:${h}.highlight.underline,strikethrough:${h}.highlight.strikethrough,` +
  `children:${h}.text.split("").map((${rCharVar},${rIdxVar})=>` +
  `${rFactoryVar}(${rOQ6Comp},{char:${rCharVar},index:${h}.start+${rIdxVar},` +
  `glimmerIndex:${rGlimmerVar},messageColor:${h}.highlight.color,` +
  `shimmerColor:${h}.highlight.shimmerColor},${rIdxVar}))},${rKeyVar});` +
  // (b) Color path — add all four text effects, keep dimColor/inverse
  `if(${h}.highlight?.color)` +
  `return ${rFactoryVar}(${rTextComp2},{color:${h}.highlight.color,` +
  `dimColor:${h}.highlight?.dimColor,inverse:${h}.highlight?.inverse,` +
  `bold:${h}.highlight.bold,italic:${h}.highlight.italic,underline:${h}.highlight.underline,strikethrough:${h}.highlight.strikethrough,` +
  `children:${rFactoryVar}(${rAqComp},{children:${h}.text})},${rKeyVar});` +
  // (c) Effect-only path — markdown formatting with no color
  `if(${h}.highlight&&(${h}.highlight.bold||${h}.highlight.italic||${h}.highlight.underline||${h}.highlight.strikethrough))` +
  `return ${rFactoryVar}(${rTextComp2},{` +
  `bold:${h}.highlight.bold,italic:${h}.highlight.italic,underline:${h}.highlight.underline,strikethrough:${h}.highlight.strikethrough,` +
  `children:${rFactoryVar}(${rAqComp},{children:${h}.text})},${rKeyVar});` +
  // (d) Default — preserve original dimColor/inverse behavior
  `return ${rFactoryVar}(${rTextComp2},{` +
  `color:${h}.highlight?.color,dimColor:${h}.highlight?.dimColor,inverse:${h}.highlight?.inverse,` +
  `children:${rFactoryVar}(${rAqComp},{children:${h}.text})},${rKeyVar})`;

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

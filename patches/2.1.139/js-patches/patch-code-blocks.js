#!/usr/bin/env node
/**
 * Patch to render fenced code blocks in user messages with hljs syntax
 * highlighting — the same treatment assistant messages get.
 *
 * 2.1.139 change: the user-message wrapper (`RI7`) was reshaped by the React
 * Compiler. The old inline chain
 *
 *   return REACT.createElement(box, { flexDirection:..., marginTop:..., ... },
 *     REACT.createElement(vyf, { text, useBriefLayout, timestamp }))
 *
 * is now fragmented into three memo-cache slot blocks: one builds the prop
 * scalars (`J/L/P/Z`), the next memoizes the `vyf` element into `W` via
 * `$[15..18]`, and the third memoizes the box element into `G` via
 * `$[19..23]`. The function returns `G`.
 *
 * Since `RI7` has a single caller that treats it as `createElement(RI7, ...)`,
 * the external contract is just "return a React element or null". The memo
 * cache is internal optimization with no consumers outside RI7. We bypass it
 * by replacing everything from the guard line through `return G}` with a
 * fresh inline render path, keeping the function signature and behavior.
 *
 * When the text is so long it gets summarized into a `{head, hiddenLines,
 * tail}` object (via the `_B_` threshold), code-block splitting doesn't
 * apply — we fall through to the original `vyf` render for that case.
 *
 * hljs and ANSI-component discovery are unchanged from 2.1.123 — the
 * `syntaxHighlightingDisabled?null:GETTER()` anchor and the
 * `memo(function(P){let C=HOOK(12),{children:X,dimColor:Y}=P;` ANSI pattern
 * both still match in 2.1.139.
 *
 * Usage:
 *   node patch-code-blocks.js <cli.js path>
 *   node patch-code-blocks.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

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
// Step 1: Discover hljs accessor (unchanged from 2.1.123)
// ============================================================

let hljsMode;
let syncGetter;
let cacherFn;
let hljsHighlight, hljsSupports;

const syncAnchorPattern = /syntaxHighlightingDisabled\?null:([$\w]+)\(\)/;
const syncAnchorMatch = content.match(syncAnchorPattern);
if (syncAnchorMatch) {
  const candidateFn = syncAnchorMatch[1];
  const getterDecl = new RegExp(`function ${candidateFn}\\(\\)\\{return ([$\\w]+)\\}`);
  const getterMatch = content.match(getterDecl);
  if (getterMatch) {
    const moduleVar = getterMatch[1];
    const escapedModuleVar = moduleVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const assignPattern = new RegExp(`${escapedModuleVar}\\s*=\\s*\\{[^}]*highlight:[^}]*supportsLanguage:[^}]*\\}`);
    if (assignPattern.test(content)) {
      syncGetter = candidateFn;
      hljsMode = 'sync';
      output.discovery('hljs sync getter', syncGetter, {
        'module var': moduleVar,
        'anchor': 'syntaxHighlightingDisabled?null:' + syncGetter + '()',
      });
    }
  }
}

if (!hljsMode) {
  const cacherPattern = /function ([$\w]+)\(\)\{return ([$\w]+)\?\?=([^,{}]+),\2\}/g;
  for (const m of content.matchAll(cacherPattern)) {
    const idx = m.index;
    const context = content.slice(Math.max(0, idx - 1500), idx + m[0].length + 1500);
    if (context.includes('highlight') && context.includes('supportsLanguage')) {
      cacherFn = m[1];
      hljsMode = 'cacher';
      output.discovery('hljs cacher function', cacherFn, {
        'cache var': m[2],
        'resolver expr': m[3],
      });
      break;
    }
  }
}

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
    'Expected (2.1.113+): syntaxHighlightingDisabled?null:GETTER() with function GETTER(){return VAR}',
    'Expected (2.1.78+):  function X(){return Y??=Z,Y} near highlight/supportsLanguage',
    'Expected (legacy):   VAR1 = H.highlight, VAR2 = H.supportsLanguage',
    'The hljs import structure may have changed',
  ]);
  process.exit(1);
}

// ============================================================
// Step 2: Discover the ANSI text component (unchanged)
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
// Step 3: Patch the user message wrapper (2.1.139 memo-cache form)
//
// We match one large span: from the guard through `return G_VAR}` (end of
// the function body). All `$[N]` slot numbers are matched as digits since
// the bundler assigns them deterministically but the absolute slot index
// depends on what precedes — we don't care about the numbers, only the
// shape.
// ============================================================

const wrapperPattern = new RegExp(
  // Guard line: if(!GUARD)return ERR(Error("...")),null;
  'if\\(!([$\\w]+)\\)return ([$\\w]+)\\(Error\\("No content found in user prompt message"\\)\\),null;' +
  // let MARG=MARGSRC?1:0,BG=BRIEF?void 0:"userMessageBackground",PAD=BRIEF?0:1,TS=BRIEF?TSVAR:void 0,W_VAR;
  'let ([$\\w]+)=([$\\w]+)\\?1:0,' +
    '([$\\w]+)=([$\\w]+)\\?void 0:"userMessageBackground",' +
    '([$\\w]+)=\\6\\?0:1,' +
    '([$\\w]+)=\\6\\?([$\\w]+):void 0,' +
    '([$\\w]+);' +
  // Groups so far: 1=guard, 2=err, 3=marg, 4=margSrc, 5=bg, 6=brief,
  //                7=pad, 8=ts, 9=tsSrc, 10=wVar.
  // if($[N]!==X||$[N]!==TS||$[N]!==BRIEF) W_VAR=REACT.default.createElement(VYF,{text:X,useBriefLayout:BRIEF,timestamp:TS}),$[N]=X,$[N]=TS,$[N]=BRIEF,$[N]=W_VAR;else W_VAR=$[N];
  // New groups: 11=textSrc(X), 12=react, 13=vyf.
  'if\\(\\$\\[\\d+\\]!==([$\\w]+)\\|\\|\\$\\[\\d+\\]!==\\8\\|\\|\\$\\[\\d+\\]!==\\6\\)' +
    '\\10=([$\\w]+)\\.default\\.createElement\\(([$\\w]+),\\{' +
      'text:\\11,useBriefLayout:\\6,timestamp:\\8' +
    '\\}\\),\\$\\[\\d+\\]=\\11,\\$\\[\\d+\\]=\\8,\\$\\[\\d+\\]=\\6,\\$\\[\\d+\\]=\\10;' +
  'else \\10=\\$\\[\\d+\\];' +
  // let G_VAR;if($[N]!==MARG||$[N]!==BG||$[N]!==PAD||$[N]!==W_VAR) G_VAR=REACT.default.createElement(BOX,{flexDirection:"column",marginTop:MARG,backgroundColor:BG,paddingRight:PAD},W_VAR),...;else G_VAR=$[N];return G_VAR}
  // New groups: 14=gVar, 15=box.
  'let ([$\\w]+);' +
  'if\\(\\$\\[\\d+\\]!==\\3\\|\\|\\$\\[\\d+\\]!==\\5\\|\\|\\$\\[\\d+\\]!==\\7\\|\\|\\$\\[\\d+\\]!==\\10\\)' +
    '\\14=\\12\\.default\\.createElement\\(([$\\w]+),\\{' +
      'flexDirection:"column",marginTop:\\3,backgroundColor:\\5,paddingRight:\\7' +
    '\\},\\10\\),\\$\\[\\d+\\]=\\3,\\$\\[\\d+\\]=\\5,\\$\\[\\d+\\]=\\7,\\$\\[\\d+\\]=\\10,\\$\\[\\d+\\]=\\14;' +
  'else \\14=\\$\\[\\d+\\];' +
  'return \\14\\}'
);

const wrapperMatch = content.match(wrapperPattern);

if (!wrapperMatch) {
  output.error('Could not find user message wrapper pattern (2.1.139 memo-cache form)', [
    'Expected: guard, then three-block memo-cache structure ending in `return G}`',
    'The wrapper structure may have changed again',
  ]);
  process.exit(1);
}

// Groups: 1=guard, 2=err, 3=margin, 4=marginSrc, 5=bg, 6=brief, 7=pad, 8=ts,
//         9=tsSrc, 10=wVar, 11=textSrcX, 12=react, 13=vyf, 14=gVar, 15=box.
const matched      = wrapperMatch[0];
const guardVar     = wrapperMatch[1];
const errorFn      = wrapperMatch[2];
const marginSrc    = wrapperMatch[4];
const briefVar     = wrapperMatch[6];
const tsSourceVar  = wrapperMatch[9];
const textSrcVar   = wrapperMatch[11];
const reactVar     = wrapperMatch[12];
const vyfComp      = wrapperMatch[13];
const boxComp      = wrapperMatch[15];

output.discovery('user message wrapper (memo-cache)', matched.slice(0, 80) + '...', {
  'guard var': guardVar,
  'error fn': errorFn,
  'margin src': marginSrc,
  'brief var': briefVar,
  'ts src': tsSourceVar,
  'text source': textSrcVar,
  'React var': reactVar,
  'vyf component': vyfComp,
  'box component': boxComp,
  'hljs mode': hljsMode,
});

const CE = `${reactVar}.default.createElement`;

// Build hljs init + access code per mode.
let hljsInit, hljsAccess, hljsHighlightCall, hljsSupportsCall, hljsGuard;

if (hljsMode === 'sync') {
  hljsInit = '';
  hljsAccess = `var _hljs=${syncGetter}();`;
  hljsHighlightCall = '_hljs.highlight';
  hljsSupportsCall = '_hljs.supportsLanguage';
  hljsGuard = '_hljs';
} else if (hljsMode === 'cacher') {
  hljsInit =
    `if(!globalThis.__hljs){try{${cacherFn}().then(function(r){globalThis.__hljs=r})}catch{}}`;
  hljsAccess = 'var _hljs=globalThis.__hljs;';
  hljsHighlightCall = '_hljs.highlight';
  hljsSupportsCall = '_hljs.supportsLanguage';
  hljsGuard = '_hljs';
} else {
  hljsInit = '';
  hljsAccess = '';
  hljsHighlightCall = hljsHighlight;
  hljsSupportsCall = hljsSupports;
  hljsGuard = hljsHighlight;
}

// The replacement preserves the guard, then forks on whether textSrcVar is a
// string (normal case — apply code-block split) or an object (head/tail
// summary — fall back to original vyf render). In both branches we end with
// `return BOX(flexDirection:"column",marginTop,backgroundColor,paddingRight,
// children)`, bypassing the $[N] memo slots entirely.
const wrapperReplacement =
  hljsInit +
  `if(!${guardVar})return ${errorFn}(Error("No content found in user prompt message")),null;` +
  // Common scalar props
  `var _mt=${marginSrc}?1:0,` +
  `_bg=${briefVar}?void 0:"userMessageBackground",` +
  `_pr=${briefVar}?0:1,` +
  `_ts=${briefVar}?${tsSourceVar}:void 0;` +
  // Branch on text-source shape
  `if(typeof ${textSrcVar}!=="string"){` +
    `return ${CE}(${boxComp},{flexDirection:"column",marginTop:_mt,backgroundColor:_bg,paddingRight:_pr},` +
      `${CE}(${vyfComp},{text:${textSrcVar},useBriefLayout:${briefVar},timestamp:_ts}))` +
  `}` +
  // String case — split into fenced/plain parts
  `var _parts=(function(_t){` +
    `var _re=/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,_a=[],_l=0,_m;` +
    `while((_m=_re.exec(_t))!==null){` +
      `if(_m.index>_l)_a.push({t:"x",c:_t.slice(_l,_m.index)});` +
      `_a.push({t:"c",c:_m[2],g:_m[1]||""});` +
      `_l=_m.index+_m[0].length` +
    `}` +
    `if(_l<_t.length)_a.push({t:"x",c:_t.slice(_l)});` +
    `if(_a.length===0)_a.push({t:"x",c:_t});` +
    `return _a` +
  `})(${textSrcVar});` +
  `var _hasCode=_parts.some(function(_e){return _e.t==="c"});` +
  `var _ch;` +
  `if(!_hasCode){` +
    `_ch=${CE}(${vyfComp},{text:${textSrcVar},useBriefLayout:${briefVar},timestamp:_ts})` +
  `}else{` +
    hljsAccess +
    `var _first=!0;` +
    `_ch=_parts.map(function(_e,_i){` +
      `if(_e.t==="x"){` +
        `if(_first){_first=!1;return ${CE}(${vyfComp},{key:"t"+_i,text:_e.c,useBriefLayout:${briefVar},timestamp:_ts})}` +
        `return ${CE}(${vyfComp},{key:"t"+_i,text:_e.c,useBriefLayout:${briefVar}})` +
      `}else{` +
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
  `return ${CE}(${boxComp},{flexDirection:"column",marginTop:_mt,backgroundColor:_bg,paddingRight:_pr},_ch)}`;

output.modification('user message wrapper',
  matched.slice(0, 80) + '...',
  wrapperReplacement.slice(0, 80) + '...',
);

// ============================================================
// Apply
// ============================================================

if (dryRun) {
  output.result('dry_run', `Code blocks patch ready (3 steps: hljs [${hljsMode}], ANSI, wrapper [memo-cache])`);
  process.exit(0);
}

let patched = content;
patched = patched.replace(matched, () => wrapperReplacement);

if (patched === content) {
  output.error('Patch had no effect');
  process.exit(1);
}

try {
  fs.writeFileSync(targetPath, patched);
  output.result('success', `Patched code blocks in ${targetPath} (hljs mode: ${hljsMode}, wrapper: memo-cache)`);
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

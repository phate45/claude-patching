#!/usr/bin/env node
/**
 * Patch to render fenced code blocks in user messages with hljs syntax
 * highlighting — the same treatment assistant messages get.
 *
 * See patches/2.1.109/patch-code-blocks.js for the full background on
 * wrapper discovery and the ANSI text component strategy.
 *
 * 2.1.113 change: hljs loading simplified again.
 *   2.1.78–2.1.107:  function X(){return Y??=Z(),Y}  (async, Promise-wrapped)
 *   2.1.109–2.1.112: function X(){return Y??=Promise.resolve(obj),Y}
 *   2.1.113+:        function X(){return Y} where Y is a sync module var
 *
 *   The hljs object is now populated synchronously at module init via the
 *   same `v(() => { ... })` lazy-init wrapper used for other modules.
 *   Consumers call the getter directly and get back the resolved
 *   {highlight, supportsLanguage} object — no `.then()` needed.
 *
 *   We anchor on the existing consumer shape:
 *     `syntaxHighlightingDisabled?null:GETTER()`
 *   which is stable across the React memo cache sites. From there we pick
 *   up the getter name and call it inline during our code-block render.
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
// Step 1: Discover hljs accessor
//
// Try modes in newest-to-oldest order:
//   'sync'   (2.1.113+): function X(){return Y}, anchored via
//                        `syntaxHighlightingDisabled?null:X()`
//   'cacher' (2.1.78+):  function X(){return Y??=Z,Y} near highlight/supportsLanguage
//   'legacy' (≤2.1.77):  VAR1=H.highlight,VAR2=H.supportsLanguage
// ============================================================

let hljsMode;
let syncGetter;                      // 2.1.113+: getter function name
let cacherFn;                        // 2.1.78–2.1.112: cacher function name
let hljsHighlight, hljsSupports;     // ≤2.1.77: direct module vars

// Try 2.1.113+ sync getter first, anchored by syntaxHighlightingDisabled consumer.
const syncAnchorPattern = /syntaxHighlightingDisabled\?null:([$\w]+)\(\)/;
const syncAnchorMatch = content.match(syncAnchorPattern);
if (syncAnchorMatch) {
  const candidateFn = syncAnchorMatch[1];
  // Verify: the function body should be `function FN(){return VAR}` — sync return.
  const getterDecl = new RegExp(`function ${candidateFn}\\(\\)\\{return ([$\\w]+)\\}`);
  const getterMatch = content.match(getterDecl);
  if (getterMatch) {
    const moduleVar = getterMatch[1];
    // Confirm the module var actually holds the hljs object by checking
    // its assignment site has both highlight and supportsLanguage.
    const assignPattern = new RegExp(`${moduleVar}\\s*=\\s*\\{[^}]*highlight:[^}]*supportsLanguage:[^}]*\\}`);
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

// Try 2.1.78+ cacher pattern.
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

// Fallback: legacy pattern (≤2.1.77)
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
// Step 2: Discover the ANSI text component (f9)
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
// Step 3: Patch the user message wrapper
// ============================================================

const hyfPatternNew = new RegExp(
  '([$\\w]+)=([$\\w]+)\\.useContext\\(([$\\w]+)\\);' +
  'if\\(!([$\\w]+)\\)return ([$\\w]+)\\(Error\\("No content found in user prompt message"\\)\\),null;' +
  'return \\2\\.default\\.createElement\\(([$\\w]+),\\{' +
  'flexDirection:"column",' +
  'marginTop:([$\\w]+)\\?1:0,' +
  'backgroundColor:\\1\\?"messageActionsBackground":([$\\w]+)\\?void 0:"userMessageBackground",' +
  'paddingRight:\\8\\?0:1' +
  '\\},\\2\\.default\\.createElement\\(([$\\w]+),\\{' +
  'text:([$\\w]+),' +
  'useBriefLayout:\\8,' +
  'timestamp:\\8\\?([$\\w]+):void 0' +
  '\\}\\)\\)\\}'
);

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

const G = guardVar;
const T = memoTextVar;
const CE = `${reactVar}.default.createElement`;

// Build hljs init + access code per mode.
let hljsInit, hljsAccess, hljsHighlightCall, hljsSupportsCall, hljsGuard;

if (hljsMode === 'sync') {
  // 2.1.113+: synchronous getter, call inline. No lazy-load dance needed.
  hljsInit = '';
  hljsAccess = `var _hljs=${syncGetter}();`;
  hljsHighlightCall = '_hljs.highlight';
  hljsSupportsCall = '_hljs.supportsLanguage';
  hljsGuard = '_hljs';
} else if (hljsMode === 'cacher') {
  // 2.1.78–2.1.112: cache via globalThis.__hljs, lazy .then() populate.
  hljsInit =
    `if(!globalThis.__hljs){try{${cacherFn}().then(function(r){globalThis.__hljs=r})}catch{}}`;
  hljsAccess = 'var _hljs=globalThis.__hljs;';
  hljsHighlightCall = '_hljs.highlight';
  hljsSupportsCall = '_hljs.supportsLanguage';
  hljsGuard = '_hljs';
} else {
  // Legacy: direct module-scope variables.
  hljsInit = '';
  hljsAccess = '';
  hljsHighlightCall = hljsHighlight;
  hljsSupportsCall = hljsSupports;
  hljsGuard = hljsHighlight;
}

const bgProp = actionsVar
  ? `backgroundColor:${actionsVar}?"messageActionsBackground":${briefVar}?void 0:"userMessageBackground"`
  : `backgroundColor:${briefVar}?void 0:"userMessageBackground"`;

const hyfReplacement =
  (actionsVar ? `${actionsVar}=${reactVar}.useContext(${hyfMatch[3]});` : '') +
  hljsInit +
  `if(!${G})return ${errorFn}(Error("No content found in user prompt message")),null;` +
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
  `var _hasCode=_parts.some(function(_e){return _e.t==="c"});` +
  `var _ch;` +
  `if(!_hasCode){` +
  `_ch=${CE}(${vyfComp},{text:${T},useBriefLayout:${briefVar},timestamp:${briefVar}?${tsVar}:void 0})` +
  `}else{` +
  ((hljsMode === 'cacher' || hljsMode === 'sync') ? `${hljsAccess}` : '') +
  `var _first=!0;` +
  `_ch=_parts.map(function(_e,_i){` +
  `if(_e.t==="x"){` +
  `if(_first){_first=!1;return ${CE}(${vyfComp},{key:"t"+_i,text:_e.c,useBriefLayout:${briefVar},` +
  `timestamp:${briefVar}?${tsVar}:void 0})}` +
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

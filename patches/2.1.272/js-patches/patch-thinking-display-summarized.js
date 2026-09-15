#!/usr/bin/env node
/**
 * Patch: opt back into summarized thinking text on Opus 4.7.
 *
 * 2.1.153 change:
 *   Anthropic introduced a `showThinkingSummaries` setting (default false) and
 *   gated the implicit `display:"summarized"` assignment on it.
 *
 * 2.1.209 change:
 *   The session-start builder was consolidated into a single display resolver
 *   function:
 *
 *     function wrc({explicitDisplay:e,isNonInteractive:t,outputFormat:r,verbose:n}){
 *       if(e)return e;                            // explicit display wins
 *       if(!t)return ovi()?"summarized":void 0;   // interactive: gated on ovi()
 *       if(r==="text"||r==="json"&&!n)return"omitted";
 *       return
 *     }
 *
 *   where `ovi()=Xn().showThinkingSummaries??!1`. Without the setting the
 *   interactive branch returns undefined and Opus ships thinking summaries
 *   omitted by default — the TUI streams the live reasoning briefly, then the
 *   completed assistant block reverts to a "thought for Ns" widget because no
 *   summary is persisted on the message.
 *
 *   We replace the interactive branch's `return ovi()?"summarized":void 0` with
 *   an unconditional `return"summarized"` so display defaults to "summarized" in
 *   every interactive session (matching pre-2.1.153 behavior). Explicit display
 *   (`if(e)return e`) and non-interactive output-format handling both keep
 *   working since they're separate branches.
 *
 * Site 2 (legacy / SDK path) — 2.1.272 reshape:
 *   The SDK `set_max_thinking_tokens` rebuild now runs through a small builder
 *   `qhn(tokens,display,cfg)`:
 *
 *     function qhn(e,n,o){
 *       if(e==null){
 *         if(o)return o.type!=="disabled"?{...o,display:n}:o;
 *         return n!==void 0&&O$()?{type:"adaptive",display:n}:void 0
 *       }
 *       if(e===0)return{type:"disabled"};
 *       return{type:"enabled",budgetTokens:e,display:n}
 *     }
 *
 *   `n` is the SDK-supplied `thinking_display` (nullable/optional). When absent,
 *   every branch sets `display:undefined` → thinking summaries omitted. We
 *   default `display` to `"summarized"` at the two branches reachable with an
 *   undefined `n` (the existing-config spread and the enabled branch); the
 *   adaptive branch is already gated on `n!==void 0`, so it's left verbatim.
 *
 * Usage:
 *   node patch-thinking-display-summarized.js <cli.js path>
 *   node patch-thinking-display-summarized.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-thinking-display-summarized.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

let patchCount = 0;

// ── Site 1: drop the ovi() gate on the interactive display default ──
// Minified (inside the wrc resolver):
//   if(!t)return ovi()?"summarized":void 0
// Generalized:
//   if(!<isNonInteractive>)return <settingsGate>()?"summarized":void 0
const site1 = /if\(!([$\w]+)\)return ([$\w]+)\(\)\?"summarized":void 0/;
const m1 = content.match(site1);

if (!m1) {
  output.error('Could not find session-start display gate', [
    'Expected: if(!isNonInteractive)return SETTING()?"summarized":void 0',
    'The thinking-config builder may have changed shape',
  ]);
  process.exit(1);
}

const [s1Original, nonInteractiveVar, settingFn] = m1;
const s1Replacement = `if(!${nonInteractiveVar})return"summarized"`;

output.discovery('session-start display gate', s1Original, {
  'isNonInteractive var': nonInteractiveVar,
  'setting fn': settingFn,
});

output.modification('drop showThinkingSummaries gate', s1Original, s1Replacement);

content = content.replace(s1Original, s1Replacement);
patchCount++;

// ── Site 2: SDK rebuild builder — default display to "summarized" ──
// Minified shape (qhn builder): captures tokens/display/cfg params + the O$ gate.
//   function F(TOK,DISP,CFG){if(TOK==null){if(CFG)return CFG.type!=="disabled"?
//     {...CFG,display:DISP}:CFG;return DISP!==void 0&&GATE()?{type:"adaptive",
//     display:DISP}:void 0}if(TOK===0)return{type:"disabled"};
//     return{type:"enabled",budgetTokens:TOK,display:DISP}}
const site2 = /function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+)\)\{if\(\2==null\)\{if\(\4\)return \4\.type!=="disabled"\?\{\.\.\.\4,display:\3\}:\4;return \3!==void 0&&([$\w]+)\(\)\?\{type:"adaptive",display:\3\}:void 0\}if\(\2===0\)return\{type:"disabled"\};return\{type:"enabled",budgetTokens:\2,display:\3\}\}/;
const m2 = content.match(site2);

if (!m2) {
  output.error('Could not find SDK rebuild display builder (site 2)', [
    'Expected: function F(TOK,DISP,CFG){if(TOK==null){if(CFG)return CFG.type!=="disabled"?{...CFG,display:DISP}:CFG;…return{type:"enabled",budgetTokens:TOK,display:DISP}}',
  ]);
  process.exit(1);
}

const [s2Original, fnName, tokVar, dispVar, cfgVar, gateFn] = m2;
const s2Replacement =
  `function ${fnName}(${tokVar},${dispVar},${cfgVar}){` +
  `if(${tokVar}==null){` +
  `if(${cfgVar})return ${cfgVar}.type!=="disabled"?{...${cfgVar},display:${dispVar}??"summarized"}:${cfgVar};` +
  `return ${dispVar}!==void 0&&${gateFn}()?{type:"adaptive",display:${dispVar}}:void 0}` +
  `if(${tokVar}===0)return{type:"disabled"};` +
  `return{type:"enabled",budgetTokens:${tokVar},display:${dispVar}??"summarized"}}`;

output.discovery('SDK rebuild display builder', fnName + '()', {
  'tokens var': tokVar,
  'display var': dispVar,
  'config var': cfgVar,
});

output.modification('SDK rebuild display default',
  `display:${dispVar}`,
  `display:${dispVar}??"summarized"`);

content = content.replace(s2Original, s2Replacement);
patchCount++;

// ── Write ──

if (patchCount !== 2) {
  output.error(`Expected 2 patches, got ${patchCount}`);
  process.exit(1);
}

if (dryRun) {
  output.result('dry_run', `thinking-display-summarized: ${patchCount}/2 patches verified`);
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `thinking-display-summarized: ${patchCount}/2 patches applied`);
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Patch: opt back into summarized thinking text on Opus 4.7.
 *
 * 2.1.153 change:
 *   Anthropic introduced a `showThinkingSummaries` setting (default false) and
 *   gated the implicit `display:"summarized"` assignment on it. The session-
 *   start thinkingConfig builder reads:
 *
 *     if (W4.type !== "disabled") {
 *       if (A.thinkingDisplay === "summarized" || A.thinkingDisplay === "omitted")
 *         W4.display = A.thinkingDisplay;
 *       else if (!R6() && re$()) W4.display = "summarized"     // ← re$() = settings.showThinkingSummaries
 *     }
 *
 *   Without the setting, `W4.display` stays undefined and Opus 4.7 ships
 *   thinking summaries omitted by default — the TUI streams the live
 *   reasoning briefly, then the completed assistant block reverts to a
 *   "thought for Ns" widget because no summary is persisted on the message.
 *
 *   We strip the `&& re$()` clause so display defaults to "summarized" in
 *   every interactive session (matching pre-2.1.153 behavior). Explicit
 *   `--thinking-display=omitted` and the `showThinkingSummaries` setting
 *   both keep working since they're handled by the earlier branches.
 *
 * Site 2 (legacy / SDK path):
 *   The closure builder still computes a local `HH` from `j.thinkingConfig`
 *   that flows into `LG9(maxThinkingTokens, HH)` when an SDK client issues
 *   `set_max_thinking_tokens`. We patch that read with `?? "summarized"` so
 *   the SDK-driven rebuild also defaults to summarized when no display is
 *   inherited from the parent config.
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

// ── Site 1: drop the re$() gate on the session-start display default ──
// Minified:
//   else if(!R6()&&re$())W4.display="summarized"
// Generalized:
//   else if(!<interactive>()&&<settingsGate>())<cfg>.display="summarized"
const site1 = /else if\(!([$\w]+)\(\)&&([$\w]+)\(\)\)([$\w]+)\.display="summarized"/;
const m1 = content.match(site1);

if (!m1) {
  output.error('Could not find session-start display gate', [
    'Expected: else if(!INTERACTIVE()&&SETTING())CFG.display="summarized"',
    'The thinking-config builder may have changed shape',
  ]);
  process.exit(1);
}

const [s1Original, interactiveFn, settingFn, cfgVar] = m1;
const s1Replacement = `else if(!${interactiveFn}())${cfgVar}.display="summarized"`;

output.discovery('session-start display gate', s1Original, {
  'interactive fn': interactiveFn,
  'setting fn': settingFn,
  'config var': cfgVar,
});

output.modification('drop showThinkingSummaries gate', s1Original, s1Replacement);

content = content.replace(s1Original, s1Replacement);
patchCount++;

// ── Site 2: SDK rebuild path — default HH to "summarized" when undefined ──
// Minified shape:
//   <out>=<cfg>.thinkingConfig&&<cfg>.thinkingConfig.type!=="disabled"?<cfg>.thinkingConfig.display:void 0
const site2 = /([$\w]+)=([$\w]+)\.thinkingConfig&&\2\.thinkingConfig\.type!=="disabled"\?\2\.thinkingConfig\.display:void 0/;
const m2 = content.match(site2);

if (!m2) {
  output.error('Could not find SDK rebuild display read (site 2)', [
    'Expected: VAR=VAR.thinkingConfig&&VAR.thinkingConfig.type!=="disabled"?VAR.thinkingConfig.display:void 0',
  ]);
  process.exit(1);
}

const [s2Original, outVar, cfgHolder] = m2;
const s2Replacement = `${outVar}=${cfgHolder}.thinkingConfig&&${cfgHolder}.thinkingConfig.type!=="disabled"?${cfgHolder}.thinkingConfig.display??"summarized":void 0`;

output.discovery('SDK rebuild display read', s2Original, {
  'display var': outVar,
  'config holder': cfgHolder,
});

output.modification('SDK rebuild display default',
  `${cfgHolder}.thinkingConfig.display`,
  `${cfgHolder}.thinkingConfig.display ?? "summarized"`);

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

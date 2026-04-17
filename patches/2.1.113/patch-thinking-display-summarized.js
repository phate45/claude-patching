#!/usr/bin/env node
/**
 * Patch: opt back into summarized thinking text on Opus 4.7.
 *
 * See patches/2.1.111/patch-thinking-display-summarized.js for full rationale.
 *
 * 2.1.113 change:
 *   The request builder dropped the redundant `?? void 0` in the display
 *   assignment. `q.display` already resolves to undefined when absent, so
 *   the minifier/source now emits:
 *
 *     yH = Z$ ? q.display : void 0
 *
 *   instead of the 2.1.111 form:
 *
 *     CH = h$ ? q.display ?? void 0 : void 0
 *
 *   We still replace the truthy branch with `q.display ?? "summarized"` to
 *   restore a default when no explicit display is passed.
 *
 * Usage:
 *   node patch-thinking-display-summarized.js <cli.js path>
 *   node patch-thinking-display-summarized.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../lib/output');

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

// 2.1.113 shape: yH=Z$?q.display:void 0
// Generalized: <chVar>=<enabledVar>?<cfgVar>.display:void 0
//
// The enabled flag sits on the q.type!=="disabled" && !DISABLE_THINKING env
// check immediately above, and the result (yH) feeds the `display:` prop of
// the adaptive/enabled thinking config objects.
const pattern = /([$\w]+)=([$\w]+)\?([$\w]+)\.display:void 0/;
const matches = [...content.matchAll(new RegExp(pattern.source, 'g'))];

if (matches.length === 0) {
  output.error('Could not find thinking display assignment', [
    'Expected: VAR=VAR?VAR.display:void 0',
    'The request builder structure may have changed in this CC version',
  ]);
  process.exit(1);
}

if (matches.length > 1) {
  output.error(`Expected exactly 1 thinking display match, found ${matches.length}`, [
    'Pattern is no longer uniquely identifying — add surrounding context',
  ]);
  process.exit(1);
}

const match = matches[0];
const [original, chVar, enabledVar, cfgVar] = match;
const replacement = `${chVar}=${enabledVar}?${cfgVar}.display??"summarized":void 0`;

output.discovery('thinking display assignment', original, {
  'display var': chVar,
  'enabled flag': enabledVar,
  'config var': cfgVar,
});

output.modification('thinking display default',
  `${cfgVar}.display`,
  `${cfgVar}.display ?? "summarized"`,
);

const patched = content.replace(original, replacement);

if (patched === content) {
  output.error('Patch had no effect');
  process.exit(1);
}

if (dryRun) {
  output.result('dry_run', 'Thinking display patch ready');
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, patched);
  output.result('success', `Patched thinking display in ${targetPath}`);
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

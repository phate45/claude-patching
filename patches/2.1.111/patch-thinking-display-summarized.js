#!/usr/bin/env node
/**
 * Patch: opt back into summarized thinking text on Opus 4.7.
 *
 * Context:
 *   Starting with Claude Opus 4.7, the API omits `thinking` text content from
 *   responses by default. Thinking blocks still arrive in the stream, but their
 *   `thinking` field is empty unless the caller passes `thinking.display =
 *   "summarized"`. This is documented in the embedded migration guide at
 *   ~line 516579 of cli.js.native.pretty.
 *
 *   CC's request builder (~line 458555 of the pretty file) sets the `display`
 *   field from `q.display` where `q` is a `thinkingConfig` object. Every call
 *   site in CC either passes a fixed `{type:"disabled"}` config or forwards
 *   `options.thinkingConfig` from upstream — and `options.thinkingConfig` is
 *   never populated with a `display` value from user settings. The schema at
 *   ~line 217330 accepts `display: "summarized" | "omitted"`, but there is no
 *   UI, CLI flag, or config key that wires it in for default sessions.
 *
 *   Result: for Opus 4.7, CC always sends `display: undefined`, the API
 *   applies its default of "omitted", and thinking blocks arrive empty.
 *
 * What this patch does:
 *   At the CH assignment, change the fallback from `void 0` to `"summarized"`:
 *
 *   Before:  CH=h$?q.display??void 0:void 0
 *   After:   CH=h$?q.display??"summarized":void 0
 *
 *   Behavior:
 *   - Thinking enabled + no explicit display → "summarized" (restores text)
 *   - Thinking enabled + explicit q.display set → q.display (honors override)
 *   - Thinking disabled (type:"disabled" or CLAUDE_CODE_DISABLE_THINKING) → void 0
 *   - Covers both adaptive and legacy `type:"enabled"` branches since both
 *     write `display: CH` into their respective request objects.
 *   - On Opus 4.6 / Sonnet 4.6, "summarized" matches the existing API default,
 *     so the change is a no-op there.
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

// Minified shape: CH=h$?q.display??void 0:void 0
// Generalized: <chVar>=<enabledVar>?<cfgVar>.display??void 0:void 0
const pattern = /([$\w]+)=([$\w]+)\?([$\w]+)\.display\?\?void 0:void 0/;
const match = content.match(pattern);

if (!match) {
  output.error('Could not find thinking display assignment', [
    'Expected: VAR=VAR?VAR.display??void 0:void 0',
    'The request builder structure may have changed in this CC version',
  ]);
  process.exit(1);
}

const [original, chVar, enabledVar, cfgVar] = match;
const replacement = `${chVar}=${enabledVar}?${cfgVar}.display??"summarized":void 0`;

output.discovery('thinking display assignment', original, {
  'display var': chVar,
  'enabled flag': enabledVar,
  'config var': cfgVar,
});

output.modification('thinking display default',
  `${cfgVar}.display ?? void 0`,
  `${cfgVar}.display ?? "summarized"`,
);

const patched = content.replace(pattern, () => replacement);

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

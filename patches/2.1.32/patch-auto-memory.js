#!/usr/bin/env node
/**
 * Patch to force-enable the auto memory feature (tengu_oboe feature flag)
 *
 * What it does:
 * - Bypasses the GrowthBook feature flag check for tengu_oboe
 * - Forces the auto memory gate function to return true
 * - Still respects CLAUDE_CODE_DISABLE_AUTO_MEMORY env var
 *
 * Effect when enabled:
 * - MEMORY.md loaded into system prompt from ~/.claude/projects/<project>/memory/
 * - Custom agents gain memory scopes (user/project/local)
 * - Memory directories get automatic read/write permissions
 *
 * Usage:
 *   node patch-auto-memory.js <cli.js path>
 *   node patch-auto-memory.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const path = require('path');
const output = require('../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-auto-memory.js [--check] <cli.js path>');
  process.exit(1);
}

// Read the file
let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}:`, [err.message]);
  process.exit(1);
}

// Pattern: function VAR(){if(VAR(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY))return!1;return VAR("tengu_oboe",!1)}
// The structure is stable across bare/native and versions — only variable names change.
const pattern =
  /(function [$\w]+\(\)\{if\([$\w]+\(process\.env\.CLAUDE_CODE_DISABLE_AUTO_MEMORY\)\)return!1;return )[$\w]+\("tengu_oboe",!1\)(\})/;

const match = content.match(pattern);

if (!match) {
  output.error('Could not find tengu_oboe feature flag pattern in cli.js', [
    'This might be an unsupported Claude Code version',
    'Expected pattern: function VAR(){if(VAR(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY))return!1;return VAR("tengu_oboe",!1)}'
  ]);
  process.exit(1);
}

output.discovery('auto memory feature flag', 'tengu_oboe', {
  original: match[0]
});
output.info(`Original: ${match[0]}`);

// Replace the GrowthBook call with a hard true
const replacement = `${match[1]}!0${match[2]}`;

output.modification('pattern', 'return VAR("tengu_oboe",!1)', 'return!0');

if (dryRun) {
  output.result('dry_run', 'No changes made');
  process.exit(0);
}

// Apply the patch
const patchedContent = content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length);

// Write the patched file
try {
  fs.writeFileSync(targetPath, patchedContent);
  output.result('success', `Patched ${targetPath}`);
  output.info('Restart Claude Code to enable auto memory.');
  output.info('Disable with: CLAUDE_CODE_DISABLE_AUTO_MEMORY=1');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

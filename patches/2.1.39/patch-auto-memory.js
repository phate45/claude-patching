#!/usr/bin/env node
/**
 * Patch to force-enable the auto memory feature (tengu_oboe feature flag)
 *
 * What it does:
 * - Bypasses the GrowthBook feature flag check for tengu_oboe
 * - Forces the auto memory gate function to return true
 * - Still respects CLAUDE_CODE_DISABLE_AUTO_MEMORY env var and
 *   the autoMemoryEnabled setting (both are checked before the flag)
 *
 * Effect when enabled:
 * - MEMORY.md loaded into system prompt from ~/.claude/projects/<project>/memory/
 * - Custom agents gain memory scopes (user/project/local)
 * - Memory directories get automatic read/write permissions
 *
 * In 2.1.39 the gate function gained additional checks (settings override,
 * remote env handling) before falling through to the feature flag. The flag
 * is the only thing we need to patch — the rest works as-is.
 *
 * Usage:
 *   node patch-auto-memory.js <cli.js path>
 *   node patch-auto-memory.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-auto-memory.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Pattern: return VAR("tengu_oboe",!1)
// Unique across the entire codebase — only one occurrence.
// The surrounding function checks env vars and settings first,
// so this is only reached as a final fallback. We replace it with return!0.
const pattern = /return ([$\w]+)\("tengu_oboe",!1\)/;

const match = content.match(pattern);

if (!match) {
  output.error('Could not find tengu_oboe feature flag pattern', [
    'This might be an unsupported Claude Code version',
    'Expected: return VAR("tengu_oboe",!1)'
  ]);
  process.exit(1);
}

output.discovery('auto memory feature flag', 'tengu_oboe', {
  'flag function': match[1],
  original: match[0]
});

const original = match[0];
const patched = 'return!0';

output.modification('feature flag fallback', original, patched);

if (dryRun) {
  output.result('dry_run', 'No changes made');
  process.exit(0);
}

const patchedContent = content.replace(pattern, patched);

if (patchedContent === content) {
  output.error('Patch failed to apply (content unchanged)');
  process.exit(1);
}

try {
  fs.writeFileSync(targetPath, patchedContent);
  output.result('success', `Patched ${targetPath}`);
  output.info('Restart Claude Code to enable auto memory.');
  output.info('Disable with: CLAUDE_CODE_DISABLE_AUTO_MEMORY=1');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

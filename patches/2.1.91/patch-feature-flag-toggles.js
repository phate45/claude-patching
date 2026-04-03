#!/usr/bin/env node
/**
 * Patch to enable hidden feature flags via inline replacement
 *
 * Replaces FN("flag_name",!1) calls with !0 (truthy) for selected flags.
 * The gate function is the GrowthBook feature value reader — its minified
 * name varies between builds, so we match dynamically.
 *
 * Flags enabled (default-off → on):
 * - tengu_session_memory:          Session memory feature (required for sm_compact)
 * - tengu_sm_compact:              Structured session memory compaction (maintains a
 *                                  living summary.md instead of throw-away summaries)
 * - tengu_edit_minimalanchor_jrn:  Minimal old_string guidance (1-3 lines, minimum context)
 * - tengu_maple_forge_w8k:         Write tool append mode (mode:'append' parameter)
 *
 * Retired flags:
 * - tengu_mulberry_fog:   Promoted to default-on in 2.1.69 (removed from codebase)
 * - tengu_defer_all_bn4:  Was default-off sentinel in 2.1.84; removed from codebase in 2.1.89
 *
 * Kill switches preserved:
 * - DISABLE_CLAUDE_CODE_SM_COMPACT=1 still disables session memory compaction
 *
 * Usage:
 *   node patch-feature-flag-toggles.js <cli.js path>
 *   node patch-feature-flag-toggles.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-feature-flag-toggles.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Flag definitions: name, human label, expected occurrence count (advisory)
// enable: default-off flags to turn on (FN("name",!1) → !0)
const enableFlags = [
  { name: 'tengu_session_memory',         label: 'session memory',            expected: 2 },
  { name: 'tengu_sm_compact',             label: 'session memory compaction', expected: 1 },
  { name: 'tengu_edit_minimalanchor_jrn', label: 'edit minimal anchor',       expected: 1 },
  { name: 'tengu_maple_forge_w8k',        label: 'write append mode',         expected: 2 },
];

let totalPatched = 0;
const allFlags = [
  ...enableFlags.map(f => ({ ...f, from: '!1', to: '!0' })),
];

for (const flag of allFlags) {
  const pattern = new RegExp(`([$\\w]+)\\("${flag.name}",${flag.from.replace(/!/g, '\\!')}\\)`, 'g');
  const matches = [...content.matchAll(pattern)];

  if (matches.length === 0) {
    output.error(`Could not find feature flag: ${flag.name}`, [
      `Expected FN("${flag.name}",${flag.from}) pattern`,
      'This might be an unsupported Claude Code version'
    ]);
    process.exit(1);
  }

  const fnName = matches[0][1];

  output.discovery(flag.label, flag.name, {
    'flag function': fnName,
    'occurrences': matches.length,
    'expected': flag.expected
  });

  if (matches.length !== flag.expected) {
    output.info(`Note: expected ${flag.expected} occurrences of ${flag.name}, found ${matches.length}`);
  }

  content = content.replace(pattern, () => flag.to);
  totalPatched += matches.length;

  for (const m of matches) {
    output.modification(`${flag.label} (${flag.name})`, m[0], flag.to);
  }
}

if (dryRun) {
  output.result('dry_run', `All ${allFlags.length} flags found (${totalPatched} total replacements)`);
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Toggled ${allFlags.length} feature flags (${totalPatched} replacements) in ${targetPath}`);
  output.info('Enabled: session memory, structured compaction, edit minimal anchor, write append mode');
  output.info('Disable session memory compaction: DISABLE_CLAUDE_CODE_SM_COMPACT=1');
  output.info('Restart Claude Code to apply changes.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

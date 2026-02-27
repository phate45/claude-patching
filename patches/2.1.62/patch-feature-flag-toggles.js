#!/usr/bin/env node
/**
 * Patch to enable hidden feature flags via inline replacement
 *
 * Replaces IL("flag_name",!1) calls with !0 (truthy) for selected flags.
 * The IL() function is the GrowthBook feature value reader — its minified
 * name varies between builds, so we match dynamically.
 *
 * Flags enabled:
 * - tengu_mulberry_fog:   Richer memory management prompt (MUST access/save
 *                         directives, frontmatter format, persistence taxonomy)
 * - tengu_session_memory: Session memory feature (required for sm_compact)
 * - tengu_sm_compact:     Structured session memory compaction (maintains a
 *                         living summary.md instead of throw-away summaries)
 *
 * Kill switches preserved:
 * - DISABLE_CLAUDE_CODE_SM_COMPACT=1 still disables session memory compaction
 *   (the env var check precedes the flag checks in X2$())
 *
 * Replaces the retired patch-auto-memory.js (tengu_oboe), which was removed
 * when auto-memory graduated to on-by-default in 2.1.59.
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
const flags = [
  { name: 'tengu_mulberry_fog',   label: 'rich memory prompt',        expected: 2 },
  { name: 'tengu_session_memory', label: 'session memory',            expected: 2 },
  { name: 'tengu_sm_compact',     label: 'session memory compaction', expected: 1 },
];

let totalPatched = 0;

for (const flag of flags) {
  const pattern = new RegExp(`([$\\w]+)\\("${flag.name}",!1\\)`, 'g');
  const matches = [...content.matchAll(pattern)];

  if (matches.length === 0) {
    output.error(`Could not find feature flag: ${flag.name}`, [
      `Expected IL("${flag.name}",!1) pattern`,
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

  content = content.replace(pattern, () => '!0');
  totalPatched += matches.length;

  for (const m of matches) {
    output.modification(`${flag.label} (${flag.name})`, m[0], '!0');
  }
}

if (dryRun) {
  output.result('dry_run', `All ${flags.length} flags found (${totalPatched} total replacements)`);
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Enabled ${flags.length} feature flags (${totalPatched} replacements) in ${targetPath}`);
  output.info('Enabled: rich memory prompt, session memory, structured compaction');
  output.info('Disable session memory compaction: DISABLE_CLAUDE_CODE_SM_COMPACT=1');
  output.info('Restart Claude Code to apply changes.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

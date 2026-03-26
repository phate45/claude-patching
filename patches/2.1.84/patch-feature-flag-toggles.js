#!/usr/bin/env node
/**
 * Patch to enable hidden feature flags via inline replacement
 *
 * Replaces DL("flag_name",!1) calls with !0 (truthy) for selected flags.
 * The DL() function is the GrowthBook feature value reader — its minified
 * name varies between builds, so we match dynamically.
 *
 * Flags enabled (default-off → on):
 * - tengu_session_memory: Session memory feature (required for sm_compact)
 * - tengu_sm_compact:     Structured session memory compaction (maintains a
 *                         living summary.md instead of throw-away summaries)
 *
 * Flags verified (expected default):
 * - tengu_defer_all_bn4:  Defers ALL built-in tools behind ToolSearch.
 *                         Was default-on through 2.1.83, flipped to default-off in 2.1.84.
 *                         Verified (not patched) — alerts if Anthropic flips it back or removes it.
 *
 * Retired flags:
 * - tengu_mulberry_fog: Promoted to default-on in 2.1.69 (removed from codebase)
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
// enable: default-off flags to turn on (DL("name",!1) → !0)
const enableFlags = [
  { name: 'tengu_session_memory', label: 'session memory',            expected: 2 },
  { name: 'tengu_sm_compact',     label: 'session memory compaction', expected: 1 },
];
// verify: flags we expect at a specific default — no replacement, just sentinel detection
const verifyFlags = [
  { name: 'tengu_defer_all_bn4',  label: 'defer all tools',  expected: 2, expectDefault: '!1' },
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
      `Expected DL("${flag.name}",${flag.from}) pattern`,
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

// Verify sentinel flags — confirm expected defaults, alert on drift
for (const flag of verifyFlags) {
  const expectedPattern = new RegExp(`([$\\w]+)\\("${flag.name}",${flag.expectDefault.replace(/!/g, '\\!')}\\)`, 'g');
  const expectedMatches = [...content.matchAll(expectedPattern)];

  if (expectedMatches.length > 0) {
    output.discovery(flag.label + ' (verify)', flag.name, {
      'flag function': expectedMatches[0][1],
      'default': flag.expectDefault,
      'occurrences': expectedMatches.length,
      'status': 'as expected — no patch needed'
    });
    continue;
  }

  // Not found at expected default — check if it flipped back or vanished
  const flippedDefault = flag.expectDefault === '!1' ? '!0' : '!1';
  const flippedPattern = new RegExp(`([$\\w]+)\\("${flag.name}",${flippedDefault.replace(/!/g, '\\!')}\\)`, 'g');
  const flippedMatches = [...content.matchAll(flippedPattern)];

  if (flippedMatches.length > 0) {
    output.error(`Sentinel flag ${flag.name} flipped back to default ${flippedDefault}`, [
      `Expected default ${flag.expectDefault}, found ${flippedDefault} (${flippedMatches.length} occurrences)`,
      'Anthropic may have re-enabled this flag — consider adding it back to disableFlags'
    ]);
    process.exit(1);
  }

  output.error(`Sentinel flag ${flag.name} not found at any default`, [
    `Neither ${flag.expectDefault} nor ${flippedDefault} pattern found`,
    'Flag may have been removed from the codebase entirely'
  ]);
  process.exit(1);
}

if (dryRun) {
  output.result('dry_run', `All ${allFlags.length} flags found (${totalPatched} total replacements), ${verifyFlags.length} sentinel(s) verified`);
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Toggled ${allFlags.length} feature flags (${totalPatched} replacements), verified ${verifyFlags.length} sentinel(s) in ${targetPath}`);
  output.info('Enabled: session memory, structured compaction');
  output.info('Verified: defer_all_bn4 remains default-off (no patch needed)');
  output.info('Disable session memory compaction: DISABLE_CLAUDE_CODE_SM_COMPACT=1');
  output.info('Restart Claude Code to apply changes.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

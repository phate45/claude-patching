#!/usr/bin/env node
/**
 * Patch to toggle feature flags via inline replacement
 *
 * The gate function is the GrowthBook feature value reader — its minified
 * name varies between builds, so we match dynamically and anchor on the
 * (stable) flag-name string literal.
 *
 * Two directions:
 *
 *   enable  — default-OFF flags turned on.   FN("name",!1)      → !0
 *   disable — default-ON  flags forced off.   FN("name",!0,ctx)  → !1
 *
 * The disable form replaces the whole gate *call expression* with a literal
 * !1, so the flag is hard-off regardless of any remote/local GrowthBook
 * override — not merely default-off.
 *
 * Flags enabled (default-off → on):
 * - tengu_edit_minimalanchor_jrn:  Minimal old_string guidance (1-3 lines, minimum context)
 *
 * Flags disabled (default-on → hard-off):
 * - tengu_kairos_cron:  Gates the cron tool family (CronCreate/CronDelete/CronList)
 *   plus /loop scheduling. Read through uv() =
 *     !CLAUDE_CODE_DISABLE_CRON && GR("tengu_kairos_cron",!0,t)
 *   which drives each cron tool's isEnabled(). Forcing the gate false makes
 *   uv() always-false, so the tools never register and /loop is inert. Cron
 *   is unused here; dropping it removes three deferred-tool slots and the
 *   scheduler surface entirely. (Replaces the retired cron-visibility patch.)
 *
 * Retired flags:
 * - tengu_mulberry_fog:    Promoted to default-on in 2.1.69 (removed from codebase)
 * - tengu_defer_all_bn4:   Was default-off sentinel in 2.1.84; removed from codebase in 2.1.89
 * - tengu_sm_compact:      Gate removed in 2.1.92 (functionality now internally controlled)
 * - tengu_maple_forge_w8k: Removed from codebase in 2.1.97 (write append mode)
 * - tengu_session_memory:  Removed from codebase in 2.1.133 (session memory feature retired)
 *
 * Usage:
 *   node patch-feature-flag-toggles.js <cli.js path>
 *   node patch-feature-flag-toggles.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../../lib/output');

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
// enable:  default-off flags to turn on   — FN("name",!1)      → !0
// disable: default-on  flags to force off — FN("name",!0,ctx)  → !1
const enableFlags = [
  { name: 'tengu_edit_minimalanchor_jrn', label: 'edit minimal anchor', expected: 1 },
];
const disableFlags = [
  { name: 'tengu_kairos_cron', label: 'cron tool family', expected: 1 },
];

let totalPatched = 0;

// ── Enable: two-arg gate FN("name",!1) → !0 ──
for (const flag of enableFlags) {
  const pattern = new RegExp(`([$\\w]+)\\("${flag.name}",\\!1\\)`, 'g');
  const matches = [...content.matchAll(pattern)];

  if (matches.length === 0) {
    output.error(`Could not find feature flag: ${flag.name}`, [
      `Expected FN("${flag.name}",!1) pattern`,
      'This might be an unsupported Claude Code version'
    ]);
    process.exit(1);
  }

  const fnName = matches[0][1];
  output.discovery(flag.label, flag.name, {
    'flag function': fnName,
    'occurrences': matches.length,
    'expected': flag.expected,
    'direction': 'enable'
  });

  if (matches.length !== flag.expected) {
    output.info(`Note: expected ${flag.expected} occurrences of ${flag.name}, found ${matches.length}`);
  }

  content = content.replace(pattern, () => '!0');
  totalPatched += matches.length;
  for (const m of matches) output.modification(`${flag.label} (${flag.name})`, m[0], '!0');
}

// ── Disable: three-arg gate FN("name",!0,ctx) → !1 (hard-off) ──
// Replace the whole call expression so the flag is false regardless of any
// GrowthBook override. The trailing `,` after the name keeps sibling flags
// with a shared prefix (e.g. tengu_kairos_cron_durable) from colliding.
for (const flag of disableFlags) {
  const pattern = new RegExp(`([$\\w]+)\\("${flag.name}",\\!0,[$\\w]+\\)`, 'g');
  const matches = [...content.matchAll(pattern)];

  if (matches.length === 0) {
    output.error(`Could not find feature flag: ${flag.name}`, [
      `Expected FN("${flag.name}",!0,ctx) pattern`,
      'This might be an unsupported Claude Code version'
    ]);
    process.exit(1);
  }

  const fnName = matches[0][1];
  output.discovery(flag.label, flag.name, {
    'flag function': fnName,
    'occurrences': matches.length,
    'expected': flag.expected,
    'direction': 'disable'
  });

  if (matches.length !== flag.expected) {
    output.info(`Note: expected ${flag.expected} occurrences of ${flag.name}, found ${matches.length}`);
  }

  content = content.replace(pattern, () => '!1');
  totalPatched += matches.length;
  for (const m of matches) output.modification(`${flag.label} (${flag.name})`, m[0], '!1');
}

const flagCount = enableFlags.length + disableFlags.length;

if (dryRun) {
  output.result('dry_run', `All ${flagCount} flags found (${totalPatched} total replacements)`);
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Toggled ${flagCount} feature flags (${totalPatched} replacements) in ${targetPath}`);
  output.info('Enabled: edit minimal anchor · Disabled: cron tool family');
  output.info('Restart Claude Code to apply changes.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

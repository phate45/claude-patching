#!/usr/bin/env node
/**
 * Patch to inject env-var-based feature flag overrides.
 *
 * The GrowthBook flag system has an env-override map that is only populated
 * for Anthropic-internal users. This patch un-gates it and populates it from
 * an env var on first access, giving runtime control over any feature flag
 * without recompilation.
 *
 * Usage:
 *   CLAUDE_CODE_FLAG_OVERRIDES='{"tengu_kairos_cron":true}' claude
 *   CLAUDE_INTERNAL_FC_OVERRIDES='{"tengu_kairos_cron":true}' claude   (CC-native name)
 *
 * The JSON object maps flag names to values. Flags not in the map fall
 * through to GrowthBook as normal. Invalid JSON is silently ignored.
 *
 * 2.1.272 change (full DCE collapse):
 * The override getter is a METHOD on the GrowthBook client class,
 * `getEnvironmentOverrides()`. In public builds its Anthropic-internal parse
 * (gated behind `USER_TYPE==="ant"`) constant-folds away entirely — by 2.1.272
 * the whole method has DCE'd down to a bare:
 *
 *   getEnvironmentOverrides(){return null}
 *
 * (2.1.246 still carried the dead `this.environmentOverridesParsed` guard/cache
 * tail; that's gone now.) We replace the body with our own JSON parse honoring
 * both env var names and returning the parsed map (or null). The native map
 * feeds `hasEnvironmentOverride(e){…return n!==null&&e in n}`, so a plain
 * `{flag:value}` object is exactly the right shape. No `this.`-fields remain to
 * capture — the method is self-contained.
 *
 * Patch invocation:
 *   node patch-flag-env-override.js <cli.js path>
 *   node patch-flag-env-override.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-flag-env-override.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Match the fully-DCE'd override getter method:
//   getEnvironmentOverrides(){return null}
const pattern = /getEnvironmentOverrides\(\)\{return null\}/;
const match = content.match(pattern);

if (!match) {
  output.error('Could not find flag override getter function', [
    'Expected: getEnvironmentOverrides(){return null}',
    'The GrowthBook override map getter may have changed structure'
  ]);
  process.exit(1);
}

const [original] = match;

output.discovery('flag override getter', 'getEnvironmentOverrides', {
  'env vars': 'CLAUDE_CODE_FLAG_OVERRIDES, CLAUDE_INTERNAL_FC_OVERRIDES'
});

// Parse the env var into the override map on each call, return it (or null).
// hasEnvironmentOverride reads `n!==null&&e in n`, so a plain object is the
// right shape. try/catch silently ignores bad JSON — flags fall through.
const replacement = `getEnvironmentOverrides(){try{let _e=process.env.CLAUDE_CODE_FLAG_OVERRIDES||process.env.CLAUDE_INTERNAL_FC_OVERRIDES;if(_e)return JSON.parse(_e)}catch{}return null}`;

output.modification('flag override getter', original.slice(0, 80) + '…', replacement.slice(0, 80) + '…');

if (dryRun) {
  output.result('dry_run', 'Flag override getter found — ready to patch');
  process.exit(0);
}

content = content.replace(original, () => replacement);

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Patched flag override getter (getEnvironmentOverrides) in ${targetPath}`);
  output.info('Set CLAUDE_CODE_FLAG_OVERRIDES=\'{"flag_name":value}\' to override any feature flag');
  output.info('Example: CLAUDE_CODE_FLAG_OVERRIDES=\'{"tengu_kairos_cron":true}\' claude');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

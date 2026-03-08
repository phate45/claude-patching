#!/usr/bin/env node
/**
 * Patch to inject env-var-based feature flag overrides.
 *
 * The GrowthBook flag system has an unused override map (always null).
 * This patch populates it from CLAUDE_CODE_FLAG_OVERRIDES on first access,
 * giving runtime control over any feature flag without recompilation.
 *
 * Usage:
 *   CLAUDE_CODE_FLAG_OVERRIDES='{"tengu_kairos_cron":true}' claude
 *
 * The JSON object maps flag names to values. Flags not in the map fall
 * through to GrowthBook as normal. Invalid JSON is silently ignored.
 *
 * Patch invocation:
 *   node patch-flag-env-override.js <cli.js path>
 *   node patch-flag-env-override.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../lib/output');

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

// Match the unique override-map getter:
//   function X(){if(!Y)Y=!0;return Z}
// X = getter fn, Y = init guard, Z = override map (always null without patch)
const pattern = /function ([\w$]+)\(\)\{if\(!([\w$]+)\)\2=!0;return ([\w$]+)\}/;
const match = content.match(pattern);

if (!match) {
  output.error('Could not find flag override getter function', [
    'Expected: function X(){if(!Y)Y=!0;return Z}',
    'The GrowthBook override map getter may have changed structure'
  ]);
  process.exit(1);
}

const [original, fnName, guardVar, mapVar] = match;

output.discovery('flag override getter', fnName, {
  'guard variable': guardVar,
  'map variable': mapVar,
  'env var': 'CLAUDE_CODE_FLAG_OVERRIDES'
});

// Inject env var parsing on first init. The guard (Y) ensures this runs once.
// try/catch silently ignores bad JSON — flags fall through to GrowthBook.
const replacement = `function ${fnName}(){if(!${guardVar}){${guardVar}=!0;try{let _e=process.env.CLAUDE_CODE_FLAG_OVERRIDES;if(_e)${mapVar}=JSON.parse(_e)}catch{}}return ${mapVar}}`;

output.modification('flag override getter', original, replacement);

if (dryRun) {
  output.result('dry_run', 'Flag override getter found — ready to patch');
  process.exit(0);
}

content = content.replace(original, replacement);

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Patched flag override getter (${fnName}) in ${targetPath}`);
  output.info('Set CLAUDE_CODE_FLAG_OVERRIDES=\'{"flag_name":value}\' to override any feature flag');
  output.info('Example: CLAUDE_CODE_FLAG_OVERRIDES=\'{"tengu_kairos_cron":true}\' claude');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

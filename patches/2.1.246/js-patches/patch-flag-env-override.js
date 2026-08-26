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
 * 2.1.246 change (class-ification):
 * The override getter is now a METHOD on the GrowthBook client class (`Cd`),
 * `getEnvironmentOverrides()`, using `this.`-prefixed fields instead of closure
 * vars. It keeps the same dead-code shape: CC ships its own env-override parse
 * (reading `CLAUDE_INTERNAL_FC_OVERRIDES` via `this.deps.readEnvironmentOverrides()`),
 * but it is gated behind `USER_TYPE==="ant"`, which constant-folds to false in
 * public builds — DCE'd down to an early return that hands back the null map:
 *
 *   getEnvironmentOverrides(){if(this.environmentOverridesParsed)return this.environmentOverrides;
 *     return this.environmentOverridesParsed=!0,this.environmentOverrides; <dead parse…>}
 *                             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ always the null map
 *
 * We replace the dead early-return with a guard-flip + our own JSON parse
 * (honoring both env var names), then `return this.environmentOverrides`. The
 * native map feeds `hasEnvironmentOverride(e){…return t!==null&&e in t}`, so a
 * plain `{flag:value}` object is exactly the right shape. The original parse
 * tail stays as harmless unreachable dead code.
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

// Match the dead-code override getter method:
//   getEnvironmentOverrides(){if(this.Y)return this.Z;return this.Y=!0,this.Z;
// Y = parsed guard, Z = override map (null in public build)
const pattern = /getEnvironmentOverrides\(\)\{if\(this\.([\w$]+)\)return this\.([\w$]+);return this\.\1=!0,this\.\2;/;
const match = content.match(pattern);

if (!match) {
  output.error('Could not find flag override getter function', [
    'Expected: getEnvironmentOverrides(){if(this.Y)return this.Z;return this.Y=!0,this.Z;',
    'The GrowthBook override map getter may have changed structure'
  ]);
  process.exit(1);
}

const [original, guardVar, mapVar] = match;

output.discovery('flag override getter', 'getEnvironmentOverrides', {
  'guard variable': `this.${guardVar}`,
  'map variable': `this.${mapVar}`,
  'env vars': 'CLAUDE_CODE_FLAG_OVERRIDES, CLAUDE_INTERNAL_FC_OVERRIDES'
});

// Flip the guard once, parse env var into the map, return it. The original
// dead parse tail after this point stays unreachable and harmless.
// try/catch silently ignores bad JSON — flags fall through to GrowthBook.
const replacement = `getEnvironmentOverrides(){if(this.${guardVar})return this.${mapVar};this.${guardVar}=!0;try{let _e=process.env.CLAUDE_CODE_FLAG_OVERRIDES||process.env.CLAUDE_INTERNAL_FC_OVERRIDES;if(_e)this.${mapVar}=JSON.parse(_e)}catch{}return this.${mapVar};`;

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

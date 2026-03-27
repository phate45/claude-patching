/**
 * patch-disable-claude-api-skill.js
 *
 * Disables the bundled "claude-api" skill registration.
 * The skill injects SDK/API documentation into the system prompt
 * and triggers proactively on `anthropic` imports — noisy for
 * projects that don't use the Anthropic SDK.
 *
 * Approach: replace the registration function body with a no-op.
 *
 * Note: In 2.1.85 the registration helper changed from z7 to NA.
 * This version generalizes the helper name to [$\w]+ for robustness.
 */

const fs = require('fs');
const output = require('../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

const source = fs.readFileSync(targetPath, 'utf-8');

// Match: function FNAME(){REGISTRAR({name:"claude-api", ... })}
// The name:"claude-api" string is stable across versions.
// REGISTRAR was z7 through 2.1.84, became NA in 2.1.85 — match any identifier.
const pattern = /function ([$\w]+)\(\)\{[$\w]+\(\{name:"claude-api",description:"[^"]*",allowedTools:\[[^\]]*\],userInvocable:!0,async getPromptForCommand\([$\w]+\)\{[^}]*return\[\{type:"text",text:[$\w]+\([$\w]+,[$\w]+\)\}\]\}\}\)\}/;

const match = source.match(pattern);
if (!match) {
  output.error('Could not find claude-api skill registration function');
  process.exit(1);
}

const funcName = match[1];
const original = match[0];
const replacement = `function ${funcName}(){}`;

if (source.indexOf(replacement) !== -1 && source.indexOf(original) === -1) {
  output.warning('disable-claude-api-skill: already patched');
  process.exit(0);
}

const patched = source.replace(original, replacement);

if (patched === source) {
  output.error('Replacement had no effect');
  process.exit(1);
}

if (!dryRun) {
  fs.writeFileSync(targetPath, patched);
}

output.result(dryRun ? 'dry_run' : 'applied', `Disabled claude-api skill (nop'd ${funcName})`);

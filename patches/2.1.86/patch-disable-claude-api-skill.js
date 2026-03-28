/**
 * patch-disable-claude-api-skill.js
 *
 * Disables the bundled "claude-api" skill registration.
 * The skill injects SDK/API documentation into the system prompt
 * and triggers proactively on `anthropic` imports — noisy for
 * projects that don't use the Anthropic SDK.
 *
 * Approach: find the registration function by its unique `name:"claude-api"`
 * marker, use brace-counting to extract the full function body, then
 * replace with a no-op.
 *
 * 2.1.86 change: getPromptForCommand body grew a second await and a 3-arg
 * call. Switched from rigid regex to brace-counting for robustness.
 */

const fs = require('fs');
const output = require('../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

const source = fs.readFileSync(targetPath, 'utf-8');

// Step 1: Locate the unique marker
const marker = 'name:"claude-api"';
const markerIdx = source.indexOf(marker);

if (markerIdx === -1) {
  output.error('Could not find claude-api skill registration function', [
    `Searched for: ${marker}`,
    'The skill registration may have been restructured or removed',
  ]);
  process.exit(1);
}

// Step 2: Walk backward to find "function X(){"
const searchStart = Math.max(0, markerIdx - 200); // registration is close
const before = source.lastIndexOf('function ', markerIdx);

if (before < searchStart) {
  output.error('Could not find function head before claude-api marker', [
    `Marker at offset ${markerIdx}, nearest "function " at ${before}`,
  ]);
  process.exit(1);
}

const headMatch = source.slice(before).match(/^function ([$\w]+)\(\)\{/);
if (!headMatch) {
  output.error('Could not parse function signature', [
    `At offset ${before}: ${source.slice(before, before + 40)}...`,
  ]);
  process.exit(1);
}

const funcName = headMatch[1];
const funcStart = before;

// Step 3: Brace-counting to find the matching closing }
const openBrace = source.indexOf('{', funcStart);
let depth = 0;
let i = openBrace;
for (; i < source.length; i++) {
  if (source[i] === '{') depth++;
  else if (source[i] === '}') {
    depth--;
    if (depth === 0) break;
  }
}

if (depth !== 0) {
  output.error('Brace counting failed — unbalanced braces in function', [
    `Function: ${funcName}, started at offset ${funcStart}`,
  ]);
  process.exit(1);
}

const funcEnd = i + 1;
const original = source.slice(funcStart, funcEnd);
const replacement = `function ${funcName}(){}`;

// Check for already-patched
if (source.indexOf(replacement) !== -1 && source.indexOf(original) === -1) {
  output.warning('disable-claude-api-skill: already patched');
  process.exit(0);
}

output.discovery('claude-api skill registration', funcName + '()', {
  'body length': original.length,
});
output.modification('claude-api skill', original.slice(0, 60) + '...', replacement);

if (dryRun) {
  output.result('dry_run', `Disabled claude-api skill (nop'd ${funcName})`);
  process.exit(0);
}

const patched = source.replace(original, replacement);

if (patched === source) {
  output.error('Replacement had no effect');
  process.exit(1);
}

fs.writeFileSync(targetPath, patched);
output.result('success', `Disabled claude-api skill (nop'd ${funcName})`);

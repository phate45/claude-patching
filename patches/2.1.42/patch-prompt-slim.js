#!/usr/bin/env node
/**
 * System prompt slimming patch (common — works on both bare and native)
 *
 * Applies find/replace patches from the prompt-patching repo to reduce
 * system prompt token overhead. Reads patch files from:
 *   /tmp/prompt-patching/system-prompt/<version>/patches/
 *
 * Requires `node claude-patching.js --setup` to clone the repo first.
 *
 * The regex engine (createRegexPatch) is adapted from the upstream
 * patch-cli.js. The logic hash is checked at runtime to detect upstream
 * changes that may need review.
 *
 * Usage:
 *   node patch-prompt-slim.js <cli.js path>
 *   node patch-prompt-slim.js --check <cli.js path>
 */

const fs = require('fs');
const path = require('path');
const output = require('../../lib/output');
const { extractVersion } = require('../../lib/shared');
const { parsePatchList, hashPatchLogic, PROMPT_REPO } = require('../../lib/prompt-baseline');

// Logic hash of the upstream createRegexPatch() we adapted from.
// If upstream changes, this will mismatch and warn.
const EXPECTED_LOGIC_HASH = '6fa91149dddcf76b56c39159aeb75692';

// Unicode characters that native (Bun) builds escape differently
const UNICODE_ESCAPES = [
  ['\u2014', '\\u2014'],  // em-dash
  ['\u2192', '\\u2192'],  // arrow
  ['\u2013', '\\u2013'],  // en-dash
  ['\u201c', '\\u201c'],  // left double quote
  ['\u201d', '\\u201d'],  // right double quote
  ['\u2018', '\\u2018'],  // left single quote
  ['\u2019', '\\u2019'],  // right single quote
  ['\u2026', '\\u2026'],  // ellipsis
];

function toNativeEscapes(str) {
  let result = str;
  for (const [char, escape] of UNICODE_ESCAPES) {
    result = result.split(char).join(escape);
  }
  return result;
}

// ============================================================
// Regex engine — adapted from upstream patch-cli.js
// ============================================================

function createRegexPatch(find, replace) {
  const varRegex = /\$\{[a-zA-Z0-9_.$]+(?:\([a-zA-Z0-9_.$]*\)(?:\/\d+)?)?\}/g;
  const identRegex = /__[A-Z0-9_]+__/g;

  const placeholders = [];
  const seenPlaceholders = new Set();

  let match;
  while ((match = varRegex.exec(find)) !== null) {
    if (!seenPlaceholders.has(match[0])) {
      seenPlaceholders.add(match[0]);
      placeholders.push({ text: match[0], type: 'var' });
    }
  }

  while ((match = identRegex.exec(find)) !== null) {
    if (!seenPlaceholders.has(match[0])) {
      seenPlaceholders.add(match[0]);
      placeholders.push({ text: match[0], type: 'ident' });
    }
  }

  if (placeholders.length === 0) return null;

  let regexStr = find;
  regexStr = regexStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const p of placeholders) {
    const escaped = p.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const capture = p.type === 'var'
      ? '(\\$\\{[a-zA-Z0-9_.$]+(?:\\([a-zA-Z0-9_.$]*\\)(?:\\/\\d+)?)?\\})'
      : '([a-zA-Z0-9_$]+)';
    regexStr = regexStr.split(escaped).join(capture);
  }

  let replaceStr = replace;
  for (let i = 0; i < placeholders.length; i++) {
    replaceStr = replaceStr.split(placeholders[i].text).join(`$${i + 1}`);
  }

  return { regex: new RegExp(regexStr), replace: replaceStr, varCount: placeholders.length };
}

// ============================================================
// Patch loading
// ============================================================

function loadPatchPair(version, fileId) {
  const patchesDir = path.join(PROMPT_REPO, version, 'patches');
  const findPath = path.join(patchesDir, `${fileId}.find.txt`);
  const replacePath = path.join(patchesDir, `${fileId}.replace.txt`);

  if (!fs.existsSync(findPath)) return null;

  const find = fs.readFileSync(findPath, 'utf8');
  const replace = fs.existsSync(replacePath) ? fs.readFileSync(replacePath, 'utf8') : '';

  return { find, replace };
}

// ============================================================
// Main
// ============================================================

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-prompt-slim.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

const version = extractVersion(content);
if (!version) {
  output.error('Could not detect Claude Code version from target file');
  process.exit(1);
}

// Check repo availability
const versionDir = path.join(PROMPT_REPO, version);
if (!fs.existsSync(versionDir)) {
  output.error(`No prompt patches for v${version}`, [
    `Expected: ${versionDir}`,
    'Run --setup to update the prompt-patching repo',
  ]);
  process.exit(1);
}

// Check logic hash
const currentHash = hashPatchLogic(version);
if (currentHash && currentHash !== EXPECTED_LOGIC_HASH) {
  output.warning('Upstream patch-cli.js logic has changed', [
    `Expected: ${EXPECTED_LOGIC_HASH}`,
    `Got:      ${currentHash}`,
    'The regex engine may have been updated — review before trusting results.',
  ]);
}

// Load patch list
let patches;
try {
  patches = parsePatchList(version);
} catch (err) {
  output.error('Failed to parse patch list', [err.message]);
  process.exit(1);
}

// Apply patches
let appliedCount = 0;
let skippedCount = 0;
let totalSaved = 0;
const results = [];

for (const { name, file } of patches) {
  const pair = loadPatchPair(version, file);
  if (!pair) {
    results.push({ name, file, status: 'skip', reason: 'files not found' });
    skippedCount++;
    continue;
  }

  const { find, replace } = pair;

  // Build regex and native variants
  const regexPatch = createRegexPatch(find, replace);
  const findNative = toNativeEscapes(find);
  const replaceNative = toNativeEscapes(replace);
  const regexPatchNative = (findNative !== find) ? createRegexPatch(findNative, replaceNative) : null;

  let applied = false;
  let method = '';

  // Always apply in memory (even dry run) so chained patches can find v1 output
  if (regexPatch) {
    if (regexPatch.regex.test(content)) {
      content = content.replace(regexPatch.regex, regexPatch.replace);
      method = `regex, ${regexPatch.varCount} vars`;
      applied = true;
    } else if (regexPatchNative && regexPatchNative.regex.test(content)) {
      content = content.replace(regexPatchNative.regex, regexPatchNative.replace);
      method = `regex+native, ${regexPatchNative.varCount} vars`;
      applied = true;
    }
  } else if (content.includes(find)) {
    content = content.replace(find, replace);
    method = 'string';
    applied = true;
  } else if (findNative !== find && content.includes(findNative)) {
    content = content.replace(findNative, replaceNative);
    method = 'string+native';
    applied = true;
  }

  if (applied) {
    const saved = find.length - replace.length;
    totalSaved += saved;
    appliedCount++;
    results.push({ name, file, status: 'ok', method, saved });
  } else {
    skippedCount++;
    results.push({ name, file, status: 'skip', reason: 'pattern not found' });
  }
}

// Write if not dry run
if (!dryRun && appliedCount > 0) {
  fs.writeFileSync(targetPath, content);
}

// Output
const mode = dryRun ? 'check' : 'apply';
const skipped = results.filter(r => r.status === 'skip');

if (appliedCount === 0) {
  output.error(`prompt-slim: No patches matched (v${version}, ${patches.length} patches)`, [
    'System prompt text may have changed in this version',
    ...skipped.slice(0, 5).map(s => `  ${s.file}: ${s.reason}`),
  ]);
  process.exit(1);
}

const summary = `prompt-slim (v${version}): ${appliedCount}/${patches.length} patches, ~${totalSaved.toLocaleString()} chars saved`;

if (skippedCount > 0) {
  output.warning(`${skippedCount} prompt patches skipped`, skipped.map(s => `${s.file}: ${s.reason}`));
}

output.result(dryRun ? 'dry_run' : 'success', summary);

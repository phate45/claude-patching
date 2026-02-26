#!/usr/bin/env node
/**
 * System prompt slimming patch (common — works on both bare and native)
 *
 * Applies find/replace patches to reduce system prompt token overhead.
 * Reads patch files with local-first resolution:
 *   1. patches/<version>/prompt-patches/  (local, persists across restarts)
 *   2. /tmp/prompt-patching/system-prompt/<version>/patches/  (upstream fallback)
 *
 * Local patches are created by `node claude-patching.js --init`.
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
const {
  parsePatchList, hashPatchLogic, hasLocalPromptPatches, localPromptDir,
  PROMPT_REPO,
} = require('../../lib/prompt-baseline');

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
// Diagnostics — run on patch failures to classify the cause
// ============================================================

/**
 * Build a regex from a find string (for matching only, no replace needed).
 * Returns a RegExp or null if no placeholders.
 */
function buildFindRegex(find) {
  const result = createRegexPatch(find, '');
  return result ? result.regex : null;
}

/**
 * Test whether a find string (with placeholders) matches a bundle.
 */
function testFind(find, bundle) {
  const regex = buildFindRegex(find);
  return regex ? regex.test(bundle) : bundle.includes(find);
}

/**
 * Diagnose why a patch failed to match.
 *
 * @param {string} find - The patch find text
 * @param {string} content - Current (modified) bundle content
 * @param {string} original - Original (unpatched) bundle content
 * @param {Array} appliedPatches - List of {name, file, find} for previously applied patches
 * @returns {{ reason: string, details: object }}
 */
function diagnoseFailure(find, content, original, appliedPatches) {
  const findNative = toNativeEscapes(find);

  // 1. Chained casualty: matches original but not current content
  if (testFind(find, original) || (findNative !== find && testFind(findNative, original))) {
    // Find which earlier patch consumed the text
    let consumedBy = null;
    for (const prev of appliedPatches) {
      if (prev.find.includes(find.slice(0, Math.min(60, find.length)))) {
        consumedBy = prev.file;
        break;
      }
    }
    return {
      reason: 'chained',
      details: { consumed_by: consumedBy || 'unknown earlier patch' },
    };
  }

  // 2. Regex-aware divergence finder
  const lines = find.split('\n');
  let lastGoodLine = 0;

  for (let i = 1; i <= lines.length; i++) {
    const partial = lines.slice(0, i).join('\n');
    if (testFind(partial, original)) {
      lastGoodLine = i;
    } else {
      break;
    }
  }

  if (lastGoodLine > 0 && lastGoodLine < lines.length) {
    // Char-level binary search within the failing line
    const prefix = lines.slice(0, lastGoodLine).join('\n') + '\n';
    const failLine = lines[lastGoodLine];
    let lo = 0, hi = failLine.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      const partial = prefix + failLine.slice(0, mid);
      testFind(partial, original) ? lo = mid : hi = mid - 1;
    }

    const totalMatched = prefix.length + lo;
    const matchPct = Math.round(totalMatched / find.length * 100);
    const patchCtx = failLine.slice(Math.max(0, lo - 30), lo + 40);

    // Extract bundle context at the divergence point
    let bundleCtx = '';
    const matchStr = prefix + failLine.slice(0, lo);
    const regex = buildFindRegex(matchStr);
    if (regex) {
      const m = regex.exec(original);
      if (m) {
        const end = m.index + m[0].length;
        bundleCtx = original.slice(end - 30, end + 40);
      }
    } else {
      const idx = original.indexOf(matchStr);
      if (idx !== -1) {
        const end = idx + matchStr.length;
        bundleCtx = original.slice(end - 30, end + 40);
      }
    }

    return {
      reason: 'diverged',
      details: {
        match_pct: matchPct,
        line: `${lastGoodLine + 1}/${lines.length}`,
        patch_ctx: patchCtx,
        bundle_ctx: bundleCtx,
      },
    };
  }

  // 3. lastGoodLine === 0 — even line 1 fails. Do char-level search on line 1.
  if (lines.length > 0) {
    const line1 = lines[0];
    let lo = 0, hi = line1.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      testFind(line1.slice(0, mid), original) ? lo = mid : hi = mid - 1;
    }

    if (lo > 5) {
      // Partial match — text diverged on line 1
      const patchCtx = line1.slice(Math.max(0, lo - 30), lo + 40);
      let bundleCtx = '';
      const partial = line1.slice(0, lo);
      const idx = original.indexOf(partial);
      if (idx !== -1) {
        bundleCtx = original.slice(idx + lo - 30, idx + lo + 40);
      }
      return {
        reason: 'diverged',
        details: {
          match_pct: Math.round(lo / find.length * 100),
          line: `1/${lines.length}`,
          patch_ctx: patchCtx,
          bundle_ctx: bundleCtx,
        },
      };
    }
  }

  // No meaningful match at all — section likely removed or relocated
  return {
    reason: 'not found',
    details: { hint: 'Section may be removed or heavily rewritten' },
  };
}

// ============================================================
// Patch loading — local-first, upstream fallback
// ============================================================

function loadPatchPair(version, fileId) {
  // 1. Local
  const localDir = localPromptDir(version);
  const localFind = path.join(localDir, `${fileId}.find.txt`);
  if (fs.existsSync(localFind)) {
    const localReplace = path.join(localDir, `${fileId}.replace.txt`);
    const find = fs.readFileSync(localFind, 'utf8');
    const replace = fs.existsSync(localReplace) ? fs.readFileSync(localReplace, 'utf8') : '';
    return { find, replace };
  }

  // 2. Upstream
  const upstreamDir = path.join(PROMPT_REPO, version, 'patches');
  const findPath = path.join(upstreamDir, `${fileId}.find.txt`);
  if (!fs.existsSync(findPath)) return null;

  const replacePath = path.join(upstreamDir, `${fileId}.replace.txt`);
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

// Check patch availability (local first, upstream fallback)
const hasLocal = hasLocalPromptPatches(version);
const hasUpstream = fs.existsSync(path.join(PROMPT_REPO, version));

if (!hasLocal && !hasUpstream) {
  output.error(`No prompt patches for v${version}`, [
    `Checked local: ${localPromptDir(version)}`,
    `Checked upstream: ${path.join(PROMPT_REPO, version)}`,
    'Run --init to import prompt patches, or --setup to update the upstream repo',
  ]);
  process.exit(1);
}

// Check logic hash (only meaningful when using upstream patches)
if (!hasLocal) {
  const currentHash = hashPatchLogic(version);
  if (currentHash && currentHash !== EXPECTED_LOGIC_HASH) {
    output.warning('Upstream patch-cli.js logic has changed', [
      `Expected: ${EXPECTED_LOGIC_HASH}`,
      `Got:      ${currentHash}`,
      'The regex engine may have been updated — review before trusting results.',
    ]);
  }
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
const originalContent = content;  // snapshot before any modifications
let appliedCount = 0;
let skippedCount = 0;
let totalSaved = 0;
const results = [];
const appliedPatchFinds = [];  // track applied patches for chained casualty detection

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
    appliedPatchFinds.push({ name, file, find });
    results.push({ name, file, status: 'ok', method, saved });
  } else {
    skippedCount++;
    const diag = diagnoseFailure(find, content, originalContent, appliedPatchFinds);
    results.push({ name, file, status: 'skip', reason: diag.reason, diag: diag.details });
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
  const skipDetails = skipped.map(s => {
    let line = `${s.file}: ${s.reason}`;
    if (s.diag) {
      if (s.reason === 'chained') {
        line += ` (consumed by ${s.diag.consumed_by})`;
      } else if (s.reason === 'diverged') {
        line += ` (${s.diag.match_pct}% match, line ${s.diag.line})`;
        line += `\n    patch: ${s.diag.patch_ctx}`;
        line += `\n    bundle: ${s.diag.bundle_ctx}`;
      } else if (s.reason === 'not found') {
        line += ` — ${s.diag.hint}`;
      }
    }
    return line;
  });
  output.warning(`${skippedCount} prompt patches skipped`, skipDetails);
}

output.result(dryRun ? 'dry_run' : 'success', summary);

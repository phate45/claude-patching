/**
 * Prompt baseline generator
 *
 * Reads the prompt-patching/system-prompt repo and generates:
 *   - baseline-find.txt:    All .find.txt patches concatenated (original prompt sections)
 *   - baseline-replace.txt: All .replace.txt patches concatenated (slimmed replacements)
 *   - diff to previous version's baseline (if it exists)
 *
 * Usage:
 *   node lib/prompt-baseline.js <version>              # Generate baseline for version
 *   node lib/prompt-baseline.js <version> --diff        # Also generate diff to previous
 *   node lib/prompt-baseline.js <version> --diff=2.1.39 # Diff against specific version
 *   node lib/prompt-baseline.js --list                  # List available versions
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============ Config ============

const PROMPT_REPO = '/tmp/prompt-patching/system-prompt';
const PATCHES_DIR = path.join(__dirname, '..', 'patches');

// ============ Helpers ============

/**
 * Parse the patch list from a version's patch-cli.js.
 * Extracts the ordered array of { name, file } objects from the `const patches = [...]` block.
 */
function parsePatchList(version) {
  const patchCliPath = path.join(PROMPT_REPO, version, 'patch-cli.js');
  if (!fs.existsSync(patchCliPath)) {
    throw new Error(`No patch-cli.js found for version ${version} at ${patchCliPath}`);
  }

  const content = fs.readFileSync(patchCliPath, 'utf8');

  // Extract the patches array — starts with `const patches = [` and ends with `];`
  const arrayMatch = content.match(/const patches\s*=\s*\[([\s\S]*?)\];/);
  if (!arrayMatch) {
    throw new Error(`Could not find patches array in ${patchCliPath}`);
  }

  const arrayBody = arrayMatch[1];

  // Extract each { name: '...', file: '...' } entry
  const entries = [];
  const entryRe = /\{\s*name:\s*'([^']*)',\s*file:\s*'([^']*)'\s*\}/g;
  let match;
  while ((match = entryRe.exec(arrayBody)) !== null) {
    entries.push({ name: match[1], file: match[2] });
  }

  return entries;
}

/**
 * Read a patch file pair (.find.txt / .replace.txt) for a given version and patch file id.
 */
function readPatchPair(version, fileId) {
  const patchesDir = path.join(PROMPT_REPO, version, 'patches');
  const findPath = path.join(patchesDir, `${fileId}.find.txt`);
  const replacePath = path.join(patchesDir, `${fileId}.replace.txt`);

  const find = fs.existsSync(findPath) ? fs.readFileSync(findPath, 'utf8') : null;
  const replace = fs.existsSync(replacePath) ? fs.readFileSync(replacePath, 'utf8') : null;

  return { find, replace };
}

/**
 * Get sorted list of available versions in the repo.
 */
function listVersions() {
  if (!fs.existsSync(PROMPT_REPO)) {
    throw new Error(`Prompt patching repo not found at ${PROMPT_REPO}`);
  }

  return fs.readdirSync(PROMPT_REPO)
    .filter(d => /^\d+\.\d+\.\d+$/.test(d))
    .filter(d => fs.statSync(path.join(PROMPT_REPO, d)).isDirectory())
    .sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] - pb[i];
      }
      return 0;
    });
}

/**
 * Find the version immediately before the given one.
 */
function previousVersion(version) {
  const versions = listVersions();
  const idx = versions.indexOf(version);
  if (idx <= 0) return null;
  return versions[idx - 1];
}

// ============ Logic Hash ============

/**
 * Hash the logic portion of patch-cli.js (stripping version-specific config).
 * Strips: EXPECTED_VERSION, EXPECTED_HASHES block, and the patches[] array.
 * What remains is the regex engine, file discovery, application loop, etc.
 */
function hashPatchLogic(version) {
  const patchCliPath = path.join(PROMPT_REPO, version, 'patch-cli.js');
  if (!fs.existsSync(patchCliPath)) return null;

  let content = fs.readFileSync(patchCliPath, 'utf8');

  // Strip version string
  content = content.replace(/const EXPECTED_VERSION\s*=\s*'[^']*';/, '');

  // Strip hash block: from `const EXPECTED_HASHES = {` through `};`
  content = content.replace(/const EXPECTED_HASHES\s*=\s*\{[\s\S]*?\};/, '');

  // Strip patches array: from `const patches = [` through `];`
  content = content.replace(/const patches\s*=\s*\[[\s\S]*?\];/, '');

  // Strip unicode escapes array (also version-flavored config)
  content = content.replace(/const UNICODE_ESCAPES\s*=\s*\[[\s\S]*?\];/, '');

  // Collapse whitespace for stability
  content = content.replace(/\s+/g, ' ').trim();

  const crypto = require('crypto');
  return crypto.createHash('md5').update(content).digest('hex');
}

// ============ Baseline Generation ============

/**
 * Generate baseline files for a version.
 * Returns { findText, replaceText, patches, outputDir }.
 */
function generateBaseline(version) {
  const patches = parsePatchList(version);
  if (patches.length === 0) {
    throw new Error(`No patches found for version ${version}`);
  }

  const separator = (id, name) =>
    `${'='.repeat(70)}\n## ${id}\n## ${name}\n${'='.repeat(70)}\n`;

  let findText = '';
  let replaceText = '';
  let totalFindChars = 0;
  let totalReplaceChars = 0;
  const stats = [];

  for (const { name, file } of patches) {
    const { find, replace } = readPatchPair(version, file);

    if (find === null || replace === null) {
      const missing = find === null ? 'find' : 'replace';
      console.warn(`  WARN: Missing ${missing} file for "${file}" — skipping`);
      continue;
    }

    const findLen = find.length;
    const replaceLen = replace.length;
    const savings = findLen - replaceLen;

    findText += separator(file, name) + find + '\n\n';
    replaceText += separator(file, name) + (replace || '[DELETED]') + '\n\n';

    totalFindChars += findLen;
    totalReplaceChars += replaceLen;
    stats.push({ id: file, name, findLen, replaceLen, savings });
  }

  // Write output
  const outputDir = path.join(PATCHES_DIR, version);
  fs.mkdirSync(outputDir, { recursive: true });

  fs.writeFileSync(path.join(outputDir, 'baseline-find.txt'), findText);
  fs.writeFileSync(path.join(outputDir, 'baseline-replace.txt'), replaceText);

  // Compute logic hash
  const logicHash = hashPatchLogic(version);

  // Write stats summary
  const statsLines = [
    `# Prompt Patch Baseline — v${version}`,
    `# Generated: ${new Date().toISOString()}`,
    `# Logic hash: ${logicHash}`,
    `# Patches: ${stats.length}`,
    `# Original size (find): ${totalFindChars.toLocaleString()} chars`,
    `# Replaced size:        ${totalReplaceChars.toLocaleString()} chars`,
    `# Total savings:        ${(totalFindChars - totalReplaceChars).toLocaleString()} chars (${Math.round((1 - totalReplaceChars / totalFindChars) * 100)}%)`,
    '',
    'Patch ID'.padEnd(35) + 'Find'.padStart(8) + 'Replace'.padStart(10) + 'Savings'.padStart(10),
    '-'.repeat(63),
    ...stats.map(s =>
      s.id.padEnd(35) +
      s.findLen.toLocaleString().padStart(8) +
      s.replaceLen.toLocaleString().padStart(10) +
      s.savings.toLocaleString().padStart(10)
    ),
    '-'.repeat(63),
    'TOTAL'.padEnd(35) +
      totalFindChars.toLocaleString().padStart(8) +
      totalReplaceChars.toLocaleString().padStart(10) +
      (totalFindChars - totalReplaceChars).toLocaleString().padStart(10),
  ];
  fs.writeFileSync(path.join(outputDir, 'stats.txt'), statsLines.join('\n') + '\n');

  return { findText, replaceText, patches: stats, outputDir, totalFindChars, totalReplaceChars };
}

// ============ Diff Generation ============

/**
 * Generate a diff between two version baselines.
 * Both must already have baselines generated.
 */
function generateDiff(oldVersion, newVersion) {
  const oldDir = path.join(PATCHES_DIR, oldVersion);
  const newDir = path.join(PATCHES_DIR, newVersion);

  for (const dir of [oldDir, newDir]) {
    if (!fs.existsSync(path.join(dir, 'baseline-find.txt'))) {
      throw new Error(`Baseline not found in ${dir} — generate it first`);
    }
  }

  const diffOutput = [];

  for (const file of ['baseline-find.txt', 'baseline-replace.txt']) {
    const label = file.replace('baseline-', '').replace('.txt', '');
    try {
      const diff = execSync(
        `diff -u "${path.join(oldDir, file)}" "${path.join(newDir, file)}"`,
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      );
      // diff returns 0 if files are identical
      diffOutput.push(`### ${label}: no changes\n`);
    } catch (e) {
      if (e.status === 1) {
        // diff returns 1 when files differ — that's the output we want
        const header = `### ${label}: changes from ${oldVersion} → ${newVersion}\n`;
        diffOutput.push(header + e.stdout);
      } else {
        throw e;
      }
    }
  }

  // Also diff the patch lists themselves
  const oldPatches = parsePatchList(oldVersion);
  const newPatches = parsePatchList(newVersion);

  const oldIds = new Set(oldPatches.map(p => p.file));
  const newIds = new Set(newPatches.map(p => p.file));

  const added = newPatches.filter(p => !oldIds.has(p.file));
  const removed = oldPatches.filter(p => !newIds.has(p.file));

  if (added.length || removed.length) {
    diffOutput.push('\n### Patch list changes\n');
    for (const p of added) {
      diffOutput.push(`  + ${p.file} (${p.name})`);
    }
    for (const p of removed) {
      diffOutput.push(`  - ${p.file} (${p.name})`);
    }
    diffOutput.push('');
  } else {
    diffOutput.push('\n### Patch list: identical\n');
  }

  // Compare logic hashes
  const oldHash = hashPatchLogic(oldVersion);
  const newHash = hashPatchLogic(newVersion);
  const logicChanged = oldHash !== newHash;

  if (logicChanged) {
    diffOutput.push(`### ⚠ Logic changed: ${oldHash} → ${newHash}`);
    diffOutput.push('  Review createRegexPatch() and application loop for breaking changes.\n');
  } else {
    diffOutput.push(`### Logic hash: unchanged (${newHash})\n`);
  }

  const diffText = diffOutput.join('\n');
  const diffPath = path.join(newDir, `diff-from-${oldVersion}.txt`);
  fs.writeFileSync(diffPath, diffText);

  return { diffPath, diffText, added, removed, logicChanged, oldHash, newHash };
}

// ============ CLI ============

function printUsage() {
  console.log(`Usage:
  node lib/prompt-baseline.js <version>              Generate baseline
  node lib/prompt-baseline.js <version> --diff        Diff to previous version
  node lib/prompt-baseline.js <version> --diff=X.Y.Z  Diff to specific version
  node lib/prompt-baseline.js --list                  List available versions`);
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    const versions = listVersions();
    console.log(`Available versions in ${PROMPT_REPO}:\n`);
    for (const v of versions) {
      const hasBaseline = fs.existsSync(path.join(PATCHES_DIR, v, 'baseline-find.txt'));
      console.log(`  ${v}${hasBaseline ? '  [baseline exists]' : ''}`);
    }
    return;
  }

  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const version = args[0];
  const diffArg = args.find(a => a.startsWith('--diff'));

  // Validate version exists in repo
  const versions = listVersions();
  if (!versions.includes(version)) {
    console.error(`Version ${version} not found in ${PROMPT_REPO}`);
    console.error(`Available: ${versions.join(', ')}`);
    process.exit(1);
  }

  // Generate baseline
  console.log(`Generating baseline for v${version}...`);
  const result = generateBaseline(version);
  const savings = result.totalFindChars - result.totalReplaceChars;
  console.log(`  ${result.patches.length} patches`);
  console.log(`  Original: ${result.totalFindChars.toLocaleString()} chars`);
  console.log(`  Replaced: ${result.totalReplaceChars.toLocaleString()} chars`);
  console.log(`  Savings:  ${savings.toLocaleString()} chars (${Math.round((1 - result.totalReplaceChars / result.totalFindChars) * 100)}%)`);
  console.log(`  Output:   ${result.outputDir}/`);

  // Generate diff if requested
  if (diffArg !== undefined) {
    let diffTarget;
    if (diffArg.includes('=')) {
      diffTarget = diffArg.split('=')[1];
    } else {
      diffTarget = previousVersion(version);
    }

    if (!diffTarget) {
      console.log('\n  No previous version to diff against.');
      return;
    }

    // Ensure the diff target has a baseline
    if (!fs.existsSync(path.join(PATCHES_DIR, diffTarget, 'baseline-find.txt'))) {
      console.log(`\n  Generating baseline for diff target v${diffTarget}...`);
      generateBaseline(diffTarget);
    }

    console.log(`\n  Diffing v${diffTarget} → v${version}...`);
    const diff = generateDiff(diffTarget, version);
    console.log(`  Diff:     ${diff.diffPath}`);
    if (diff.added.length) console.log(`  Added:    ${diff.added.map(p => p.file).join(', ')}`);
    if (diff.removed.length) console.log(`  Removed:  ${diff.removed.map(p => p.file).join(', ')}`);
    if (diff.logicChanged) {
      console.log(`  WARNING:  patch-cli.js logic changed! (${diff.oldHash} → ${diff.newHash})`);
      console.log(`            Review before integrating.`);
    } else {
      console.log(`  Logic:    unchanged (${diff.newHash})`);
    }
  }
}

// Export for programmatic use
module.exports = { generateBaseline, generateDiff, listVersions, previousVersion, parsePatchList, hashPatchLogic, PROMPT_REPO, PATCHES_DIR };

if (require.main === module) {
  main();
}

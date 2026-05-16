/**
 * Prompt baseline generator
 *
 * Reads prompt patches from local storage (patches/<version>/prompt-patches/).
 *
 * Generates:
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

const PATCHES_DIR = path.join(__dirname, '..', 'patches');

// ============ Helpers ============

/**
 * Compare two semver strings: returns -1 if a < b, 0 if equal, 1 if a > b
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Get the local prompt-patches directory for a version.
 */
function localPromptDir(version) {
  return path.join(PATCHES_DIR, version, 'prompt-patches');
}

/**
 * Check whether a version has local prompt patches.
 */
function hasLocalPromptPatches(version) {
  return fs.existsSync(path.join(localPromptDir(version), 'patches.json'));
}

/**
 * Parse the patch list for a version. Returns the ordered array of { name, file } objects.
 */
function parsePatchList(version) {
  const localPath = path.join(localPromptDir(version), 'patches.json');
  if (!fs.existsSync(localPath)) {
    throw new Error(`No prompt patches found for version ${version}\n  Checked: ${localPath}`);
  }
  const data = JSON.parse(fs.readFileSync(localPath, 'utf8'));
  return data.patches;
}

/**
 * Read a patch file pair (.find.txt / .replace.txt).
 */
function readPatchPair(version, fileId) {
  const dir = localPromptDir(version);
  const findPath = path.join(dir, `${fileId}.find.txt`);
  const replacePath = path.join(dir, `${fileId}.replace.txt`);

  const find = fs.existsSync(findPath) ? fs.readFileSync(findPath, 'utf8') : null;
  const replace = fs.existsSync(replacePath) ? fs.readFileSync(replacePath, 'utf8') : null;
  return { find, replace };
}

/**
 * Get sorted list of available versions from local storage.
 */
function listVersions() {
  if (!fs.existsSync(PATCHES_DIR)) return [];

  return fs.readdirSync(PATCHES_DIR)
    .filter(d => /^\d+\.\d+\.\d+$/.test(d) && hasLocalPromptPatches(d))
    .sort(compareVersions);
}

/**
 * Alias retained for callers that distinguished local vs upstream historically.
 */
const listLocalVersions = listVersions;

/**
 * Find the version immediately before the given one.
 */
function previousVersion(version) {
  const versions = listVersions();
  const idx = versions.indexOf(version);
  if (idx <= 0) return null;
  return versions[idx - 1];
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

  // Write stats summary
  const statsLines = [
    `# Prompt Patch Baseline — v${version}`,
    `# Generated: ${new Date().toISOString()}`,
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
      execSync(
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

  const diffText = diffOutput.join('\n');
  const diffPath = path.join(newDir, `diff-from-${oldVersion}.txt`);
  fs.writeFileSync(diffPath, diffText);

  return { diffPath, diffText, added, removed };
}

// ============ Import ============

/**
 * Find the best available version ≤ target from a sorted version list.
 */
function bestVersionAtMost(versions, target) {
  let best = null;
  for (const v of versions) {
    if (compareVersions(v, target) <= 0) {
      if (!best || compareVersions(v, best) > 0) best = v;
    }
  }
  return best;
}

/**
 * Import prompt patches for a target version into local storage.
 * Copies the latest existing local version ≤ target.
 *
 * @param {string} targetVersion - Version to import patches for
 * @returns {{ count: number, source: string, targetDir: string } | null}
 */
function importPromptPatches(targetVersion) {
  const targetDir = localPromptDir(targetVersion);

  // Already imported?
  if (hasLocalPromptPatches(targetVersion)) {
    const data = JSON.parse(fs.readFileSync(path.join(targetDir, 'patches.json'), 'utf8'));
    return { count: data.patches.length, source: data.source + ' (existing)', targetDir };
  }

  const sourceVersion = bestVersionAtMost(listVersions(), targetVersion);
  if (!sourceVersion) return null;

  const srcDir = localPromptDir(sourceVersion);
  const srcData = JSON.parse(fs.readFileSync(path.join(srcDir, 'patches.json'), 'utf8'));
  const patches = srcData.patches;

  fs.mkdirSync(targetDir, { recursive: true });

  let count = 0;
  for (const { file } of patches) {
    const findSrc = path.join(srcDir, `${file}.find.txt`);
    const replaceSrc = path.join(srcDir, `${file}.replace.txt`);

    if (fs.existsSync(findSrc)) {
      fs.copyFileSync(findSrc, path.join(targetDir, `${file}.find.txt`));
      count++;
    }
    if (fs.existsSync(replaceSrc)) {
      fs.copyFileSync(replaceSrc, path.join(targetDir, `${file}.replace.txt`));
    }
  }

  const source = `local:${sourceVersion}`;
  fs.writeFileSync(
    path.join(targetDir, 'patches.json'),
    JSON.stringify({ source, patches }, null, 2) + '\n'
  );

  return { count, source, targetDir };
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
    console.log('Available prompt patch versions:\n');
    for (const v of versions) {
      const hasBaseline = fs.existsSync(path.join(PATCHES_DIR, v, 'baseline-find.txt'));
      const tags = hasBaseline ? '[baseline]' : '';
      console.log(`  ${v}  ${tags}`);
    }
    return;
  }

  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const version = args[0];
  const diffArg = args.find(a => a.startsWith('--diff'));

  // Validate version exists locally
  const versions = listVersions();
  if (!versions.includes(version)) {
    console.error(`Version ${version} not found in ${PATCHES_DIR}`);
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
  }
}

// Export for programmatic use
module.exports = {
  generateBaseline, generateDiff, listVersions, listLocalVersions,
  previousVersion, parsePatchList, importPromptPatches,
  hasLocalPromptPatches, localPromptDir, compareVersions,
  PATCHES_DIR,
};

if (require.main === module) {
  main();
}

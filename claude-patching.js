#!/usr/bin/env node
/**
 * Claude Code Patching - Unified CLI
 *
 * Supports both installation types:
 *   - bare: pnpm/npm install (standalone cli.js)
 *   - native: Bun-compiled binary (~/.local/bin/claude)
 *
 * Usage:
 *   node claude-patching.js --status              # Show detected installations
 *   node claude-patching.js --setup               # Prepare patching environment
 *   node claude-patching.js --init                # Create index for installed version
 *   node claude-patching.js --check               # Dry run (auto-select if single install)
 *   node claude-patching.js --apply               # Apply patches (auto-select if single install)
 *   node claude-patching.js --native --check      # Target native install explicitly
 *   node claude-patching.js --bare --apply        # Target bare install explicitly
 *   node claude-patching.js --bare --restore      # Restore bare install from .bak
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  PATCH_MARKER,
  detectBareInstall,
  detectNativeInstall,
  detectInstalls,
  readPatchMetadata,
  writePatchMetadata,
  isPatched,
  extractVersion,
  formatBytes,
  safeStats,
} = require('./lib/shared');

// Lazy-load bun-binary.ts — it requires node-lief which may not be installed.
// Only needed for native binary operations.
let _bunBinary = null;
function getBunBinary() {
  if (!_bunBinary) {
    try {
      _bunBinary = require('./lib/bun-binary.ts');
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND' && err.message.includes('node-lief')) {
        throw new Error(
          'node-lief is required for native binary operations.\n' +
          '  Install it with: npm install\n' +
          '  (Only needed if you want to patch the native Bun binary installation)'
        );
      }
      throw err;
    }
  }
  return _bunBinary;
}
function extractClaudeJs(...args) { return getBunBinary().extractClaudeJs(...args); }
function repackWithModifiedJs(...args) { return getBunBinary().repackWithModifiedJs(...args); }

const SCRIPT_DIR = __dirname;
const PATCHES_DIR = path.join(SCRIPT_DIR, 'patches');

// JSON mode: output structured JSONL when CLAUDECODE=1
const jsonMode = process.env.CLAUDECODE === '1';

/**
 * Emit a JSON event to stdout (JSON mode only)
 */
function emitJson(obj) {
  if (jsonMode) {
    console.log(JSON.stringify(obj));
  }
}

/**
 * Log a message (human mode only)
 */
function log(msg) {
  if (!jsonMode) {
    console.log(msg);
  }
}

/**
 * Log an error (human mode only, or emit JSON error event)
 */
function logError(msg) {
  if (jsonMode) {
    emitJson({ type: 'error', message: msg });
  } else {
    console.error(msg);
  }
}

/**
 * Load patch index for a specific Claude Code version and install type
 * @param {string} version - e.g., "2.1.14"
 * @param {string} installType - "bare" or "native"
 * @returns {{ version: string, patches: Array<{id: string, file: string}> } | null}
 */
function loadPatchIndex(version, installType) {
  const indexPath = path.join(PATCHES_DIR, version, 'index.json');

  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(indexPath, 'utf8');
    const index = JSON.parse(content);

    // Support both old format (flat patches array) and new format (per-type patches)
    if (Array.isArray(index.patches)) {
      // Old format: patches is an array - use for all install types
      return index;
    }

    // New format: patches is an object with common/bare/native keys
    const common = index.patches.common || [];
    const typeSpecific = index.patches[installType] || [];
    return {
      version: index.version,
      patches: [...common, ...typeSpecific],
    };
  } catch (err) {
    logError(`Failed to parse ${indexPath}: ${err.message}`);
    return null;
  }
}

/**
 * List available patch versions
 */
function listAvailableVersions() {
  if (!fs.existsSync(PATCHES_DIR)) {
    return [];
  }

  return fs.readdirSync(PATCHES_DIR)
    .filter(entry => {
      const indexPath = path.join(PATCHES_DIR, entry, 'index.json');
      return fs.existsSync(indexPath);
    })
    .sort();
}

/**
 * Compare two version strings: returns -1 if a < b, 0 if equal, 1 if a > b
 */
function compareVersions(a, b) {
  const partsA = a.split('.').map(p => parseInt(p, 10) || 0);
  const partsB = b.split('.').map(p => parseInt(p, 10) || 0);
  const maxLen = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLen; i++) {
    const partA = partsA[i] || 0;
    const partB = partsB[i] || 0;
    if (partA < partB) return -1;
    if (partA > partB) return 1;
  }
  return 0;
}

/**
 * Find the best fallback patch version for a given target version.
 * Returns the latest available version that is <= targetVersion.
 * Uses semver-style comparison (2.1.31 > 2.1.25 > 2.1.19 etc.)
 */
function findFallbackVersion(targetVersion) {
  const available = listAvailableVersions();
  if (available.length === 0) return null;

  // Find the latest version that is <= targetVersion
  let best = null;
  for (const v of available) {
    if (compareVersions(v, targetVersion) <= 0) {
      if (!best || compareVersions(v, best) > 0) {
        best = v;
      }
    }
  }

  return best;
}

// ============ Bun Binary Handling ============

/**
 * Extract JS from Bun binary to temp file
 * Uses proper LIEF-based extraction from lib/bun-binary.ts
 */
function extractJsFromBinaryToTemp(binaryPath) {
  const jsBuffer = extractClaudeJs(binaryPath);
  const tempPath = path.join(os.tmpdir(), `claude-cli-${Date.now()}.js`);
  fs.writeFileSync(tempPath, jsBuffer);

  return {
    tempPath,
    originalJsSize: jsBuffer.length,
    originalBinarySize: fs.statSync(binaryPath).size,
  };
}

/**
 * Reassemble Bun binary from patched JS
 * Uses proper LIEF-based repacking from lib/bun-binary.ts
 */
function reassembleBinaryFromTemp(tempPath, binaryPath, outputPath) {
  const modifiedJs = fs.readFileSync(tempPath);
  const originalBinarySize = fs.statSync(binaryPath).size;

  repackWithModifiedJs(binaryPath, modifiedJs, outputPath);

  const newBinarySize = fs.statSync(outputPath).size;

  return {
    originalSize: originalBinarySize,
    newSize: newBinarySize,
    jsDelta: modifiedJs.length,
  };
}

// ============ Patch Application ============

/**
 * Run a single patch script
 * @param {string} patchFile - Path relative to PATCHES_DIR (e.g., "2.1.14/patch-spinner.js")
 */
function runPatch(patchFile, targetPath, dryRun) {
  const patchPath = path.join(PATCHES_DIR, patchFile);

  if (!fs.existsSync(patchPath)) {
    return { success: false, error: `Patch file not found: ${patchFile}` };
  }

  const args = dryRun ? ['--check', targetPath] : [targetPath];

  // Inherit CLAUDECODE env so patches output JSON when we're in JSON mode
  const env = { ...process.env };

  try {
    const result = execSync(`node "${patchPath}" ${args.map(a => `"${a}"`).join(' ')}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    const stderr = err.stderr || '';
    const stdout = err.stdout || '';
    const combined = stdout + stderr;

    // Detect "pattern not found" or "already patched" cases
    const notFoundPatterns = [
      'Could not find',
      'already patched',
      '"Status":"already patched"',
      'pattern not found',
    ];

    const isNotFound = notFoundPatterns.some(p =>
      combined.toLowerCase().includes(p.toLowerCase())
    );

    if (isNotFound) {
      return { success: false, notFound: true, output: combined.trim() };
    }

    return { success: false, output: stderr || err.message };
  }
}

/**
 * Apply patches to a target (bare or native)
 * @param {object} install - Installation info
 * @param {boolean} dryRun - If true, only check without applying
 * @param {string} [patchVersionOverride] - Override which version's patches to use (for cross-version testing)
 * @param {object} [options] - Additional options
 * @param {boolean} [options.quiet] - Suppress verbose output
 * @returns {{ success: boolean, passed: Array, failed: Array, skipped: Array, total: number, version: string, patchVersion: string, error?: string }}
 */
function applyPatches(install, dryRun, patchVersionOverride, options = {}) {
  const isNative = install.type === 'native';
  let targetPath = install.path;
  let tempPath = null;
  let existingMeta = null;

  const patchVersion = patchVersionOverride || install.version;
  const quiet = options.quiet ?? false;
  const qlog = quiet ? () => {} : log;
  const qemit = quiet ? () => {} : emitJson;
  const resultCollector = { passed: [], failed: [], skipped: [] };

  // Emit start event in JSON mode
  qemit({
    type: 'start',
    mode: dryRun ? 'check' : 'apply',
    target: install.type,
    version: install.version,
    patchVersion,
  });

  qlog(`\nTarget: ${install.type} install`);
  qlog(`Version: ${install.version}`);
  qlog(`Path: ${install.path}`);

  if (patchVersionOverride) {
    qlog(`\nTesting patches from: ${patchVersionOverride}`);
  }

  // Load patch index for this version and install type
  const patchIndex = loadPatchIndex(patchVersion, install.type);
  if (!patchIndex) {
    const available = listAvailableVersions();
    logError(`No patches available for version ${patchVersion}`);
    if (!jsonMode) {
      if (available.length > 0) {
        console.error(`   Available versions: ${available.join(', ')}`);
      } else {
        console.error(`   No patch versions found in ${PATCHES_DIR}`);
      }
    }
    qemit({ type: 'summary', applied: 0, skipped: 0, failed: 1, success: false });
    return { success: false, passed: [], failed: [], skipped: [], total: 0, version: install.version, patchVersion, error: `No patches for ${patchVersion}` };
  }

  const patches = patchIndex.patches;
  qlog(`Patches: ${patches.map(p => p.id).join(', ')}`);

  // For native: extract JS first
  if (isNative) {
    qlog(`\nExtracting JS from Bun binary...`);
    try {
      const extracted = extractJsFromBinaryToTemp(install.path);
      tempPath = extracted.tempPath;
      targetPath = tempPath;
      qlog(`Extracted to: ${tempPath}`);
      qlog(`JS size: ${extracted.originalJsSize.toLocaleString()} bytes`);
    } catch (err) {
      logError(`Extraction failed: ${err.message}`);
      qemit({ type: 'summary', applied: 0, skipped: 0, failed: 1, success: false });
      return { success: false, passed: [], failed: [], skipped: [], total: 0, version: install.version, patchVersion, error: 'Extraction failed' };
    }
  }

  // Check existing metadata (works for both bare and extracted native)
  const metaSourcePath = isNative ? tempPath : install.path;
  const content = fs.readFileSync(metaSourcePath, 'utf8');
  existingMeta = readPatchMetadata(content);
  if (existingMeta) {
    qlog(`\nExisting patches: ${existingMeta.patches.map(p => p.id).join(', ')}`);
    qlog(`Applied: ${existingMeta.appliedAt}`);
  }

  // Create backup BEFORE patching — bare patches write directly to install.path,
  // so the file must be backed up while it's still in its pre-patch state.
  const backupPath = install.path + '.bak';
  if (!dryRun) {
    if (!fs.existsSync(backupPath)) {
      const preApplyContent = isNative
        ? extractClaudeJs(install.path).toString('utf8')
        : fs.readFileSync(install.path, 'utf8');
      if (isPatched(preApplyContent)) {
        qlog(`\n⚠ Skipped backup: source already has patch marker. Restore a clean source first.`);
        qemit({ type: 'warning', message: 'Skipped .bak creation: source already patched' });
      } else {
        fs.copyFileSync(install.path, backupPath);
        qlog(`\n✓ Backed up to ${backupPath}`);
        qemit({ type: 'info', message: `Backup created: ${backupPath}` });
      }
    }
  }

  // Build set of already-applied patch IDs (spinner is always re-run since symbols are configurable)
  const alreadyApplied = new Set(
    (existingMeta?.patches || []).map(p => p.id).filter(id => id !== 'spinner')
  );

  // Run patches
  qlog(`\n${dryRun ? 'Checking' : 'Applying'} patches:\n`);

  let successCount = 0;
  let notFoundCount = 0;
  let skipMetaCount = 0;
  let failCount = 0;
  const appliedPatches = [];

  for (const patch of patches) {
    // Skip patches already recorded in metadata
    if (alreadyApplied.has(patch.id)) {
      qemit({ type: 'patch_skipped', id: patch.id, reason: 'already_applied' });
      qlog(`→ ${patch.id}`);
      qlog(`  ✓ Already applied (per metadata)`);
      qlog('');
      skipMetaCount++;
      resultCollector.skipped.push({ id: patch.id, reason: 'already_applied' });
      continue;
    }

    // Emit patch start event in JSON mode
    qemit({ type: 'patch_start', id: patch.id, file: patch.file });
    qlog(`→ ${patch.id}`);

    const result = runPatch(patch.file, targetPath, dryRun);

    if (result.success) {
      if (!quiet) {
        if (jsonMode) {
          // Pass through JSONL output directly (each line is already valid JSON)
          for (const line of result.output.split('\n').filter(l => l.trim())) {
            console.log(line);
          }
        } else {
          const lines = result.output.split('\n').map(l => '  ' + l).join('\n');
          console.log(lines);
        }
      }
      successCount++;
      appliedPatches.push({ id: patch.id, file: patch.file });
      resultCollector.passed.push({ id: patch.id, output: result.output });
    } else if (result.notFound) {
      qemit({ type: 'patch_skipped', id: patch.id, reason: 'pattern_not_found', output: result.output || undefined });
      qlog(`  ✗ Pattern not found (incompatible version or already applied)`);
      if (result.output) {
        const lines = result.output.split('\n').map(l => '    ' + l).join('\n');
        qlog(lines);
      }
      notFoundCount++;
      resultCollector.failed.push({ id: patch.id, reason: 'pattern not found', output: result.output || '' });
    } else {
      qemit({ type: 'patch_failed', id: patch.id, error: result.output || result.error });
      qlog(`  ✗ Failed: ${result.output || result.error}`);
      failCount++;
      resultCollector.failed.push({ id: patch.id, reason: result.output || result.error, output: result.output || '' });
    }
    qlog('');
  }

  // Summary
  const skipTotal = notFoundCount + skipMetaCount;
  const summaryParts = [`${successCount} applied`, `${skipTotal} skipped`];
  if (skipMetaCount > 0) summaryParts[1] += ` (${skipMetaCount} already applied)`;
  if (failCount > 0) summaryParts.push(`${failCount} failed`);
  qlog(`Results: ${summaryParts.join(', ')}`);
  qemit({ type: 'summary', applied: successCount, skipped: notFoundCount, skippedMeta: skipMetaCount, failed: failCount, success: failCount === 0 });

  if (dryRun) {
    if (tempPath) fs.unlinkSync(tempPath);
    qlog(`\n✓ Dry run complete`);
    return { success: failCount === 0, ...resultCollector, total: patches.length, version: install.version, patchVersion };
  }

  if (successCount === 0) {
    if (tempPath) fs.unlinkSync(tempPath);
    qlog(`\nNo patches were applied.`);
    return { success: notFoundCount === patches.length, ...resultCollector, total: patches.length, version: install.version, patchVersion };
  }

  // Update metadata in the patched JS
  if (appliedPatches.length > 0) {
    const keptPatches = (existingMeta?.patches || []).filter(
      p => !appliedPatches.some(ap => ap.id === p.id)
    );
    const metadata = {
      ccVersion: install.version,
      appliedAt: new Date().toISOString().split('T')[0],
      applier: 'claude-patching',
      patches: [...keptPatches, ...appliedPatches],
    };

    const patchedPath = isNative ? tempPath : install.path;
    const patchedContent = fs.readFileSync(patchedPath, 'utf8');
    const updatedContent = writePatchMetadata(patchedContent, metadata);
    fs.writeFileSync(patchedPath, updatedContent);
  }

  // Syntax-check the patched JS before finalising
  {
    const checkPath = isNative ? tempPath : install.path;
    try {
      execSync(`node --check "${checkPath}"`, { stdio: 'pipe' });
      qlog(`\n✓ Syntax check passed`);
      qemit({ type: 'info', message: 'Syntax check passed' });
    } catch (err) {
      const stderr = err.stderr?.toString().trim() || err.message;
      logError(`\nPatched JS has syntax errors:\n${stderr}`);
      emitJson({ type: 'result', status: 'failure', message: `Syntax error in patched JS: ${stderr}` });

      if (isNative) {
        // Binary hasn't been touched yet — just clean up the temp file
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        qlog(`Binary untouched (validation failed before reassembly)`);
      } else {
        // Bare cli.js is already modified — restore from backup
        if (fs.existsSync(backupPath)) {
          fs.copyFileSync(backupPath, install.path);
          qlog(`Restored from backup: ${backupPath}`);
        } else {
          logError(`No backup available at ${backupPath} — manual recovery needed`);
        }
      }
      return { success: false, ...resultCollector, total: patches.length, version: install.version, patchVersion, error: 'Syntax check failed' };
    }
  }

  // For native: reassemble binary
  if (isNative) {
    try {
      const result = reassembleBinaryFromTemp(tempPath, install.path, install.path);
      qlog(`\n✓ Reassembled binary`);
      qlog(`  Original: ${result.originalSize.toLocaleString()} bytes`);
      qlog(`  Patched: ${result.newSize.toLocaleString()} bytes`);
      qlog(`  Delta: ${(result.newSize - result.originalSize).toLocaleString()} bytes`);
      qemit({
        type: 'info',
        message: `Binary reassembled: ${result.originalSize} -> ${result.newSize} bytes`,
      });
    } catch (err) {
      logError(`Reassembly failed: ${err.message}`);
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, install.path);
        qlog('Restored from backup');
      }
      return { success: false, ...resultCollector, total: patches.length, version: install.version, patchVersion, error: 'Reassembly failed' };
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }

  if (appliedPatches.length > 0) {
    qlog(`\n✓ Metadata updated`);
  }

  qlog(`\n✓ Done! Restart Claude Code to see changes.`);
  qemit({ type: 'result', status: 'success', message: 'Patches applied successfully' });
  return { success: true, ...resultCollector, total: patches.length, version: install.version, patchVersion };
}

// ============ Init ============

/**
 * Initialize patches for a new CC version.
 * @param {{ bare: object|null, native: object|null }} installs
 * @param {{ quiet?: boolean, skipExisting?: boolean }} options
 * @returns {{
 *   success: boolean,
 *   version?: string,
 *   copiedFrom?: string,
 *   alreadyExists?: boolean,
 *   promptImport?: { count: number, source: string, targetDir: string },
 *   upstream?: { upstreamVersion: string, onlyUpstream: string[], changed: Array<{file: string}>, reportPath: string },
 *   baseline?: { patchCount: number, charsSaved: number },
 *   error?: string
 * }}
 */
function doInit(installs, options = {}) {
  const quiet = options.quiet ?? false;
  const qlog = quiet ? () => {} : log;

  // Collect detected versions
  const versions = [];
  if (installs.bare) versions.push(installs.bare.version);
  if (installs.native) versions.push(installs.native.version);

  if (versions.length === 0) {
    return { success: false, error: 'No Claude Code installations detected' };
  }

  // Pick the newer version if they differ
  const targetVersion = versions.reduce((a, b) => compareVersions(a, b) >= 0 ? a : b);

  if (versions.length === 2 && versions[0] !== versions[1]) {
    qlog(`Detected versions: bare=${installs.bare.version}, native=${installs.native.version}`);
    qlog(`Picking newer version: ${targetVersion}`);
  } else {
    qlog(`Detected version: ${targetVersion}`);
  }

  // Check if index already exists for this version
  const targetDir = path.join(PATCHES_DIR, targetVersion);
  const targetIndex = path.join(targetDir, 'index.json');

  if (fs.existsSync(targetIndex)) {
    if (options.skipExisting) {
      return { success: true, alreadyExists: true, version: targetVersion };
    }
    return { success: false, error: `patches/${targetVersion}/index.json already exists` };
  }

  // Find the most recent existing index to copy from
  const available = listAvailableVersions();
  if (available.length === 0) {
    return { success: false, error: 'No existing patch versions to copy from' };
  }

  const sourceVersion = available[available.length - 1]; // sorted, last is latest
  const sourceIndex = path.join(PATCHES_DIR, sourceVersion, 'index.json');
  const sourceContent = JSON.parse(fs.readFileSync(sourceIndex, 'utf8'));

  // Create the new index with updated version
  const newIndex = { ...sourceContent, version: targetVersion };

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.writeFileSync(targetIndex, JSON.stringify(newIndex, null, 2) + '\n');

  qlog(`\nCreated patches/${targetVersion}/index.json (copied from ${sourceVersion})`);

  const result = { success: true, version: targetVersion, copiedFrom: sourceVersion };

  // Import prompt patches locally
  try {
    const {
      importPromptPatches, generateBaseline, generateDiff,
      previousVersion, hasLocalPromptPatches, compareWithUpstream,
    } = require('./lib/prompt-baseline');

    qlog('');
    const importResult = importPromptPatches(targetVersion);
    if (importResult) {
      qlog(`Imported ${importResult.count} prompt patches from ${importResult.source}`);
      qlog(`  → ${importResult.targetDir}/`);
      result.promptImport = importResult;
    } else {
      qlog('No prompt patches available to import (run --setup to fetch upstream repo)');
    }

    // Generate baseline from our local patches
    if (hasLocalPromptPatches(targetVersion)) {
      qlog(`\nOur patch set for v${targetVersion}:`);
      const baseline = generateBaseline(targetVersion);
      qlog(`  ${baseline.patches.length} patches, ~${(baseline.totalFindChars - baseline.totalReplaceChars).toLocaleString()} chars savings`);
      result.baseline = { patchCount: baseline.patches.length, charsSaved: baseline.totalFindChars - baseline.totalReplaceChars };

      // Compare against upstream and save report
      const comparison = compareWithUpstream(targetVersion);
      const reportLines = [];

      if (comparison) {
        reportLines.push(`Upstream comparison for v${targetVersion} (vs upstream ${comparison.upstreamVersion})`);
        reportLines.push(`Generated: ${new Date().toISOString()}`);
        reportLines.push('');
        reportLines.push(`Shared: ${comparison.shared.length} patches`);
        if (comparison.onlyLocal.length) {
          reportLines.push(`Only in ours: ${comparison.onlyLocal.join(', ')}`);
        }
        if (comparison.onlyUpstream.length) {
          reportLines.push(`New in upstream: ${comparison.onlyUpstream.join(', ')}`);
        }
        if (comparison.changed.length) {
          reportLines.push('Content differs:');
          for (const c of comparison.changed) {
            const parts = [];
            if (c.findDiff) parts.push('find');
            if (c.replaceDiff) parts.push('replace');
            reportLines.push(`  ${c.file} (${parts.join(' + ')})`);
          }
        }
        if (!comparison.onlyUpstream.length && !comparison.changed.length) {
          reportLines.push('No new patches or changes from upstream.');
        }

        const reportPath = path.join(PATCHES_DIR, targetVersion, 'upstream-comparison.txt');
        fs.writeFileSync(reportPath, reportLines.join('\n') + '\n');

        // Also print to stdout
        qlog(`\nUpstream comparison (vs ${comparison.upstreamVersion}):`);
        for (const line of reportLines.slice(2)) { // skip header + timestamp
          if (line) qlog(`  ${line}`);
        }
        qlog(`  Saved: ${reportPath}`);

        result.upstream = {
          upstreamVersion: comparison.upstreamVersion,
          onlyUpstream: comparison.onlyUpstream,
          changed: comparison.changed,
          reportPath,
        };
      } else {
        qlog(`\n  No upstream patches available for comparison.`);
      }
    }
  } catch (err) {
    qlog(`\nPrompt patch import/baseline failed: ${err.message}`);
  }

  return result;
}

// ============ Port Pipeline ============

/**
 * Format setup results in condensed form (human mode only)
 */
function formatSetupCondensed(status, targetType) {
  log(`Setup: ${status.errors.length === 0 ? '✓' : '✗'}`);
  const b = status.backups[targetType];
  if (b) log(`  ${targetType} backup: ${b.details}`);
  const p = status.prettified[targetType];
  if (p) log(`  ${targetType} pretty: ${p.details}`);
  if (status.tweakcc) log(`  tweakcc: ${status.tweakcc.details}`);
  if (status.promptPatching) log(`  prompt-patching: ${status.promptPatching.details}`);
  if (status.warnings.length > 0) {
    for (const w of status.warnings) log(`  ⚠ ${w}`);
  }
  log('');
}

/**
 * Format init results in condensed form (human mode only)
 */
function formatInitCondensed(result) {
  if (!result.success) {
    log(`Init: ✗ ${result.error}`);
  } else if (result.alreadyExists) {
    log(`Init: ✓ patches/${result.version}/ (already exists)`);
  } else {
    log(`Init: ✓ patches/${result.version}/index.json (from ${result.copiedFrom})`);
    if (result.promptImport) {
      log(`  ${result.promptImport.count} prompt patches imported from ${result.promptImport.source}`);
    }
    if (result.baseline) {
      log(`  ~${result.baseline.charsSaved.toLocaleString()} chars savings across ${result.baseline.patchCount} patches`);
    }
    if (result.upstream) {
      const parts = [];
      if (result.upstream.onlyUpstream.length) parts.push(`${result.upstream.onlyUpstream.length} new upstream`);
      if (result.upstream.changed.length) parts.push(`${result.upstream.changed.length} changed`);
      if (parts.length) {
        log(`  Upstream: ${parts.join(', ')} (see upstream-comparison.txt)`);
      } else {
        log(`  Upstream: in sync`);
      }
    }
  }
  log('');
}

/**
 * Format check results in condensed form (human mode only)
 */
function formatCheckCondensed(result) {
  if (result.error) {
    log(`Check: ✗ ${result.error}`);
    return;
  }

  const passCount = result.passed.length;
  const failCount = result.failed.length;
  const skipCount = result.skipped.length;
  log(`Check: ${passCount}/${result.total} patches passed`);

  if (passCount > 0) {
    log(`  ✓ ${result.passed.map(p => p.id).join(', ')}`);
  }
  if (skipCount > 0) {
    log(`  ⊘ ${result.skipped.map(s => s.id).join(', ')} (already applied)`);
  }

  for (const fail of result.failed) {
    // prompt-slim has structured sub-patch info in its output — parse it
    if (fail.id === 'prompt-slim' && fail.output) {
      const scoreMatch = fail.output.match(/(\d+)\/(\d+) patches/);
      if (scoreMatch) {
        log(`  ✗ prompt-slim — ${scoreMatch[1]}/${scoreMatch[2]} prompt patches`);
        // Extract diagnostic lines for failures
        const diagLines = fail.output.split('\n').filter(l =>
          l.includes('diverged') || l.includes('chained') || l.includes('not found')
        );
        for (const d of diagLines.slice(0, 8)) {
          log(`    ${d.trim()}`);
        }
        continue;
      }
    }
    log(`  ✗ ${fail.id} — ${fail.reason}`);
    // Show first few lines of output for context
    if (fail.output) {
      const lines = fail.output.split('\n').filter(l => l.trim()).slice(0, 3);
      for (const l of lines) {
        log(`    ${l.trim()}`);
      }
    }
  }
  log('');
}

/**
 * Full porting pipeline: setup + init + check
 * @param {{ bare: object|null, native: object|null }} installs - Detected installations
 * @param {object} target - The target installation to check against
 * @returns {{ success: boolean, setup: object, init: object, check: object }}
 */
function runPort(installs, target) {
  const latestPatched = listAvailableVersions().pop() || '(none)';
  const toVersion = target.version;

  log(`Port: ${latestPatched} → ${toVersion} (${target.type})\n`);
  emitJson({ type: 'port_start', from: latestPatched, to: toVersion, target: target.type });

  // Phase 1: Setup (quiet — we format our own summary)
  const { runSetup } = require('./lib/setup');
  const setupStatus = runSetup({ quiet: true });
  formatSetupCondensed(setupStatus, target.type);
  emitJson({ type: 'port_setup', ...setupStatus.toJSON() });

  if (setupStatus.errors.length > 0) {
    log(`\nSetup failed. Fix errors before porting.`);
    return { success: false, setup: setupStatus, init: null, check: null };
  }

  // Phase 2: Init (quiet, skip if already exists)
  const initResult = doInit(installs, { quiet: true, skipExisting: true });
  formatInitCondensed(initResult);
  emitJson({ type: 'port_init', ...initResult });

  if (!initResult.success) {
    log(`\nInit failed: ${initResult.error}`);
    return { success: false, setup: setupStatus, init: initResult, check: null };
  }

  // Phase 3: Check (dry run, quiet — we format condensed output)
  const checkResult = applyPatches(target, true, null, { quiet: true });
  formatCheckCondensed(checkResult);
  emitJson({
    type: 'port_check',
    passed: checkResult.passed.map(p => p.id),
    failed: checkResult.failed.map(f => ({ id: f.id, reason: f.reason })),
    skipped: checkResult.skipped.map(s => s.id),
    total: checkResult.total,
  });

  return { success: checkResult.success, setup: setupStatus, init: initResult, check: checkResult };
}

// ============ CLI ============

function printHelp() {
  const versions = listAvailableVersions();
  const versionInfo = versions.length > 0
    ? versions.join(', ')
    : '(none found)';

  console.log(`
claude-patching.js - Unified Claude Code patcher

USAGE
  node claude-patching.js [target] <action>

TARGETS (optional if only one install detected)
  --bare       Target pnpm/npm installation (cli.js)
  --native     Target native installation (Bun binary)

ACTIONS
  --status     Show detected installations and workspace artifact versions
  --setup      Prepare patching environment (backups, prettify, repos)
  --init       Create index.json for installed version from latest existing index
  --port       Full porting pipeline: setup + init + check (condensed output)
  --check      Dry run - verify patch patterns match
  --apply      Apply patches
  --restore    Restore from .bak backup (undo patches)

OPTIONS
  --help                     Show this help
  --patches-from <version>   Use patches from a different version (with --check only)

AUTO-FALLBACK (--check only)
  When checking a version without its own patches folder, the tool automatically
  uses the latest available patch version for testing. Does not apply to --apply
  since patches often break across versions - create version-specific patches first.
  Example: checking 2.1.32 with only 2.1.31 patches available will use 2.1.31.

EXAMPLES
  node claude-patching.js --status              # Show all detected installs
  node claude-patching.js --init                # Create index for installed version
  node claude-patching.js --native --port       # Full port pipeline for native
  node claude-patching.js --check               # Check patches (auto-select)
  node claude-patching.js --native --apply      # Apply to native install
  node claude-patching.js --bare --check        # Check bare install

  # Test which 2.1.14 patches work on 2.1.19
  node claude-patching.js --native --check --patches-from 2.1.14

SUPPORTED VERSIONS
  ${versionInfo}

Patches are loaded from patches/<version>/index.json
`);
}

/**
 * Get workspace artifact info (version, size, modification date)
 * @param {string} type - "bare" or "native"
 * @returns {{ original: object|null, pretty: object|null }}
 */
function getArtifactInfo(type) {
  const result = { original: null, pretty: null };

  for (const suffix of ['original', 'pretty']) {
    const filePath = path.join(SCRIPT_DIR, `cli.js.${type}.${suffix}`);
    const stats = safeStats(filePath);
    if (!stats.exists) continue;

    const info = {
      path: filePath,
      size: stats.size,
      mtime: stats.mtime.toISOString().split('T')[0],
      version: null,
    };

    // Extract version from content (read first 4K — VERSION is near the top)
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(4096);
      fs.readSync(fd, buf, 0, 4096, 0);
      fs.closeSync(fd);
      const head = buf.toString('utf8');
      info.version = extractVersion(head);
    } catch { /* ignore */ }

    // If not found in first 4K (e.g. prettified files), try a broader search
    if (!info.version) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        info.version = extractVersion(content);
      } catch { /* ignore */ }
    }

    result[suffix] = info;
  }

  return result;
}

function printStatus(installs) {
  // JSON mode: output structured object
  if (jsonMode) {
    const status = { type: 'status', installs: {}, artifacts: {} };

    for (const type of ['bare', 'native']) {
      const install = installs[type];
      if (!install) continue;

      const info = {
        version: install.version,
        path: install.path,
        patches: null,
        appliedAt: null,
      };

      try {
        let content;
        if (type === 'native') {
          const extracted = extractJsFromBinaryToTemp(install.path);
          content = fs.readFileSync(extracted.tempPath, 'utf8');
          fs.unlinkSync(extracted.tempPath);
        } else {
          content = fs.readFileSync(install.path, 'utf8');
        }
        const meta = readPatchMetadata(content);
        if (meta) {
          info.patches = meta.patches.map(p => p.id);
          info.appliedAt = meta.appliedAt;
        }
      } catch (err) {
        info.error = err.message?.includes('node-lief')
          ? 'node-lief not installed'
          : 'unable to read';
      }

      status.installs[type] = info;
      status.artifacts[type] = getArtifactInfo(type);
    }

    emitJson(status);
    return;
  }

  // Human mode: formatted text
  console.log(`\nDetected Installations:\n`);

  if (!installs.bare && !installs.native) {
    console.log('  No Claude Code installations found.\n');
    console.log('  Expected locations:');
    console.log('    bare:   ~/.local/share/pnpm/claude (pnpm wrapper)');
    console.log('    native: ~/.local/bin/claude (symlink to Bun binary)');
    return;
  }

  for (const type of ['bare', 'native']) {
    const install = installs[type];
    if (!install) continue;

    const label = type === 'bare' ? 'bare (pnpm/npm)' : 'native (Bun binary)';
    console.log(`  ${label}:`);
    console.log(`    Version: ${install.version}`);
    console.log(`    Path: ${install.path}`);

    // Check for patch metadata
    try {
      let content;
      if (type === 'native') {
        const extracted = extractJsFromBinaryToTemp(install.path);
        content = fs.readFileSync(extracted.tempPath, 'utf8');
        fs.unlinkSync(extracted.tempPath);
      } else {
        content = fs.readFileSync(install.path, 'utf8');
      }
      const meta = readPatchMetadata(content);
      if (meta) {
        console.log(`    Patches: ${meta.patches.map(p => p.id).join(', ')}`);
        console.log(`    Applied: ${meta.appliedAt}`);
      } else {
        console.log(`    Patches: (none)`);
      }
    } catch (err) {
      if (err.message?.includes('node-lief')) {
        console.log(`    Patches: (requires node-lief — run npm install)`);
      } else {
        console.log(`    Patches: (unable to read)`);
      }
    }

    // Workspace artifacts
    const artifacts = getArtifactInfo(type);
    if (artifacts.original || artifacts.pretty) {
      console.log(`    Artifacts:`);
      for (const [suffix, info] of Object.entries(artifacts)) {
        if (!info) continue;
        const versionStr = info.version || '?';
        const stale = info.version && info.version !== install.version;
        const tag = stale ? ' ← STALE' : '';
        console.log(`      ${suffix}: v${versionStr} (${formatBytes(info.size)}, ${info.mtime})${tag}`);
      }
    } else {
      console.log(`    Artifacts: (none — run --setup)`);
    }

    console.log();
  }
}

// Parse arguments
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

const wantStatus = args.includes('--status');
const wantSetup = args.includes('--setup');
const wantInit = args.includes('--init');
const wantCheck = args.includes('--check');
const wantApply = args.includes('--apply');
const wantRestore = args.includes('--restore');
const wantPort = args.includes('--port');
const wantBare = args.includes('--bare');
const wantNative = args.includes('--native');

// Parse --patches-from <version>
let patchesFromVersion = null;
const patchesFromIdx = args.indexOf('--patches-from');
if (patchesFromIdx !== -1) {
  patchesFromVersion = args[patchesFromIdx + 1];
  if (!patchesFromVersion || patchesFromVersion.startsWith('--')) {
    console.error('Error: --patches-from requires a version argument');
    process.exit(1);
  }
}

// Validate arguments
if (wantBare && wantNative) {
  console.error('Error: Cannot specify both --bare and --native');
  process.exit(1);
}

const actionCount = [wantStatus, wantSetup, wantInit, wantCheck, wantApply, wantRestore, wantPort].filter(Boolean).length;
if (actionCount === 0) {
  console.error('Error: No action specified. Use --status, --setup, --init, --port, --check, --apply, or --restore');
  console.error('Run with --help for usage information.');
  process.exit(1);
}

if (actionCount > 1) {
  console.error('Error: Cannot combine multiple actions');
  process.exit(1);
}

if (patchesFromVersion && !wantCheck) {
  console.error('Error: --patches-from can only be used with --check');
  process.exit(1);
}

// Detect installations
const installs = detectInstalls();

// Handle --status
if (wantStatus) {
  printStatus(installs);
  process.exit(0);
}

// Handle --setup
if (wantSetup) {
  const { runSetup } = require('./lib/setup');
  const status = runSetup();
  console.log(jsonMode ? JSON.stringify(status.toJSON(), null, 2) : status.toReport());
  process.exit(status.errors.length === 0 ? 0 : 1);
}

// Handle --init
if (wantInit) {
  const result = doInit(installs);
  if (!result.success) {
    logError(result.error);
    process.exit(1);
  }
  if (result.alreadyExists) {
    logError(`patches/${result.version}/index.json already exists`);
    process.exit(1);
  }
  log(`\nNext steps:`);
  log(`  node claude-patching.js --check    # verify patches still match`);
  emitJson({ type: 'result', status: 'success', version: result.version, copiedFrom: result.copiedFrom });
  process.exit(0);
}

// Handle --restore
if (wantRestore) {
  // Resolve target (same logic as --check/--apply)
  let restoreTarget = null;

  if (wantBare) {
    if (!installs.bare) {
      console.error('Error: No bare (pnpm/npm) installation detected');
      process.exit(1);
    }
    restoreTarget = installs.bare;
  } else if (wantNative) {
    if (!installs.native) {
      console.error('Error: No native (Bun binary) installation detected');
      process.exit(1);
    }
    restoreTarget = installs.native;
  } else {
    const available = [installs.bare, installs.native].filter(Boolean);
    if (available.length === 0) {
      console.error('Error: No Claude Code installation detected');
      process.exit(1);
    }
    if (available.length > 1) {
      console.error('Error: Multiple installations detected. Specify --bare or --native');
      process.exit(1);
    }
    restoreTarget = available[0];
    log(`Auto-selected: ${restoreTarget.type} install`);
  }

  const bakPath = restoreTarget.path + '.bak';

  if (!fs.existsSync(bakPath)) {
    logError(`No backup found at ${bakPath}`);
    logError('A .bak file is created by --apply before patching. No restore possible without it.');
    emitJson({ type: 'result', status: 'failure', message: 'No .bak backup found' });
    process.exit(1);
  }

  // Verify .bak is clean
  try {
    let bakContent;
    if (restoreTarget.type === 'native') {
      // For native, we can't easily read the JS from the .bak binary without extraction,
      // so just check that the .bak file exists and is a reasonable size
      const bakStats = fs.statSync(bakPath);
      const liveStats = fs.statSync(restoreTarget.path);
      log(`\nRestore: ${restoreTarget.type} install`);
      log(`  Source: ${bakPath} (${formatBytes(bakStats.size)})`);
      log(`  Target: ${restoreTarget.path} (${formatBytes(liveStats.size)})`);
    } else {
      bakContent = fs.readFileSync(bakPath, 'utf8');
      if (isPatched(bakContent)) {
        logError(`Backup at ${bakPath} is itself patched — cannot restore a clean state from it.`);
        logError('Reinstall Claude Code to get a clean binary.');
        emitJson({ type: 'result', status: 'failure', message: '.bak is also patched' });
        process.exit(1);
      }
      const bakStats = fs.statSync(bakPath);
      const liveStats = fs.statSync(restoreTarget.path);
      log(`\nRestore: ${restoreTarget.type} install`);
      log(`  Source: ${bakPath} (${formatBytes(bakStats.size)})`);
      log(`  Target: ${restoreTarget.path} (${formatBytes(liveStats.size)})`);
    }
  } catch (err) {
    logError(`Failed to read backup: ${err.message}`);
    process.exit(1);
  }

  // Perform the restore
  try {
    fs.copyFileSync(bakPath, restoreTarget.path);
    log(`\n✓ Restored ${restoreTarget.type} install from .bak`);
    log('  Restart Claude Code to use the unpatched version.');
    emitJson({ type: 'result', status: 'success', message: `Restored ${restoreTarget.type} from .bak` });
  } catch (err) {
    logError(`Restore failed: ${err.message}`);
    emitJson({ type: 'result', status: 'failure', message: err.message });
    process.exit(1);
  }

  process.exit(0);
}

// Handle --port
if (wantPort) {
  let portTarget = null;

  if (wantBare) {
    if (!installs.bare) { console.error('Error: No bare installation detected'); process.exit(1); }
    portTarget = installs.bare;
  } else if (wantNative) {
    if (!installs.native) { console.error('Error: No native installation detected'); process.exit(1); }
    portTarget = installs.native;
  } else {
    const available = [installs.bare, installs.native].filter(Boolean);
    if (available.length === 0) { console.error('Error: No Claude Code installation detected'); process.exit(1); }
    if (available.length > 1) {
      console.error('Error: Multiple installations detected. Specify --bare or --native with --port');
      printStatus(installs);
      process.exit(1);
    }
    portTarget = available[0];
  }

  const result = runPort(installs, portTarget);

  if (result.check) {
    const failCount = result.check.failed.length;
    if (failCount > 0) {
      log(`Next: Fix ${failCount} failing patch(es), then re-run --check`);
    } else {
      log(`All patches passed! Ready to --apply`);
    }
  }

  emitJson({ type: 'result', status: result.success ? 'success' : 'needs_work', ...result });
  process.exit(result.success ? 0 : 1);
}

// Determine target
let target = null;

if (wantBare) {
  if (!installs.bare) {
    console.error('Error: No bare (pnpm/npm) installation detected');
    process.exit(1);
  }
  target = installs.bare;
} else if (wantNative) {
  if (!installs.native) {
    console.error('Error: No native (Bun binary) installation detected');
    process.exit(1);
  }
  target = installs.native;
} else {
  // Auto-select
  const available = [installs.bare, installs.native].filter(Boolean);

  if (available.length === 0) {
    console.error('Error: No Claude Code installation detected');
    console.error('Run with --status to see expected locations.');
    process.exit(1);
  }

  if (available.length > 1) {
    console.error('Error: Multiple installations detected. Specify --bare or --native');
    console.error('');
    printStatus(installs);
    process.exit(1);
  }

  target = available[0];
  log(`Auto-selected: ${target.type} install`);
}

// Execute action
const dryRun = wantCheck;

// Auto-fallback (--check only): if no patches exist for current version and no explicit
// --patches-from, automatically use the latest available patch version for testing.
// This is check-only because patches often break across versions.
let effectivePatchVersion = patchesFromVersion;
if (!effectivePatchVersion && dryRun) {
  const indexPath = path.join(PATCHES_DIR, target.version, 'index.json');
  if (!fs.existsSync(indexPath)) {
    const fallback = findFallbackVersion(target.version);
    if (fallback) {
      effectivePatchVersion = fallback;
      log(`No patches for ${target.version}, using ${fallback} (latest available)`);
      emitJson({
        type: 'info',
        message: `Auto-fallback: using patches from ${fallback} for ${target.version}`
      });
    }
  }
}

const result = applyPatches(target, dryRun, effectivePatchVersion);
process.exit(result.success ? 0 : 1);

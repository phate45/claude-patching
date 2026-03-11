/**
 * Patch runner — index loading, patch execution, and the applyPatches engine.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  PATCHES_DIR,
  PATCH_MARKER,
  readPatchMetadata,
  writePatchMetadata,
  isPatched,
  listAvailableVersions,
} = require('./shared');

const { isJsonMode, emitJson, log, logError } = require('./output');

// ============ Lazy Bun Binary Loader ============

let _bunBinary = null;
function getBunBinary() {
  if (!_bunBinary) {
    try {
      _bunBinary = require('./bun-binary.ts');
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

// ============ Patch Index ============

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

// ============ Patch Execution ============

/**
 * Extract result messages from patch subprocess output.
 * Handles both JSON mode (CLAUDECODE=1) and human-readable mode.
 * Returns an array since multi-step patches (e.g. spinner) can emit multiple results.
 */
function extractResultMessages(output) {
  const messages = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // JSON mode: parse {"type":"result","message":"..."}
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj.type === 'result' && obj.message) {
          messages.push(obj.message);
        }
      } catch { /* not JSON, skip */ }
      continue;
    }

    // Human-readable mode: lines starting with result prefixes
    const humanMatch = trimmed.match(/^(?:✓|✗|⊘|\(Dry run\))\s+(.+)/);
    if (humanMatch) {
      messages.push(humanMatch[1]);
    }
  }

  return messages.length > 0 ? messages : ['ok'];
}

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

// ============ Apply Patches ============

/**
 * Apply patches to a target (bare or native)
 * @param {object} install - Installation info
 * @param {boolean} dryRun - If true, only check without applying
 * @param {string} [patchVersionOverride] - Override which version's patches to use (for cross-version testing)
 * @param {object} [options] - Additional options
 * @param {boolean} [options.quiet] - Suppress all output (used by --port)
 * @param {boolean} [options.verbose] - Show full patch output (discoveries, modifications)
 * @returns {{ success: boolean, passed: Array, failed: Array, skipped: Array, total: number, version: string, patchVersion: string, error?: string }}
 */
function applyPatches(install, dryRun, patchVersionOverride, options = {}) {
  const isNative = install.type === 'native';
  let targetPath = install.path;
  let tempPath = null;
  let existingMeta = null;

  const patchVersion = patchVersionOverride || install.version;
  const quiet = options.quiet ?? false;
  const verbose = options.verbose ?? false;
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
    if (!isJsonMode) {
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
        if (verbose) {
          // Full output — every discovery, modification, info, result line
          if (isJsonMode) {
            for (const line of result.output.split('\n').filter(l => l.trim())) {
              console.log(line);
            }
          } else {
            const lines = result.output.split('\n').map(l => '  ' + l).join('\n');
            console.log(lines);
          }
        } else {
          // Condensed — extract result line(s) only
          const resultMsgs = extractResultMessages(result.output);
          if (isJsonMode) {
            for (const msg of resultMsgs) {
              emitJson({ type: 'result', status: dryRun ? 'dry_run' : 'success', message: msg });
            }
          } else {
            for (const msg of resultMsgs) {
              const clean = msg.replaceAll(targetPath, '')
                .replace(/\s{2,}/g, ' ')       // collapse double spaces left by path removal
                .replace(/\s+(?:to|in)(\s|$)/, '$1') // drop dangling preposition
                .trim();
              console.log(`  ✓ ${clean}`);
            }
          }
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

module.exports = {
  extractJsFromBinaryToTemp,
  loadPatchIndex,
  applyPatches,
};

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
 *   node claude-patching.js --check               # Dry run (auto-select if single install)
 *   node claude-patching.js --apply               # Apply patches (auto-select if single install)
 *   node claude-patching.js --native --check      # Target native install explicitly
 *   node claude-patching.js --bare --apply        # Target bare install explicitly
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  PATCH_MARKER,
  BUN_TRAILER,
  TRAILER_SIZE,
  SIZE_MARKER_SIZE,
  detectBareInstall,
  detectNativeInstall,
  detectInstalls,
  readPatchMetadata,
  writePatchMetadata,
  parseBunBinary,
} = require('./lib/shared');

const SCRIPT_DIR = __dirname;
const PATCHES_DIR = path.join(SCRIPT_DIR, 'patches');

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
    console.error(`Failed to parse ${indexPath}: ${err.message}`);
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

// ============ Bun Binary Handling ============

/**
 * Extract JS from Bun binary to temp file
 */
function extractJsFromBinary(binaryPath) {
  const buffer = fs.readFileSync(binaryPath);
  const info = parseBunBinary(buffer);

  if (!info.valid) {
    throw new Error(info.error);
  }

  const tempPath = path.join(os.tmpdir(), `claude-cli-${Date.now()}.js`);
  const jsContent = buffer.slice(0, info.trailerOffset);
  fs.writeFileSync(tempPath, jsContent);

  return { tempPath, originalBuffer: buffer, info };
}

/**
 * Reassemble Bun binary from patched JS
 */
function reassembleBinary(patchedJsPath, outputPath) {
  const patchedJs = fs.readFileSync(patchedJsPath);
  const newSize = patchedJs.length + TRAILER_SIZE + SIZE_MARKER_SIZE;
  const newBuffer = Buffer.alloc(newSize);

  patchedJs.copy(newBuffer, 0);
  BUN_TRAILER.copy(newBuffer, patchedJs.length);
  newBuffer.writeBigUInt64LE(BigInt(newSize), patchedJs.length + TRAILER_SIZE);

  fs.writeFileSync(outputPath, newBuffer);
  fs.chmodSync(outputPath, 0o755);

  return { newSize, originalSize: null }; // originalSize set by caller
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

  try {
    const result = execSync(`node "${patchPath}" ${args.map(a => `"${a}"`).join(' ')}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    const stderr = err.stderr || '';
    const stdout = err.stdout || '';
    if (stderr.includes('Could not find') || stdout.includes('Could not find')) {
      return { success: false, notFound: true, output: stderr || stdout };
    }
    return { success: false, output: stderr || err.message };
  }
}

/**
 * Apply patches to a target (bare or native)
 * @param {object} install - Installation info
 * @param {boolean} dryRun - If true, only check without applying
 * @param {string} [patchVersionOverride] - Override which version's patches to use (for cross-version testing)
 */
function applyPatches(install, dryRun, patchVersionOverride) {
  const isNative = install.type === 'native';
  let targetPath = install.path;
  let tempPath = null;
  let originalBuffer = null;
  let existingMeta = null;

  const patchVersion = patchVersionOverride || install.version;

  console.log(`\nTarget: ${install.type} install`);
  console.log(`Version: ${install.version}`);
  console.log(`Path: ${install.path}`);

  if (patchVersionOverride) {
    console.log(`\nTesting patches from: ${patchVersionOverride}`);
  }

  // Load patch index for this version and install type
  const patchIndex = loadPatchIndex(patchVersion, install.type);
  if (!patchIndex) {
    const available = listAvailableVersions();
    console.error(`\n❌ No patches available for version ${patchVersion}`);
    if (available.length > 0) {
      console.error(`   Available versions: ${available.join(', ')}`);
    } else {
      console.error(`   No patch versions found in ${PATCHES_DIR}`);
    }
    return false;
  }

  const patches = patchIndex.patches;
  console.log(`Patches: ${patches.map(p => p.id).join(', ')}`);

  // For native: extract JS first
  if (isNative) {
    console.log(`\nExtracting JS from Bun binary...`);
    try {
      const extracted = extractJsFromBinary(install.path);
      tempPath = extracted.tempPath;
      originalBuffer = extracted.originalBuffer;
      targetPath = tempPath;
      console.log(`Extracted to: ${tempPath}`);
    } catch (err) {
      console.error(`\n❌ Extraction failed: ${err.message}`);
      return false;
    }
  }

  // Check existing metadata (works for both bare and extracted native)
  const metaSourcePath = isNative ? tempPath : install.path;
  const content = fs.readFileSync(metaSourcePath, 'utf8');
  existingMeta = readPatchMetadata(content);
  if (existingMeta) {
    console.log(`\nExisting patches: ${existingMeta.patches.map(p => p.id).join(', ')}`);
    console.log(`Applied: ${existingMeta.appliedAt}`);
  }

  // Run patches
  console.log(`\n${dryRun ? 'Checking' : 'Applying'} patches:\n`);

  let successCount = 0;
  let notFoundCount = 0;
  let failCount = 0;
  const appliedPatches = [];

  for (const patch of patches) {
    console.log(`→ ${patch.id}`);
    const result = runPatch(patch.file, targetPath, dryRun);

    if (result.success) {
      const lines = result.output.split('\n').map(l => '  ' + l).join('\n');
      console.log(lines);
      successCount++;
      appliedPatches.push({ id: patch.id, file: patch.file });
    } else if (result.notFound) {
      console.log(`  ✗ Pattern not found (incompatible version or already applied)`);
      notFoundCount++;
    } else {
      console.log(`  ✗ Failed: ${result.output || result.error}`);
      failCount++;
    }
    console.log();
  }

  // Summary
  console.log(`Results: ${successCount} applied, ${notFoundCount} skipped, ${failCount} failed`);

  if (dryRun) {
    if (tempPath) fs.unlinkSync(tempPath);
    console.log(`\n✓ Dry run complete`);
    return failCount === 0;
  }

  if (successCount === 0) {
    if (tempPath) fs.unlinkSync(tempPath);
    console.log(`\nNo patches were applied.`);
    return notFoundCount === patches.length;
  }

  // Create backup
  const backupPath = install.path + '.bak';
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(install.path, backupPath);
    console.log(`\n✓ Backed up to ${backupPath}`);
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

  // For native: reassemble binary
  if (isNative) {
    try {
      const result = reassembleBinary(tempPath, install.path);
      result.originalSize = originalBuffer.length;
      console.log(`\n✓ Reassembled binary`);
      console.log(`  Original: ${result.originalSize.toLocaleString()} bytes`);
      console.log(`  Patched: ${result.newSize.toLocaleString()} bytes`);
      console.log(`  Delta: ${(result.newSize - result.originalSize).toLocaleString()} bytes`);
    } catch (err) {
      console.error(`\n❌ Reassembly failed: ${err.message}`);
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, install.path);
        console.log('Restored from backup');
      }
      return false;
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }

  if (appliedPatches.length > 0) {
    console.log(`\n✓ Metadata updated`);
  }

  console.log(`\n✓ Done! Restart Claude Code to see changes.`);
  return true;
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
  --status     Show detected installations
  --setup      Prepare patching environment (backups, prettify, tweakcc)
  --check      Dry run - verify patch patterns match
  --apply      Apply patches

OPTIONS
  --help                     Show this help
  --patches-from <version>   Use patches from a different version (with --check only)

EXAMPLES
  node claude-patching.js --status              # Show all detected installs
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

function printStatus(installs) {
  console.log(`\nDetected Installations:\n`);

  if (!installs.bare && !installs.native) {
    console.log('  No Claude Code installations found.\n');
    console.log('  Expected locations:');
    console.log('    bare:   ~/.local/share/pnpm/claude (pnpm wrapper)');
    console.log('    native: ~/.local/bin/claude (symlink to Bun binary)');
    return;
  }

  if (installs.bare) {
    console.log(`  bare (pnpm/npm):`);
    console.log(`    Version: ${installs.bare.version}`);
    console.log(`    Path: ${installs.bare.path}`);

    // Check for patch metadata
    try {
      const content = fs.readFileSync(installs.bare.path, 'utf8');
      const meta = readPatchMetadata(content);
      if (meta) {
        console.log(`    Patches: ${meta.patches.map(p => p.id).join(', ')}`);
        console.log(`    Applied: ${meta.appliedAt}`);
      } else {
        console.log(`    Patches: (none)`);
      }
    } catch (err) {
      console.log(`    Patches: (unable to read)`);
    }
    console.log();
  }

  if (installs.native) {
    console.log(`  native (Bun binary):`);
    console.log(`    Version: ${installs.native.version}`);
    console.log(`    Path: ${installs.native.path}`);

    // Extract JS to check for patch metadata
    try {
      const extracted = extractJsFromBinary(installs.native.path);
      const content = fs.readFileSync(extracted.tempPath, 'utf8');
      const meta = readPatchMetadata(content);
      fs.unlinkSync(extracted.tempPath);

      if (meta) {
        console.log(`    Patches: ${meta.patches.map(p => p.id).join(', ')}`);
        console.log(`    Applied: ${meta.appliedAt}`);
      } else {
        console.log(`    Patches: (none)`);
      }
    } catch (err) {
      console.log(`    Patches: (unable to read)`);
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
const wantCheck = args.includes('--check');
const wantApply = args.includes('--apply');
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

const actionCount = [wantStatus, wantSetup, wantCheck, wantApply].filter(Boolean).length;
if (actionCount === 0) {
  console.error('Error: No action specified. Use --status, --setup, --check, or --apply');
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
  const report = runSetup();
  console.log(report);
  process.exit(0);
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
  console.log(`Auto-selected: ${target.type} install`);
}

// Execute action
const dryRun = wantCheck;
const success = applyPatches(target, dryRun, patchesFromVersion);
process.exit(success ? 0 : 1);

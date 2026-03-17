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

const fs = require('fs');
const path = require('path');

const {
  PATCHES_DIR,
  detectInstalls,
  readPatchMetadata,
  isPatched,
  formatBytes,
  listAvailableVersions,
  findFallbackVersion,
} = require('./lib/shared');

const { isJsonMode, emitJson, log, logError } = require('./lib/output');

const { applyPatches } = require('./lib/patch-runner');
const { doInit } = require('./lib/init');
const { runPort } = require('./lib/port');
const { printStatus } = require('./lib/status');

// ============ Help ============

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
  --verbose, -v              Show full patch output (discoveries, modifications)
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
  node claude-patching.js --restore --apply     # Restore from .bak, then re-apply patches
  node claude-patching.js --check -v            # Check with full diagnostic output

  # Test which 2.1.14 patches work on 2.1.19
  node claude-patching.js --native --check --patches-from 2.1.14

SUPPORTED VERSIONS
  ${versionInfo}

Patches are loaded from patches/<version>/index.json
`);
}

// ============ Target Resolution ============

/**
 * Resolve target install from flags and detected installs.
 * Exits with error if resolution fails.
 */
function resolveTarget(installs, wantBare, wantNative) {
  if (wantBare) {
    if (!installs.bare) {
      console.error('Error: No bare (pnpm/npm) installation detected');
      process.exit(1);
    }
    return installs.bare;
  }
  if (wantNative) {
    if (!installs.native) {
      console.error('Error: No native (Bun binary) installation detected');
      process.exit(1);
    }
    return installs.native;
  }

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

  const target = available[0];
  log(`Auto-selected: ${target.type} install`);
  return target;
}

// ============ CLI ============

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
const wantVerbose = args.includes('--verbose') || args.includes('-v');

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

// --restore --apply is a valid combo (restore then re-apply)
const isRestoreApply = wantRestore && wantApply;
if (actionCount > 1 && !isRestoreApply) {
  console.error('Error: Cannot combine multiple actions (except --restore --apply)');
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
  console.log(isJsonMode ? JSON.stringify(status.toJSON(), null, 2) : status.toReport());
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
  const restoreTarget = resolveTarget(installs, wantBare, wantNative);
  const bakPath = restoreTarget.path + '.bak';

  if (!fs.existsSync(bakPath)) {
    if (isRestoreApply) {
      // No .bak means --apply never ran, so the binary is already clean.
      // Skip restore and fall through to --apply.
      log(`\nNo backup at ${bakPath} — binary was never patched, already clean.`);
      log(`  Skipping restore, proceeding to --apply.`);
      emitJson({ type: 'restore_skip', message: 'No .bak — binary already clean' });
    } else {
      logError(`No backup found at ${bakPath}`);
      logError('A .bak file is created by --apply before patching. No restore possible without it.');
      emitJson({ type: 'result', status: 'failure', message: 'No .bak backup found' });
      process.exit(1);
    }
  } else {
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
      if (!isRestoreApply) {
        log('  Restart Claude Code to use the unpatched version.');
      }
      emitJson({ type: 'result', status: 'success', message: `Restored ${restoreTarget.type} from .bak` });
    } catch (err) {
      logError(`Restore failed: ${err.message}`);
      emitJson({ type: 'result', status: 'failure', message: err.message });
      process.exit(1);
    }
  }

  if (!isRestoreApply) {
    process.exit(0);
  }
  // Fall through to --apply
  log('');
}

// Handle --port
if (wantPort) {
  const portTarget = resolveTarget(installs, wantBare, wantNative);
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

// Handle --check / --apply
const target = resolveTarget(installs, wantBare, wantNative);
const dryRun = wantCheck;

// Auto-fallback (--check only): if no patches exist for current version and no explicit
// --patches-from, automatically use the latest available patch version for testing.
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

const result = applyPatches(target, dryRun, effectivePatchVersion, { verbose: wantVerbose });

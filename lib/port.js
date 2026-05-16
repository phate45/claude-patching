/**
 * Port pipeline — setup + init + check with condensed output.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { listAvailableVersions, PATCHES_DIR, PROJECT_DIR, compareVersions, listRecentBaks } = require('./shared');
const { log, emitJson } = require('./output');
const { applyPatches } = require('./patch-runner');
const { doInit } = require('./init');

const SCAN_SCRIPT = path.join(PROJECT_DIR, 'scan-feature-flags.js');

// ============ Condensed Formatters ============

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

// ============ Flag Scan ============

/**
 * Find the most recent flags.json that predates the given version.
 * Scans patches/ directly so it works even if a version has no index.json yet.
 */
function findPreviousFlagsJson(currentVersion) {
  if (!fs.existsSync(PATCHES_DIR)) return null;

  const candidates = fs.readdirSync(PATCHES_DIR)
    .filter(entry => {
      const flagsPath = path.join(PATCHES_DIR, entry, 'flags.json');
      return fs.existsSync(flagsPath) && compareVersions(entry, currentVersion) < 0;
    })
    .sort(compareVersions);

  if (candidates.length === 0) return null;

  const prevVersion = candidates[candidates.length - 1];
  return {
    version: prevVersion,
    flagsPath: path.join(PATCHES_DIR, prevVersion, 'flags.json'),
  };
}

/**
 * Run scan-feature-flags.js for the target's .pretty file.
 * Saves inventory to patches/<version>/flags.json and, if a previous inventory
 * exists, writes the diff to patches/<version>/diff-<prevVersion>.json.
 *
 * Returns { version, flagsPath, diffPath?, diff?, error? } for condensed formatting.
 */
function runFlagScan(target) {
  const prettyPath = path.join(PROJECT_DIR, `cli.js.${target.type}.pretty`);

  if (!fs.existsSync(prettyPath)) {
    return { error: `cli.js.${target.type}.pretty not found` };
  }

  const version = target.version;
  const versionDir = path.join(PATCHES_DIR, version);
  const flagsPath = path.join(versionDir, 'flags.json');

  // Ensure the version dir exists (init may not have run yet if skipExisting)
  if (!fs.existsSync(versionDir)) {
    fs.mkdirSync(versionDir, { recursive: true });
  }

  const prev = findPreviousFlagsJson(version);
  const spawnArgs = [SCAN_SCRIPT, prettyPath, '--save', flagsPath];
  if (prev) spawnArgs.push('--diff', prev.flagsPath);

  const result = spawnSync('node', spawnArgs, { encoding: 'utf8', timeout: 60000 });

  if (result.status !== 0) {
    return { error: `scan failed: ${(result.stderr || result.stdout || '').trim().split('\n')[0]}` };
  }

  // Parse NDJSON output to extract diff_meta
  const lines = (result.stdout || '').trim().split('\n');
  let diffMeta = null;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'diff_meta') { diffMeta = obj; break; }
    } catch { /* skip malformed lines */ }
  }

  const out = { version, flagsPath };

  if (prev && diffMeta) {
    const diffFileName = `diff-${prev.version}.json`;
    const diffPath = path.join(versionDir, diffFileName);
    // Write the diff NDJSON lines that belong to the diff section
    const diffLines = lines.filter(l => {
      try { const o = JSON.parse(l); return ['diff_meta','diff_removed','flag'].includes(o.type) && (o.type !== 'flag' || o.change); }
      catch { return false; }
    });
    fs.writeFileSync(diffPath, diffLines.map(l => l + '\n').join(''));
    out.diffPath = diffPath;
    out.diff = diffMeta;
    out.prevVersion = prev.version;
  }

  return out;
}

/**
 * Format flag scan results in condensed form (human mode only)
 */
function formatFlagScanCondensed(scanResult) {
  if (scanResult.error) {
    log(`Flags: ⚠ ${scanResult.error}`);
  } else {
    log(`Flags: ✓ patches/${scanResult.version}/flags.json`);
    if (scanResult.diff) {
      const d = scanResult.diff;
      log(`  diff vs ${scanResult.prevVersion}: +${d.addedCount} added, -${d.removedCount} removed, ~${d.changedCount} changed`);
    }
  }
  log('');
}

// ============ Port Pipeline ============

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
  const { runSetup } = require('./setup');
  const setupStatus = runSetup({ quiet: true });
  formatSetupCondensed(setupStatus, target.type);
  const baks = listRecentBaks(target.type, target.path);
  if (baks.length > 0) {
    log(`  .bak files: ${baks.map(b => `${b.name} (${b.sizeMB} MB)`).join(', ')}`);
    log('');
  }
  emitJson({ type: 'port_setup', ...setupStatus.toJSON(), baks: baks.map(b => b.name) });

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

  // Phase 2.5: Flag scan
  const flagScan = runFlagScan(target);
  formatFlagScanCondensed(flagScan);
  emitJson({ type: 'port_flags', ...flagScan });

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

module.exports = { runPort };

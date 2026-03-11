/**
 * Port pipeline — setup + init + check with condensed output.
 */

const { listAvailableVersions, listRecentBaks } = require('./shared');
const { log, emitJson } = require('./output');
const { applyPatches } = require('./patch-runner');
const { doInit } = require('./init');

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

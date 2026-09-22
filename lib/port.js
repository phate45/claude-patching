/**
 * Port pipeline — setup + init + check with condensed output.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { listAvailableVersions, PATCHES_DIR, PROJECT_DIR, compareVersions, listRecentBaks } = require('./shared');
const { log, emitJson } = require('./output');
const { applyPatches, buildSummary } = require('./patch-runner');
const { doInit } = require('./init');

const SCAN_SCRIPT = path.join(PROJECT_DIR, 'scan-feature-flags.js');
const ENV_SCAN_SCRIPT = path.join(PROJECT_DIR, 'scan-env-vars.js');
const CHANGELOG_SCAN_SCRIPT = path.join(PROJECT_DIR, 'scan-changelog.js');
const { CHANGELOG_PATH } = require('./setup');

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
  if (status.claudeCode) log(`  claude-code: ${status.claudeCode.details}`);
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

// ============ Env Var Scan (sibling of the flag scan above) ============

/**
 * Find the most recent env-vars.json that predates the given version.
 * Mirrors findPreviousFlagsJson — scans patches/ directly.
 */
function findPreviousEnvJson(currentVersion) {
  if (!fs.existsSync(PATCHES_DIR)) return null;

  const candidates = fs.readdirSync(PATCHES_DIR)
    .filter(entry => {
      const envPath = path.join(PATCHES_DIR, entry, 'env-vars.json');
      return fs.existsSync(envPath) && compareVersions(entry, currentVersion) < 0;
    })
    .sort(compareVersions);

  if (candidates.length === 0) return null;

  const prevVersion = candidates[candidates.length - 1];
  return {
    version: prevVersion,
    envPath: path.join(PATCHES_DIR, prevVersion, 'env-vars.json'),
  };
}

/**
 * Run scan-env-vars.js for the target's .pretty file.
 * Saves inventory to patches/<version>/env-vars.json and, if a previous
 * inventory exists, writes the diff to patches/<version>/env-diff-<prev>.json.
 *
 * Returns { version, envPath, diffPath?, diff?, prevVersion?, error? }.
 */
function runEnvScan(target) {
  const prettyPath = path.join(PROJECT_DIR, `cli.js.${target.type}.pretty`);

  if (!fs.existsSync(prettyPath)) {
    return { error: `cli.js.${target.type}.pretty not found` };
  }

  const version = target.version;
  const versionDir = path.join(PATCHES_DIR, version);
  const envPath = path.join(versionDir, 'env-vars.json');

  if (!fs.existsSync(versionDir)) {
    fs.mkdirSync(versionDir, { recursive: true });
  }

  const prev = findPreviousEnvJson(version);
  const spawnArgs = [ENV_SCAN_SCRIPT, prettyPath, '--save', envPath];
  if (prev) spawnArgs.push('--diff', prev.envPath);

  const result = spawnSync('node', spawnArgs, { encoding: 'utf8', timeout: 60000 });

  if (result.status !== 0) {
    return { error: `scan failed: ${(result.stderr || result.stdout || '').trim().split('\n')[0]}` };
  }

  const lines = (result.stdout || '').trim().split('\n');
  let diffMeta = null;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'env_diff_meta') { diffMeta = obj; break; }
    } catch { /* skip malformed lines */ }
  }

  const out = { version, envPath };

  if (prev && diffMeta) {
    const diffFileName = `env-diff-${prev.version}.json`;
    const diffPath = path.join(versionDir, diffFileName);
    const diffLines = lines.filter(l => {
      try { const o = JSON.parse(l); return ['env_diff_meta','env_removed','env_var'].includes(o.type) && (o.type !== 'env_var' || o.change); }
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
 * Format env scan results in condensed form (human mode only)
 */
function formatEnvScanCondensed(scanResult) {
  if (scanResult.error) {
    log(`Env vars: ⚠ ${scanResult.error}`);
  } else {
    log(`Env vars: ✓ patches/${scanResult.version}/env-vars.json`);
    if (scanResult.diff) {
      const d = scanResult.diff;
      log(`  diff vs ${scanResult.prevVersion}: +${d.addedCount} added, -${d.removedCount} removed, ~${d.changedCount} changed`);
    }
  }
  log('');
}

// ============ Changelog Impact Scan ============

/**
 * The most recent indexed version (has index.json) that predates `version`.
 * That's the version we're effectively porting FROM, so the changelog delta
 * (from, to] covers exactly what changed since our last working patch set.
 * Returns null when `version` is the earliest indexed version.
 */
function findPreviousIndexedVersion(version) {
  const prior = listAvailableVersions().filter(v => compareVersions(v, version) < 0);
  return prior.length ? prior[prior.length - 1] : null;
}

/**
 * Run scan-changelog.js for the target version.
 * Correlates the CHANGELOG delta (prevIndexed, target] against the target's
 * patch set, tags the patches that failed --check as broken, and writes
 * patches/<version>/changelog-impact.json.
 *
 * @param {object} target - { version, type, ... }
 * @param {string[]} brokenIds - patch ids that failed the check phase
 * @returns {{ version, from?, artifactPath?, versionCount?, entryCount?, brokenCount?, matchedPatchCount?, error? }}
 */
function runChangelogScan(target, brokenIds) {
  if (!fs.existsSync(CHANGELOG_PATH)) {
    return { error: `CHANGELOG.md not found (run --setup to clone claude-code)` };
  }

  const version = target.version;
  const versionDir = path.join(PATCHES_DIR, version);
  const indexPath = path.join(versionDir, 'index.json');
  if (!fs.existsSync(indexPath)) {
    return { error: `patches/${version}/index.json not found` };
  }

  const from = findPreviousIndexedVersion(version);
  const artifactPath = path.join(versionDir, 'changelog-impact.json');

  const spawnArgs = [CHANGELOG_SCAN_SCRIPT, CHANGELOG_PATH, '--to', version, '--index', indexPath, '--save', artifactPath];
  if (from) spawnArgs.push('--from', from);
  if (brokenIds && brokenIds.length) spawnArgs.push('--broken', brokenIds.join(','));

  const result = spawnSync('node', spawnArgs, { encoding: 'utf8', timeout: 60000 });

  if (result.status !== 0) {
    // A stale changelog (target newer than the cloned HEAD) is a warning, not a port failure.
    const firstErr = (result.stderr || result.stdout || '').trim().split('\n').pop();
    let msg = 'scan failed';
    try { msg = JSON.parse(firstErr).message || msg; } catch { msg = firstErr || msg; }
    return { error: msg, from };
  }

  // Pull the summary line + the per-patch impacts for broken patches. The
  // broken impacts get joined back into the work order (see buildWorkOrders)
  // so the port output carries triage inline instead of leaving it in the
  // artifact for a separate jq pass.
  let summary = null;
  const brokenImpacts = {};
  for (const line of (result.stdout || '').trim().split('\n')) {
    try {
      const o = JSON.parse(line);
      if (o.type === 'summary') summary = o;
      else if (o.type === 'impact' && o.broken) brokenImpacts[o.id] = o.matches || [];
    } catch { /* skip */ }
  }

  return {
    version,
    from,
    artifactPath,
    versionCount: summary?.versionCount,
    entryCount: summary?.entryCount,
    brokenCount: summary?.brokenCount,
    matchedPatchCount: summary?.matchedPatchCount,
    brokenImpacts,
  };
}

// ============ Broken-patch work order ============
//
// Joins everything needed to start fixing a broken patch into one record, so a
// port run is directly actionable without cross-referencing artifacts:
//   - file:      the patch source path (jump target)
//   - found:     discovery lines the patch emitted before failing (how far it
//                got — e.g. code-blocks found the hljs getter + ANSI comp but
//                died on the wrapper, which localises the break immediately)
//   - expected:  the patch's own "Expected: ..." diagnostic hints
//   - changelog: top changelog matches (triage — is this a real feature change
//                or noise? read the reasoning block in changelog-impact.json)

/**
 * Parse a patch's NDJSON output into { found[], expected[] }.
 * `found`   ← discovery events (label[=value]) — what matched before the failure.
 * `expected`← error message + details — what the patch was looking for.
 */
function parseDiagnostics(output) {
  const found = [];
  const expected = [];
  for (const line of (output || '').split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'discovery') {
      const v = o.value == null ? '' : (typeof o.value === 'string' ? o.value : JSON.stringify(o.value));
      found.push(v ? `${o.label}=${v}` : o.label);
    } else if (o.type === 'error' || o.type === 'warning') {
      // Multi-site patches (e.g. system-reminders) report a missed sub-patch via
      // `warning` + a final `result:failure` rather than `error`, so capture both
      // — otherwise those patches surface no hint at all.
      if (o.message) expected.push(o.message);
      if (Array.isArray(o.details)) for (const d of o.details) expected.push(d);
    }
  }
  return { found, expected };
}

/** Resolve patch id → source file path from the target version's index.json. */
function loadPatchFileMap(version) {
  const map = {};
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(PATCHES_DIR, version, 'index.json'), 'utf8'));
    const arr = Array.isArray(idx.patches)
      ? idx.patches
      : Object.values(idx.patches || {}).flat();
    for (const p of arr) map[p.id] = p.file;
  } catch { /* index missing — file stays null */ }
  return map;
}

/**
 * Build one work-order record per broken patch, joining check diagnostics with
 * changelog triage.
 */
function buildWorkOrders(target, checkResult, changelogScan) {
  const failed = (checkResult && checkResult.failed) || [];
  if (!failed.length) return [];
  const fileById = loadPatchFileMap(target.version);
  const impacts = (changelogScan && changelogScan.brokenImpacts) || {};
  return failed.map(f => {
    const { found, expected } = parseDiagnostics(f.output);
    return {
      id: f.id,
      file: fileById[f.id] ? `patches/${fileById[f.id]}` : null,
      reason: f.reason,
      found,
      expected,
      changelog: (impacts[f.id] || []).slice(0, 2)
        .map(m => ({ version: m.version, score: m.score, bullet: m.bullet })),
    };
  });
}

/**
 * Format the broken-patch work order in condensed form (human mode only).
 */
function formatWorkOrdersCondensed(orders) {
  if (!orders.length) return;
  log(`Broken patches — work order (${orders.length}):`);
  for (const o of orders) {
    log(`  ✗ ${o.id}${o.file ? `  → ${o.file}` : ''}`);
    if (o.found.length) log(`      found: ${o.found.slice(0, 5).join(' · ')}`);
    for (const e of o.expected.slice(0, 3)) log(`      hint: ${e}`);
    if (o.changelog.length) {
      const t = o.changelog[0];
      log(`      changelog[${t.score}] ${t.version}: ${t.bullet.slice(0, 100)}${t.bullet.length > 100 ? '…' : ''}`);
    }
  }
  log('  → triage verdicts (signal vs noise) live in the reasoning block of changelog-impact.json');
  log('');
}

/**
 * Format changelog scan results in condensed form (human mode only)
 */
function formatChangelogScanCondensed(scanResult) {
  if (scanResult.error) {
    log(`Changelog: ⚠ ${scanResult.error}`);
  } else {
    const range = scanResult.from ? `${scanResult.from} → ${scanResult.version}` : scanResult.version;
    log(`Changelog: ✓ patches/${scanResult.version}/changelog-impact.json`);
    log(`  ${range}: ${scanResult.entryCount} entries across ${scanResult.versionCount} versions`);
    if (scanResult.brokenCount > 0) {
      log(`  ⓘ ${scanResult.brokenCount} broken patch(es) tagged — read their matches first in the artifact`);
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

  // Phase 2.6: Env var scan
  const envScan = runEnvScan(target);
  formatEnvScanCondensed(envScan);
  emitJson({ type: 'port_env', ...envScan });

  // Phase 3: Check (dry run, quiet — we format condensed output)
  // Chunk-scope is a `--check` stage, not a port stage: it shadow-applies the
  // whole set against a pristine extract, which roughly doubles the runtime, and
  // it is only actionable once the patterns themselves match.
  const checkResult = applyPatches(target, true, null, { quiet: true, chunkScope: false });
  formatCheckCondensed(checkResult);
  emitJson({ type: 'port_check', ...buildSummary(checkResult, checkResult.total) });

  // Phase 3.5: Changelog impact scan (after check — needs the broken patch ids)
  const brokenIds = (checkResult.failed || []).map(f => f.id);
  const changelogScan = runChangelogScan(target, brokenIds);
  formatChangelogScanCondensed(changelogScan);
  // brokenImpacts is joined into the work order below — keep it out of the JSON event.
  const { brokenImpacts: _bi, ...changelogScanForJson } = changelogScan;
  emitJson({ type: 'port_changelog', ...changelogScanForJson });

  // Phase 3.6: Broken-patch work order — the actionable join of check
  // diagnostics + changelog triage, one record per broken patch.
  const workOrders = buildWorkOrders(target, checkResult, changelogScan);
  formatWorkOrdersCondensed(workOrders);
  emitJson({ type: 'port_broken', orders: workOrders });

  return { success: checkResult.success, setup: setupStatus, init: initResult, check: checkResult, changelog: changelogScanForJson, workOrders };
}

module.exports = { runPort };

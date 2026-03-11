/**
 * Init command — create patch index for a new CC version.
 */

const fs = require('fs');
const path = require('path');

const {
  PATCHES_DIR,
  listAvailableVersions,
  compareVersions,
} = require('./shared');

const { log } = require('./output');

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
    } = require('./prompt-baseline');

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

module.exports = { doInit };

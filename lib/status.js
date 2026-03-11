/**
 * Status command — display detected installations and workspace artifacts.
 */

const fs = require('fs');
const path = require('path');

const {
  PROJECT_DIR,
  readPatchMetadata,
  isPatched,
  extractVersion,
  formatBytes,
  safeStats,
  listRecentBaks,
} = require('./shared');

const { isJsonMode, emitJson } = require('./output');
const { extractJsFromBinaryToTemp } = require('./patch-runner');

/**
 * Get workspace artifact info (version, size, modification date)
 * @param {string} type - "bare" or "native"
 * @returns {{ original: object|null, pretty: object|null }}
 */
function getArtifactInfo(type) {
  const result = { original: null, pretty: null };

  for (const suffix of ['original', 'pretty']) {
    const filePath = path.join(PROJECT_DIR, `cli.js.${type}.${suffix}`);
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

/**
 * Print status of all detected installations
 * @param {{ bare: object|null, native: object|null }} installs
 */
function printStatus(installs) {
  // JSON mode: output structured object
  if (isJsonMode) {
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

      info.baks = install ? listRecentBaks(type, install.path).map(b => `${b.name} (${b.sizeMB} MB)`) : [];
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

    // .bak files (rollback points)
    const baks = listRecentBaks(type, install.path);
    if (baks.length > 0) {
      console.log(`    Backups: ${baks.map(b => `${b.name} (${b.sizeMB} MB)`).join(', ')}`);
    }

    console.log();
  }
}

module.exports = { printStatus };

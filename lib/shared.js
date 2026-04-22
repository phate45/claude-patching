/**
 * Shared utilities for claude-patching
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ============ Constants ============

const PROJECT_DIR = path.resolve(__dirname, '..');
const PATCHES_DIR = path.join(PROJECT_DIR, 'patches');
const PATCH_MARKER = '__CLAUDE_PATCHES__';

const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
const TRAILER_SIZE = 16;
const SIZE_MARKER_SIZE = 8;

// ============ Detection ============

/**
 * Check if a file starts with the ELF magic number.
 */
function isElfFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 0);
    fs.closeSync(fd);
    return header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46;
  } catch {
    return false;
  }
}

/**
 * Detect bare (pnpm/npm) installation.
 *
 * Since 2.1.117 the npm package is a wrapper: `bin/claude.exe` starts as a
 * 500-byte stub and is replaced by the postinstall script with a platform-
 * specific Bun ELF (hardlinked from an optional-dep package). We target that
 * binary — the JS payload is extracted via the Bun overlay pipeline, same as
 * the native install.
 *
 * @returns {{ type: 'bare', path: string, version: string } | null}
 */
function detectBareInstall() {
  const wrapperPath = path.join(os.homedir(), '.local/share/pnpm/claude');

  if (!fs.existsSync(wrapperPath)) {
    return null;
  }

  try {
    const wrapperContent = fs.readFileSync(wrapperPath, 'utf8');

    // New layout (2.1.117+): shim execs bin/claude.exe, which is the ELF after
    // postinstall. Parse the exec line to locate the package directory.
    const execMatch = wrapperContent.match(
      /\$basedir\/(global\/\d+\/\.pnpm\/@anthropic-ai\+claude-code@([^/]+)\/node_modules\/@anthropic-ai\/claude-code\/bin\/claude\.exe)/
    );
    if (execMatch) {
      const pnpmDir = path.join(os.homedir(), '.local/share/pnpm');
      const binaryPath = path.join(pnpmDir, execMatch[1]);
      if (fs.existsSync(binaryPath) && isElfFile(binaryPath)) {
        return {
          type: 'bare',
          path: binaryPath,
          version: execMatch[2],
        };
      }
    }

    // Legacy layout (≤2.1.116): package shipped cli.js directly.
    const legacyMatch = wrapperContent.match(
      /\$basedir\/(global\/\d+\/\.pnpm\/@anthropic-ai\+claude-code@([^/]+)\/node_modules\/@anthropic-ai\/claude-code\/cli\.js)/
    );
    if (legacyMatch) {
      const pnpmDir = path.join(os.homedir(), '.local/share/pnpm');
      const cliPath = path.join(pnpmDir, legacyMatch[1]);
      if (fs.existsSync(cliPath)) {
        return {
          type: 'bare',
          path: cliPath,
          version: legacyMatch[2],
        };
      }
    }
  } catch (err) {
    // Ignore errors
  }

  return null;
}

/**
 * Detect native (Bun binary) installation
 * @returns {{ type: 'native', path: string, version: string } | null}
 */
function detectNativeInstall() {
  const symlinkPath = path.join(os.homedir(), '.local/bin/claude');

  if (!fs.existsSync(symlinkPath)) {
    return null;
  }

  try {
    const realPath = fs.realpathSync(symlinkPath);

    // Check if it's an ELF binary (Bun-compiled)
    const fd = fs.openSync(realPath, 'r');
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 0);
    fs.closeSync(fd);

    // ELF magic number: 0x7f 'E' 'L' 'F'
    if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
      return null;
    }

    // Extract version from path (e.g., .../versions/2.1.17)
    const versionMatch = realPath.match(/versions\/([^/]+)$/);
    const version = versionMatch ? versionMatch[1] : 'unknown';

    return {
      type: 'native',
      path: realPath,
      version,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Detect all installations
 * @returns {{ bare: object|null, native: object|null }}
 */
function detectInstalls() {
  return {
    bare: detectBareInstall(),
    native: detectNativeInstall(),
  };
}

// ============ Metadata ============

/**
 * Read patch metadata from JS content
 * @param {string} content - JS file content
 * @returns {object|null} - Parsed metadata or null
 */
function readPatchMetadata(content) {
  const regex = new RegExp(`/\\* ${PATCH_MARKER} (\\{.*?\\}) \\*/`);
  const match = content.match(regex);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Check if content has patch metadata (is patched)
 * @param {string} content - JS file content
 * @returns {boolean}
 */
function isPatched(content) {
  return content.includes(PATCH_MARKER);
}

/**
 * Write patch metadata to JS content (after shebang if present)
 * @param {string} content - Original JS content
 * @param {object} metadata - Metadata to write
 * @returns {string} - Updated content
 */
function writePatchMetadata(content, metadata) {
  const metaComment = `/* ${PATCH_MARKER} ${JSON.stringify(metadata)} */\n`;

  // Remove existing metadata if present
  const cleanRegex = new RegExp(`/\\* ${PATCH_MARKER} \\{.*?\\} \\*/\\n?`);
  const cleanContent = content.replace(cleanRegex, '');

  // Insert after shebang (must stay on line 1) or prepend if no shebang
  if (cleanContent.startsWith('#!')) {
    const newlineIdx = cleanContent.indexOf('\n');
    const shebang = cleanContent.slice(0, newlineIdx + 1);
    const rest = cleanContent.slice(newlineIdx + 1);
    return shebang + metaComment + rest;
  }

  return metaComment + cleanContent;
}

// ============ Bun Binary ============

/**
 * Parse Bun binary structure
 * @param {Buffer} buffer - Binary content
 * @returns {{ valid: boolean, trailerOffset?: number, fileSize?: number, error?: string }}
 */
function parseBunBinary(buffer) {
  const fileSize = buffer.length;
  const trailerStart = fileSize - TRAILER_SIZE - SIZE_MARKER_SIZE;
  const trailerEnd = fileSize - SIZE_MARKER_SIZE;

  const trailer = buffer.slice(trailerStart, trailerEnd);

  if (!trailer.equals(BUN_TRAILER)) {
    return { valid: false, error: 'Bun trailer not found' };
  }

  const sizeMarker = buffer.slice(trailerEnd);
  const storedSize = Number(sizeMarker.readBigUInt64LE(0));

  if (storedSize !== fileSize) {
    return { valid: false, error: `Size mismatch: stored=${storedSize}, actual=${fileSize}` };
  }

  return {
    valid: true,
    trailerOffset: trailerStart,
    fileSize,
  };
}

// ============ Version Detection ============

/**
 * Extract Claude Code version from JS content
 * Looks for the VERSION:"X.Y.Z" constant in the bundled code.
 * @param {string} content - JS file content
 * @returns {string|null} - Version string or null
 */
function extractVersion(content) {
  // Prefer the Claude-specific context (avoids false matches from embedded libraries)
  const ctxMatch = content.match(/PACKAGE_URL:"@anthropic-ai\/claude-code"[^}]{0,200}VERSION:"(\d+\.\d+\.\d+)"/);
  if (ctxMatch) return ctxMatch[1];
  const match = content.match(/VERSION:"(\d+\.\d+\.\d+)"/);
  return match ? match[1] : null;
}

// ============ Utilities ============

/**
 * Format bytes as human-readable string
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Get file stats safely
 * @param {string} filePath
 * @returns {{ exists: boolean, size?: number, mtime?: Date }}
 */
function safeStats(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return { exists: true, size: stats.size, mtime: stats.mtime };
  } catch {
    return { exists: false };
  }
}

// ============ Patch Versions ============

/**
 * List available patch versions (directories with index.json)
 * @returns {string[]}
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
    .sort(compareVersions);
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
 */
function findFallbackVersion(targetVersion) {
  const available = listAvailableVersions();
  if (available.length === 0) return null;

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

/**
 * List the most recent .bak files for an install.
 *
 * Native: .bak files are siblings in the versions/ directory (e.g. 2.1.69.bak).
 * Bare: since 2.1.117 the target is bin/claude.exe inside each per-version
 *   pnpm package dir, so .bak sits next to it as bin/claude.exe.bak. We glob
 *   across version dirs by splitting at the @<version> segment. Also picks up
 *   legacy cli.js.bak entries from pre-2.1.117 installs that may still exist.
 */
function listRecentBaks(installType, targetPath, limit = 3) {
  let bakPaths = [];
  try {
    if (installType === 'native') {
      const dir = path.dirname(targetPath);
      bakPaths = fs.readdirSync(dir)
        .filter(f => f.endsWith('.bak'))
        .map(f => path.join(dir, f));
    } else {
      // Bare: targetPath ends with either .../bin/claude.exe (2.1.117+) or
      // .../cli.js (legacy). The .pnpm dir contains @anthropic-ai+claude-code@<ver>/
      // siblings; walk each one looking for either sibling .bak.
      const pnpmMatch = targetPath.match(/^(.+\/.pnpm)\/@anthropic-ai\+claude-code@[^/]+\/(.+)$/);
      if (pnpmMatch) {
        const pnpmDir = pnpmMatch[1];
        const relPath = pnpmMatch[2];
        const legacyRel = relPath.endsWith('/bin/claude.exe')
          ? relPath.replace(/\/bin\/claude\.exe$/, '/cli.js')
          : relPath;
        const modernRel = relPath.endsWith('/cli.js')
          ? relPath.replace(/\/cli\.js$/, '/bin/claude.exe')
          : relPath;
        const candidates = new Set([relPath, legacyRel, modernRel]);
        const entries = fs.readdirSync(pnpmDir)
          .filter(d => d.startsWith('@anthropic-ai+claude-code@'));
        for (const entry of entries) {
          for (const rel of candidates) {
            const candidate = path.join(pnpmDir, entry, rel + '.bak');
            if (fs.existsSync(candidate)) bakPaths.push(candidate);
          }
        }
      }
    }

    return bakPaths
      .map(full => {
        const stat = fs.statSync(full);
        const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
        let name = path.basename(full);
        if (installType === 'bare') {
          const verMatch = full.match(/@anthropic-ai\+claude-code@([^/]+)/);
          if (verMatch) name = `${verMatch[1]}.bak`;
        }
        return { name, mtime: stat.mtime, sizeMB };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch {
    return [];
  }
}

module.exports = {
  // Constants
  PROJECT_DIR,
  PATCHES_DIR,
  PATCH_MARKER,
  BUN_TRAILER,
  TRAILER_SIZE,
  SIZE_MARKER_SIZE,

  // Detection
  detectBareInstall,
  detectNativeInstall,
  detectInstalls,

  // Metadata
  readPatchMetadata,
  isPatched,
  writePatchMetadata,

  // Version detection
  extractVersion,

  // Bun binary
  parseBunBinary,

  // Patch versions
  listAvailableVersions,
  compareVersions,
  findFallbackVersion,
  listRecentBaks,

  // Utilities
  formatBytes,
  safeStats,
};

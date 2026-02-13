/**
 * Shared utilities for claude-patching
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ============ Constants ============

const PATCH_MARKER = '__CLAUDE_PATCHES__';

const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
const TRAILER_SIZE = 16;
const SIZE_MARKER_SIZE = 8;

// ============ Detection ============

/**
 * Detect bare (pnpm/npm) installation
 * @returns {{ type: 'bare', path: string, version: string } | null}
 */
function detectBareInstall() {
  const wrapperPath = path.join(os.homedir(), '.local/share/pnpm/claude');

  if (!fs.existsSync(wrapperPath)) {
    return null;
  }

  try {
    const wrapperContent = fs.readFileSync(wrapperPath, 'utf8');

    // Extract from NODE_PATH
    const nodePathMatch = wrapperContent.match(
      /NODE_PATH="([^"]*@anthropic-ai\+claude-code@([^/]+)\/node_modules\/@anthropic-ai\/claude-code)/
    );

    if (nodePathMatch) {
      const cliPath = path.join(nodePathMatch[1], 'cli.js');
      if (fs.existsSync(cliPath)) {
        return {
          type: 'bare',
          path: cliPath,
          version: nodePathMatch[2],
        };
      }
    }

    // Fallback: extract from exec line
    const execMatch = wrapperContent.match(
      /\$basedir\/(global\/\d+\/\.pnpm\/@anthropic-ai\+claude-code@([^/]+)\/node_modules\/@anthropic-ai\/claude-code\/cli\.js)/
    );

    if (execMatch) {
      const pnpmDir = path.join(os.homedir(), '.local/share/pnpm');
      const cliPath = path.join(pnpmDir, execMatch[1]);
      if (fs.existsSync(cliPath)) {
        return {
          type: 'bare',
          path: cliPath,
          version: execMatch[2],
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

module.exports = {
  // Constants
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

  // Utilities
  formatBytes,
  safeStats,
};

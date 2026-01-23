#!/usr/bin/env node
/**
 * Apply patches to Bun-compiled Claude Code binary
 *
 * The native Claude Code install uses Bun's compile feature to bundle
 * JS into a single executable. This script extracts the JS, runs the
 * existing patch scripts on it, then reassembles the binary.
 *
 * Binary structure:
 *   [ELF + Bun runtime] [JS payload] [\n---- Bun! ----\n] [8-byte size]
 *
 * Usage:
 *   node apply-patches-binary.js [options] [binary path]
 *
 * Options:
 *   --check   Dry run - verify patterns match without applying
 *   --status  Show binary info and exit
 *   --help    Show this help
 *
 * If no path provided, auto-discovers from ~/.local/bin/claude
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Bun binary markers
const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
const TRAILER_SIZE = 16;
const SIZE_MARKER_SIZE = 8;

// Reuse existing patch files (same as apply-patches.js)
const PATCHES = [
  { file: 'patch-thinking-visibility.js', id: 'thinking-visibility', version: '1.0' },
  { file: 'patch-thinking-style.js', id: 'thinking-style', version: '1.0' },
  { file: 'patch-spinner.js', id: 'spinner', version: '1.0' },
  { file: 'patch-ghostty-term.js', id: 'ghostty-term', version: '1.0' },
];

/**
 * Discover binary path from ~/.local/bin/claude symlink
 */
function discoverBinaryPath() {
  const symlinkPath = path.join(os.homedir(), '.local/bin/claude');

  if (!fs.existsSync(symlinkPath)) {
    return null;
  }

  try {
    const stats = fs.lstatSync(symlinkPath);
    if (stats.isSymbolicLink()) {
      // Resolve the symlink to get actual binary path
      return fs.realpathSync(symlinkPath);
    }
    // It's the actual binary
    return symlinkPath;
  } catch (err) {
    return null;
  }
}

/**
 * Extract version from binary path
 * e.g., /home/user/.local/share/claude/versions/2.1.17 -> 2.1.17
 */
function extractVersion(binaryPath) {
  const match = binaryPath.match(/versions\/([^/]+)$/);
  return match ? match[1] : 'unknown';
}

/**
 * Parse Bun binary structure
 * Returns: { valid, trailerOffset, payloadSize, fileSize }
 */
function parseBunBinary(buffer) {
  const fileSize = buffer.length;

  // Find trailer at end: [payload][trailer 16 bytes][size 8 bytes]
  const trailerStart = fileSize - TRAILER_SIZE - SIZE_MARKER_SIZE;
  const trailerEnd = fileSize - SIZE_MARKER_SIZE;

  const trailer = buffer.slice(trailerStart, trailerEnd);

  if (!trailer.equals(BUN_TRAILER)) {
    return { valid: false, error: 'Bun trailer not found - not a Bun executable?' };
  }

  // Read 8-byte size marker (little-endian u64)
  const sizeMarker = buffer.slice(trailerEnd);
  const storedSize = Number(sizeMarker.readBigUInt64LE(0));

  if (storedSize !== fileSize) {
    return {
      valid: false,
      error: `Size mismatch: stored=${storedSize}, actual=${fileSize}`,
    };
  }

  return {
    valid: true,
    trailerOffset: trailerStart,
    payloadSize: trailerStart, // Everything before trailer is ELF + payload
    fileSize,
  };
}

/**
 * Extract JS content to a temp file for patching
 * The patches expect utf8, but the binary stores latin1.
 * Fortunately, the JS content is ASCII-compatible, so this works.
 */
function extractJsToTemp(buffer, info) {
  const tempPath = path.join(os.tmpdir(), `claude-cli-${Date.now()}.js`);
  const jsContent = buffer.slice(0, info.trailerOffset);

  // Write as binary to preserve exact bytes
  fs.writeFileSync(tempPath, jsContent);

  return tempPath;
}

/**
 * Run a single patch script on the temp JS file
 */
function runPatch(patchPath, targetPath, dryRun) {
  const args = dryRun ? ['--check', targetPath] : [targetPath];

  try {
    const result = execSync(`node "${patchPath}" ${args.map(a => `"${a}"`).join(' ')}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    // Check if it's a "pattern not found" vs actual error
    const stderr = err.stderr || '';
    const stdout = err.stdout || '';
    if (stderr.includes('Could not find') || stdout.includes('Could not find')) {
      return { success: false, notFound: true, output: stderr || stdout };
    }
    return { success: false, output: stderr || err.message };
  }
}

/**
 * Reassemble binary from patched JS content
 */
function reassembleBinary(originalBuffer, patchedJsPath, outputPath) {
  const info = parseBunBinary(originalBuffer);
  if (!info.valid) {
    throw new Error(info.error);
  }

  // Read patched JS content
  const patchedJs = fs.readFileSync(patchedJsPath);

  // Build new binary: [patched JS][trailer][size]
  const newSize = patchedJs.length + TRAILER_SIZE + SIZE_MARKER_SIZE;
  const newBuffer = Buffer.alloc(newSize);

  // Copy patched JS
  patchedJs.copy(newBuffer, 0);

  // Add trailer
  BUN_TRAILER.copy(newBuffer, patchedJs.length);

  // Add size marker (little-endian u64)
  const sizeOffset = patchedJs.length + TRAILER_SIZE;
  newBuffer.writeBigUInt64LE(BigInt(newSize), sizeOffset);

  // Write to file
  fs.writeFileSync(outputPath, newBuffer);

  return {
    originalSize: originalBuffer.length,
    newSize,
    sizeDelta: newSize - originalBuffer.length,
  };
}

// ============ Main ============

function printHelp() {
  console.log(`
apply-patches-binary.js - Patch Bun-compiled Claude Code

USAGE
  node apply-patches-binary.js [options] [binary path]

OPTIONS
  --check    Dry run. Verify patterns match without modifying the binary.
  --status   Show binary structure info and exit.
  --help     Show this help message.

PATH DISCOVERY
  If no path provided, auto-discovers from ~/.local/bin/claude symlink.
  The symlink typically points to ~/.local/share/claude/versions/X.Y.Z

PATCHES (reuses existing patch scripts)
  ${PATCHES.map(p => p.id).join('\n  ')}

NOTES
  - Creates a .bak backup before patching
  - Extracts embedded JS, runs patches, reassembles with updated size marker
  - Safe to re-run (patches detect already-applied state)
`);
}

// Parse args
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

const dryRun = args.includes('--check');
const statusOnly = args.includes('--status');
const positionalArgs = args.filter(a => !a.startsWith('--'));
let targetPath = positionalArgs[0];

// Auto-discover if no path provided
if (!targetPath) {
  targetPath = discoverBinaryPath();
  if (targetPath) {
    console.log(`Auto-discovered: ${targetPath}`);
  } else {
    console.error('Could not auto-discover binary path.');
    console.error('');
    console.error('Expected symlink at ~/.local/bin/claude');
    console.error('For manual installation, provide the path:');
    console.error('');
    console.error('  node apply-patches-binary.js /path/to/claude');
    process.exit(1);
  }
}

// Verify target exists
if (!fs.existsSync(targetPath)) {
  console.error(`Error: ${targetPath} does not exist`);
  process.exit(1);
}

const ccVersion = extractVersion(targetPath);
console.log(`\nClaude Code version: ${ccVersion}`);
console.log(`Binary: ${targetPath}`);

// Read binary
const buffer = fs.readFileSync(targetPath);
const info = parseBunBinary(buffer);

if (!info.valid) {
  console.error(`\n❌ Invalid Bun binary: ${info.error}`);
  process.exit(1);
}

console.log(`\nBun binary structure:`);
console.log(`  File size: ${(info.fileSize / 1024 / 1024).toFixed(1)} MB`);
console.log(`  Payload size: ${(info.payloadSize / 1024 / 1024).toFixed(1)} MB`);
console.log(`  Trailer: ✓ found at offset ${info.trailerOffset}`);

if (statusOnly) {
  process.exit(0);
}

// Extract JS to temp file for patching
const tempJsPath = extractJsToTemp(buffer, info);
console.log(`\nExtracted JS to: ${tempJsPath}`);

const scriptDir = __dirname;

// Run patches on temp file
console.log(`\nRunning patches${dryRun ? ' (dry run)' : ''}:\n`);

let successCount = 0;
let failCount = 0;
let notFoundCount = 0;

for (const patch of PATCHES) {
  const patchPath = path.join(scriptDir, patch.file);

  if (!fs.existsSync(patchPath)) {
    console.log(`  ✗ ${patch.id}: patch file not found (${patch.file})`);
    failCount++;
    continue;
  }

  console.log(`→ ${patch.id}`);

  const result = runPatch(patchPath, tempJsPath, dryRun);

  if (result.success) {
    // Indent output
    const lines = result.output.split('\n').map(l => '  ' + l).join('\n');
    console.log(lines);
    successCount++;
  } else if (result.notFound) {
    console.log(`  ✗ Pattern not found (may be incompatible version or already applied)`);
    notFoundCount++;
  } else {
    console.log(`  ✗ Failed: ${result.output}`);
    failCount++;
  }
  console.log();
}

// Summary
if (dryRun) {
  console.log(`Dry run complete: ${successCount} matched, ${notFoundCount} not found, ${failCount} failed`);

  // Cleanup temp file
  fs.unlinkSync(tempJsPath);
  process.exit(failCount > 0 ? 1 : 0);
}

// Check if any patches were applied
if (successCount === 0) {
  console.log('No patches were applied.');
  fs.unlinkSync(tempJsPath);
  process.exit(notFoundCount === PATCHES.length ? 0 : 1);
}

// Create backup of original binary
const backupPath = targetPath + '.bak';
if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(targetPath, backupPath);
  console.log(`✓ Backed up original to ${backupPath}`);
}

// Reassemble binary with patched JS
try {
  const writeResult = reassembleBinary(buffer, tempJsPath, targetPath);
  console.log(`\n✓ Patched binary written`);
  console.log(`  Original: ${writeResult.originalSize} bytes`);
  console.log(`  Patched: ${writeResult.newSize} bytes`);
  console.log(`  Delta: ${writeResult.sizeDelta} bytes`);

  // Ensure executable
  fs.chmodSync(targetPath, 0o755);

  console.log('\n✓ Done! Restart Claude Code to see changes.');
} catch (err) {
  console.error(`\n❌ Failed to write patched binary: ${err.message}`);

  // Restore from backup
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, targetPath);
    console.log('Restored from backup');
  }
  process.exit(1);
} finally {
  // Cleanup temp file
  if (fs.existsSync(tempJsPath)) {
    fs.unlinkSync(tempJsPath);
  }
}

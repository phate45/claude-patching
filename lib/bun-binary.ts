/**
 * Bun binary extraction and repacking for native Claude Code installations.
 *
 * Properly handles the Bun binary format:
 * - Uses LIEF to extract ELF overlay (data after ELF sections)
 * - Parses Bun data region to find modules
 * - Recalculates all offsets when JS size changes
 * - Writes back via LIEF preserving ELF structure
 *
 * Reference: tweakcc's nativeInstallation.ts
 */

const fs = require('fs');
const LIEF = require('node-lief');

// Suppress verbose LIEF output
LIEF.logging.disable();

// ============ Constants ============

const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
const SIZEOF_STRING_POINTER = 8;  // u32 offset + u32 length
const SIZEOF_MODULE = 36;         // 4 StringPointers (32) + 4 flags (4)
const SIZEOF_OFFSETS = 32;

const DEBUG = process.env.DEBUG_BUN_BINARY;

function debug(...args: unknown[]): void {
  if (DEBUG) console.log('[bun-binary]', ...args);
}

// ============ Types ============

interface StringPointer {
  offset: number;
  length: number;
}

interface BunOffsets {
  byteCount: bigint;
  modulesPtr: StringPointer;
  entryPointId: number;
  compileExecArgvPtr: StringPointer;
}

interface BunModule {
  name: StringPointer;
  contents: StringPointer;
  sourcemap: StringPointer;
  bytecode: StringPointer;
  encoding: number;
  loader: number;
  moduleFormat: number;
  side: number;
}

interface BunData {
  bunData: Buffer;
  bunOffsets: BunOffsets;
  elfBinary: LIEF.ELF.Binary;
}

// ============ Parsing Functions ============

/**
 * Parse a StringPointer (offset + length) from buffer
 */
function parseStringPointer(buffer: Buffer, offset: number): StringPointer {
  return {
    offset: buffer.readUInt32LE(offset),
    length: buffer.readUInt32LE(offset + 4),
  };
}

/**
 * Parse the 32-byte OFFSETS structure
 */
function parseOffsets(buffer: Buffer): BunOffsets {
  return {
    byteCount: buffer.readBigUInt64LE(0),
    modulesPtr: parseStringPointer(buffer, 8),
    entryPointId: buffer.readUInt32LE(16),
    compileExecArgvPtr: parseStringPointer(buffer, 20),
    // bytes 28-31 are padding
  };
}

/**
 * Parse a single 36-byte module structure
 */
function parseModule(buffer: Buffer, offset: number): BunModule {
  return {
    name: parseStringPointer(buffer, offset),
    contents: parseStringPointer(buffer, offset + 8),
    sourcemap: parseStringPointer(buffer, offset + 16),
    bytecode: parseStringPointer(buffer, offset + 24),
    encoding: buffer.readUInt8(offset + 32),
    loader: buffer.readUInt8(offset + 33),
    moduleFormat: buffer.readUInt8(offset + 34),
    side: buffer.readUInt8(offset + 35),
  };
}

/**
 * Extract content from Bun data using a StringPointer
 */
function getStringContent(buffer: Buffer, ptr: StringPointer): Buffer {
  return buffer.subarray(ptr.offset, ptr.offset + ptr.length);
}

/**
 * Check if module name is the claude entry point
 */
function isClaudeModule(name: string): boolean {
  return (
    name.endsWith('/claude') ||
    name === 'claude' ||
    name.endsWith('/claude.exe') ||
    name === 'claude.exe'
  );
}

// ============ Module Iteration ============

/**
 * Iterate through all modules in the Bun data, calling visitor for each
 */
function mapModules<T>(
  bunData: Buffer,
  bunOffsets: BunOffsets,
  visitor: (module: BunModule, moduleName: string, index: number) => T | undefined
): T | undefined {
  const modulesListBytes = getStringContent(bunData, bunOffsets.modulesPtr);
  const modulesCount = Math.floor(modulesListBytes.length / SIZEOF_MODULE);

  debug(`Found ${modulesCount} modules`);

  for (let i = 0; i < modulesCount; i++) {
    const offset = i * SIZEOF_MODULE;
    const module = parseModule(modulesListBytes, offset);
    const moduleName = getStringContent(bunData, module.name).toString('utf-8');

    const result = visitor(module, moduleName, i);
    if (result !== undefined) {
      return result;
    }
  }

  return undefined;
}

// ============ Extraction ============

/**
 * Extract Bun data from an ELF binary's overlay
 *
 * ELF overlay layout:
 * [...ELF sections...][Bun data region][OFFSETS (32)][TRAILER (16)][totalByteCount (8)]
 */
function extractBunData(binaryPath: string): BunData {
  const elfBinary = LIEF.parse(binaryPath);

  if (!elfBinary) {
    throw new Error(`Failed to parse ELF binary: ${binaryPath}`);
  }

  if (!elfBinary.hasOverlay) {
    throw new Error('ELF binary has no overlay data');
  }

  const overlayData = elfBinary.overlay;

  if (overlayData.length < BUN_TRAILER.length + 8 + SIZEOF_OFFSETS) {
    throw new Error(`ELF overlay data too small: ${overlayData.length} bytes`);
  }

  debug(`Overlay size: ${overlayData.length} bytes`);

  // Read totalByteCount from last 8 bytes
  const totalByteCount = overlayData.readBigUInt64LE(overlayData.length - 8);

  if (totalByteCount < 4096n || totalByteCount > 2n ** 32n - 1n) {
    throw new Error(`ELF total byte count out of range: ${totalByteCount}`);
  }

  debug(`totalByteCount: ${totalByteCount}`);

  // Verify trailer at [len - 8 - trailer_len : len - 8]
  const trailerStart = overlayData.length - 8 - BUN_TRAILER.length;
  const trailerBytes = overlayData.subarray(trailerStart, overlayData.length - 8);

  if (!trailerBytes.equals(BUN_TRAILER)) {
    throw new Error('BUN trailer not found at expected position');
  }

  // Parse Offsets at [len - 8 - trailer_len - sizeof_offsets : len - 8 - trailer_len]
  const offsetsStart = overlayData.length - 8 - BUN_TRAILER.length - SIZEOF_OFFSETS;
  const offsetsBytes = overlayData.subarray(offsetsStart, trailerStart);
  const bunOffsets = parseOffsets(offsetsBytes);

  debug(`Offsets byteCount: ${bunOffsets.byteCount}`);
  debug(`Modules ptr: offset=${bunOffsets.modulesPtr.offset}, length=${bunOffsets.modulesPtr.length}`);

  // Validate byteCount from Offsets
  const byteCount = bunOffsets.byteCount;
  if (byteCount >= totalByteCount) {
    throw new Error(`Offsets byteCount (${byteCount}) >= totalByteCount (${totalByteCount})`);
  }

  // Extract data region using byteCount from Offsets
  const tailDataLen = 8 + BUN_TRAILER.length + SIZEOF_OFFSETS;
  const dataStart = overlayData.length - tailDataLen - Number(byteCount);
  const dataRegion = overlayData.subarray(dataStart, offsetsStart);

  debug(`Data region: ${dataStart} to ${offsetsStart} (${dataRegion.length} bytes)`);

  // Reconstruct full blob [data][offsets][trailer] for consistent handling
  const bunDataBlob = Buffer.concat([dataRegion, offsetsBytes, trailerBytes]);

  return {
    bunOffsets,
    bunData: bunDataBlob,
    elfBinary,
  };
}

/**
 * Extract the Claude JS module content from a native binary
 */
function extractClaudeJs(binaryPath: string): Buffer {
  const { bunData, bunOffsets } = extractBunData(binaryPath);

  const moduleNames: string[] = [];
  let claudeContents: Buffer | undefined;

  mapModules(bunData, bunOffsets, (module, moduleName) => {
    moduleNames.push(moduleName);

    if (isClaudeModule(moduleName)) {
      claudeContents = getStringContent(bunData, module.contents);
      debug(`Found Claude module: ${moduleName}, ${claudeContents.length} bytes`);
      return true; // Short-circuit
    }
    return undefined;
  });

  if (!claudeContents) {
    throw new Error(
      'Claude module not found in binary.\n' +
      'Expected module named "/$bunfs/root/claude" or "claude".\n' +
      `Found modules: ${moduleNames.join(', ')}`
    );
  }

  // Validate it's JS, not binary
  if (claudeContents[0] === 0x7f && claudeContents[1] === 0x45) {
    throw new Error('Extraction failed: got ELF binary instead of JS');
  }

  // Sanity check size (should be ~10MB)
  if (claudeContents.length < 1_000_000 || claudeContents.length > 50_000_000) {
    throw new Error(`Unexpected JS size: ${claudeContents.length} bytes (expected ~10MB)`);
  }

  return claudeContents;
}

// ============ Repacking ============

/**
 * Replace the Claude JS module contents in-place within the Bun data.
 *
 * The Bun binary format uses overlapping string regions (bytecode overlaps
 * source, etc.), so rebuilding the entire data region from scratch inflates
 * it massively. Instead, we do a surgical in-place replacement:
 *
 * - If the new JS is smaller or equal: overwrite at the original offset,
 *   pad the remainder with spaces to preserve the original size, and
 *   update the StringPointer length in the modules table.
 * - If the new JS is larger: error out (patches should never grow the JS
 *   significantly; if they do, the approach needs rethinking).
 */
function replaceClaudeJsInPlace(
  bunData: Buffer,
  bunOffsets: BunOffsets,
  modifiedJs: Buffer
): Buffer {
  // Find the claude module
  let claudeModule: BunModule | undefined;
  let claudeIndex: number | undefined;

  mapModules(bunData, bunOffsets, (module, moduleName, index) => {
    if (isClaudeModule(moduleName)) {
      claudeModule = module;
      claudeIndex = index;
      debug(`Found ${moduleName} at module index ${index}`);
      debug(`  contents: offset=${module.contents.offset}, length=${module.contents.length}`);
      return true;
    }
    return undefined;
  });

  if (!claudeModule || claudeIndex === undefined) {
    throw new Error('Claude module not found in binary during repack');
  }

  const originalLength = claudeModule.contents.length;
  const newLength = modifiedJs.length;
  const delta = newLength - originalLength;

  debug(`JS replacement: ${originalLength} -> ${newLength} (delta: ${delta})`);

  if (delta > 0) {
    throw new Error(
      `Patched JS is ${delta} bytes larger than original (${newLength} vs ${originalLength}).\n` +
      'In-place replacement requires new JS to be <= original size.\n' +
      'The patches may be adding too much code.'
    );
  }

  // Copy the entire bunData so we can modify it
  const result = Buffer.from(bunData);

  // Overwrite the claude contents region with modified JS
  modifiedJs.copy(result, claudeModule.contents.offset);

  // Pad remaining bytes with spaces (valid JS whitespace, preserves null terminator after region)
  if (delta < 0) {
    const padStart = claudeModule.contents.offset + newLength;
    const padLength = -delta;
    result.fill(0x20, padStart, padStart + padLength); // 0x20 = space
    debug(`Padded ${padLength} bytes with spaces`);
  }

  // Update the contents StringPointer length in the modules table.
  // The modules table is at bunOffsets.modulesPtr within bunData.
  // Each module is SIZEOF_MODULE (36) bytes, contents pointer is at offset +8.
  const moduleEntryOffset = bunOffsets.modulesPtr.offset + (claudeIndex * SIZEOF_MODULE);
  const contentsLengthOffset = moduleEntryOffset + 8 + 4; // +8 for contents field, +4 for offset (to get to length)
  result.writeUInt32LE(newLength, contentsLengthOffset);

  debug(`Updated contents length at byte ${contentsLengthOffset}: ${originalLength} -> ${newLength}`);

  return result;
}

/**
 * Replace JS in a native binary and write to output path
 *
 * Instead of using LIEF's write() (which reconstructs the entire ELF and can
 * produce pathologically large output), we splice the binary manually:
 * keep the original ELF bytes verbatim, replace only the overlay.
 */
function repackWithModifiedJs(
  binaryPath: string,
  modifiedJs: Buffer,
  outputPath: string
): void {
  const { bunData, bunOffsets, elfBinary } = extractBunData(binaryPath);

  debug(`Original bunData size: ${bunData.length}`);

  // In-place replacement: swap claude JS within the existing data layout.
  // This preserves the Bun format's overlapping string regions.
  const newBunData = replaceClaudeJsInPlace(bunData, bunOffsets, modifiedJs);

  debug(`New bunData size: ${newBunData.length}`);

  // Reconstruct overlay: [bunData (without offsets/trailer)][totalByteCount as u64 LE]
  // The bunData blob from extractBunData includes [dataRegion][offsets][trailer],
  // and the file format appends [totalByteCount] after the trailer.
  // Since we kept the same size, totalByteCount stays the same.
  const originalBinary = fs.readFileSync(binaryPath);
  const originalOverlay = elfBinary.overlay;
  const overlayStart = originalBinary.length - originalOverlay.length;

  // Rebuild overlay: [newBunData][totalByteCount from original]
  const totalByteCountBuf = originalOverlay.subarray(originalOverlay.length - 8);
  const newOverlay = Buffer.concat([newBunData, totalByteCountBuf]);

  debug(`ELF portion: 0..${overlayStart} (${overlayStart} bytes)`);
  debug(`Original overlay: ${originalOverlay.length} bytes`);
  debug(`New overlay: ${newOverlay.length} bytes`);

  // Splice: original ELF bytes + new overlay
  const elfPortion = originalBinary.subarray(0, overlayStart);

  // Write atomically (temp file + rename)
  const tempPath = outputPath + '.tmp';
  try {
    const fd = fs.openSync(tempPath, 'w');
    fs.writeSync(fd, elfPortion);
    fs.writeSync(fd, newOverlay);
    fs.closeSync(fd);

    // Preserve original file permissions
    const stat = fs.statSync(binaryPath);
    fs.chmodSync(tempPath, stat.mode);

    // Atomic rename
    fs.renameSync(tempPath, outputPath);
  } catch (err: unknown) {
    // Clean up temp file on error
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }

    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code: string }).code;
      if (code === 'ETXTBSY' || code === 'EBUSY') {
        throw new Error(
          'Cannot update Claude binary while it is running.\n' +
          'Please close all Claude instances and try again.'
        );
      }
    }
    throw err;
  }

  // Validate the output
  validateRepackedBinary(outputPath);
}

/**
 * Verify repacked binary has valid ELF header
 */
function validateRepackedBinary(outputPath: string): void {
  const header = Buffer.alloc(4);
  const fd = fs.openSync(outputPath, 'r');
  fs.readSync(fd, header, 0, 4, 0);
  fs.closeSync(fd);

  if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error(`Repacked binary missing ELF magic - corrupted: ${outputPath}`);
  }
}

// ============ Exports ============

module.exports = {
  extractClaudeJs,
  repackWithModifiedJs,
  // Expose internals for testing/debugging
  extractBunData,
  replaceClaudeJsInPlace,
  isClaudeModule,
};

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

interface ModuleMetadata {
  name: Buffer;
  contents: Buffer;
  sourcemap: Buffer;
  bytecode: Buffer;
  encoding: number;
  loader: number;
  moduleFormat: number;
  side: number;
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
 * Rebuild Bun data with modified JS content
 *
 * Layout: [strings with null terminators][modules table][compileExecArgv + null][OFFSETS][TRAILER]
 */
function repackBunData(
  bunData: Buffer,
  bunOffsets: BunOffsets,
  modifiedJs: Buffer
): Buffer {
  // Phase 1: Collect all module data
  const stringsData: Buffer[] = [];
  const modulesMetadata: ModuleMetadata[] = [];

  mapModules(bunData, bunOffsets, (module, moduleName) => {
    const nameBytes = getStringContent(bunData, module.name);

    // Replace claude module contents with modified JS
    let contentsBytes: Buffer;
    if (isClaudeModule(moduleName)) {
      contentsBytes = modifiedJs;
      debug(`Replacing ${moduleName}: ${module.contents.length} -> ${modifiedJs.length} bytes`);
    } else {
      contentsBytes = getStringContent(bunData, module.contents);
    }

    const sourcemapBytes = getStringContent(bunData, module.sourcemap);
    const bytecodeBytes = getStringContent(bunData, module.bytecode);

    modulesMetadata.push({
      name: nameBytes,
      contents: contentsBytes,
      sourcemap: sourcemapBytes,
      bytecode: bytecodeBytes,
      encoding: module.encoding,
      loader: module.loader,
      moduleFormat: module.moduleFormat,
      side: module.side,
    });

    // Each module contributes 4 strings (name, contents, sourcemap, bytecode)
    stringsData.push(nameBytes, contentsBytes, sourcemapBytes, bytecodeBytes);

    return undefined;
  });

  // Phase 2: Calculate new layout
  let currentOffset = 0;
  const stringOffsets: StringPointer[] = [];

  for (const stringData of stringsData) {
    stringOffsets.push({ offset: currentOffset, length: stringData.length });
    currentOffset += stringData.length + 1; // +1 for null terminator
  }

  const modulesListOffset = currentOffset;
  const modulesListSize = modulesMetadata.length * SIZEOF_MODULE;
  currentOffset += modulesListSize;

  // compileExecArgv is a separate string region
  const compileExecArgvBytes = getStringContent(bunData, bunOffsets.compileExecArgvPtr);
  const compileExecArgvOffset = currentOffset;
  const compileExecArgvLength = compileExecArgvBytes.length;
  currentOffset += compileExecArgvLength + 1; // +1 for null terminator

  const offsetsOffset = currentOffset;
  currentOffset += SIZEOF_OFFSETS;

  const trailerOffset = currentOffset;
  currentOffset += BUN_TRAILER.length;

  debug(`New buffer layout:`);
  debug(`  Strings: 0 - ${modulesListOffset}`);
  debug(`  Modules: ${modulesListOffset} - ${modulesListOffset + modulesListSize}`);
  debug(`  compileExecArgv: ${compileExecArgvOffset} - ${compileExecArgvOffset + compileExecArgvLength}`);
  debug(`  Offsets: ${offsetsOffset}`);
  debug(`  Trailer: ${trailerOffset}`);
  debug(`  Total: ${currentOffset} bytes`);

  // Phase 3: Build new buffer
  const newBuffer = Buffer.allocUnsafe(currentOffset);
  newBuffer.fill(0);

  // Write all strings with null terminators
  let stringIdx = 0;
  for (const { offset, length } of stringOffsets) {
    if (length > 0) {
      stringsData[stringIdx].copy(newBuffer, offset, 0, length);
    }
    newBuffer[offset + length] = 0; // null terminator
    stringIdx++;
  }

  // Write compileExecArgv
  if (compileExecArgvLength > 0) {
    compileExecArgvBytes.copy(newBuffer, compileExecArgvOffset, 0, compileExecArgvLength);
  }
  newBuffer[compileExecArgvOffset + compileExecArgvLength] = 0; // null terminator

  // Write module structures
  for (let i = 0; i < modulesMetadata.length; i++) {
    const metadata = modulesMetadata[i];
    const baseStringIdx = i * 4;
    const moduleOffset = modulesListOffset + i * SIZEOF_MODULE;
    let pos = moduleOffset;

    // Write 4 StringPointers (8 bytes each)
    newBuffer.writeUInt32LE(stringOffsets[baseStringIdx].offset, pos);
    newBuffer.writeUInt32LE(stringOffsets[baseStringIdx].length, pos + 4);
    pos += SIZEOF_STRING_POINTER;

    newBuffer.writeUInt32LE(stringOffsets[baseStringIdx + 1].offset, pos);
    newBuffer.writeUInt32LE(stringOffsets[baseStringIdx + 1].length, pos + 4);
    pos += SIZEOF_STRING_POINTER;

    newBuffer.writeUInt32LE(stringOffsets[baseStringIdx + 2].offset, pos);
    newBuffer.writeUInt32LE(stringOffsets[baseStringIdx + 2].length, pos + 4);
    pos += SIZEOF_STRING_POINTER;

    newBuffer.writeUInt32LE(stringOffsets[baseStringIdx + 3].offset, pos);
    newBuffer.writeUInt32LE(stringOffsets[baseStringIdx + 3].length, pos + 4);
    pos += SIZEOF_STRING_POINTER;

    // Write 4 flags (1 byte each)
    newBuffer.writeUInt8(metadata.encoding, pos);
    newBuffer.writeUInt8(metadata.loader, pos + 1);
    newBuffer.writeUInt8(metadata.moduleFormat, pos + 2);
    newBuffer.writeUInt8(metadata.side, pos + 3);
  }

  // Write OFFSETS structure
  // byteCount = offset of the OFFSETS structure (size of [data][OFFSETS][TRAILER])
  const newByteCount = BigInt(offsetsOffset);
  let pos = offsetsOffset;

  newBuffer.writeBigUInt64LE(newByteCount, pos);
  pos += 8;

  newBuffer.writeUInt32LE(modulesListOffset, pos);
  newBuffer.writeUInt32LE(modulesListSize, pos + 4);
  pos += 8;

  newBuffer.writeUInt32LE(bunOffsets.entryPointId, pos);
  pos += 4;

  newBuffer.writeUInt32LE(compileExecArgvOffset, pos);
  newBuffer.writeUInt32LE(compileExecArgvLength, pos + 4);
  // pos += 8 + 4 padding (we don't need to write padding, buffer is zeroed)

  // Write trailer
  BUN_TRAILER.copy(newBuffer, trailerOffset);

  return newBuffer;
}

/**
 * Replace JS in a native binary and write to output path
 */
function repackWithModifiedJs(
  binaryPath: string,
  modifiedJs: Buffer,
  outputPath: string
): void {
  const { bunData, bunOffsets, elfBinary } = extractBunData(binaryPath);

  debug(`Original bunData size: ${bunData.length}`);

  // Rebuild Bun data with modified JS
  const newBunData = repackBunData(bunData, bunOffsets, modifiedJs);

  debug(`New bunData size: ${newBunData.length}`);

  // Create new overlay: [newBunData][totalByteCount as u64 LE]
  // totalByteCount = size of entire overlay
  const totalByteCount = BigInt(newBunData.length + 8);
  const totalByteCountBuf = Buffer.alloc(8);
  totalByteCountBuf.writeBigUInt64LE(totalByteCount);

  const newOverlay = Buffer.concat([newBunData, totalByteCountBuf]);

  debug(`New overlay size: ${newOverlay.length}`);

  // Set new overlay on ELF binary
  elfBinary.overlay = newOverlay;

  // Write atomically (temp file + rename)
  const tempPath = outputPath + '.tmp';
  try {
    elfBinary.write(tempPath);

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
  repackBunData,
  isClaudeModule,
};

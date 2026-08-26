/**
 * Bun binary extraction and repacking for native Claude Code installations.
 *
 * Properly handles two Bun binary formats:
 * - Legacy (≤2.1.81): ELF overlay (data appended after ELF sections)
 *   Layout: [...ELF...][data][OFFSETS(32)][TRAILER(16)][totalByteCount(8)]
 * - Section (2.1.83+): Named `.bun` ELF section
 *   Layout: [totalByteCount(8)][data][OFFSETS(32)][TRAILER(16)]
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
// Bun's CompiledModuleGraphFile record. Two historical layouts:
//   OLD (≤ ~Bun that shipped pre-2.1.2xx): 4 StringPointers (32) + 4 u8 flags = 36
//   NEW (2.1.222+, incl. the 2.1.246 split): 6 StringPointers (48) + 4 u8 flags = 52
// NEW inserted `module_info` (+32) and `bytecode_origin_path` (+40) between the
// `bytecode` pointer and the trailing flags, pushing the flag bytes from +32 to +48.
// Confirmed against Bun's StandaloneModuleGraph.rs and the 2.1.246 round-trip spike.
const SIZEOF_MODULE_OLD = 36;
const SIZEOF_MODULE_NEW = 52;
const SIZEOF_OFFSETS = 32;

// Sanity bounds used when auto-detecting the module stride: module names are
// short `/$bunfs/root/...` paths, never anywhere near this long. A mis-strided
// walk reads a bogus name length (often multi-GB) — the original 2.1.246 OOM.
const MAX_MODULE_NAME_LEN = 4096;

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
  moduleInfo?: StringPointer;          // NEW layout only (+32)
  bytecodeOriginPath?: StringPointer;  // NEW layout only (+40)
  encoding: number;
  loader: number;
  moduleFormat: number;
  side: number;
}

/** One JS chunk in the transparent-concat model (design 2026-08-26). */
interface JsChunk {
  index: number;        // module-table index (identity for repack routing)
  name: string;         // /$bunfs/root/... module name
  contents: Buffer;     // raw content bytes (a view into bunData)
  origOffset: number;   // contents offset within bunData
  origLen: number;      // contents length within bunData
  entryOffset: number;  // absolute offset of this module's record in bunData
  bytecode: StringPointer;
  encoding: number;
  loader: number;
}

/** Result of concatenating JS chunks into one pristine corpus. */
interface ConcatResult {
  concat: Buffer;
  boundaries: Array<{ index: number; start: number; end: number }>;
}

type BunFormat = 'overlay' | 'section';

interface BunData {
  bunData: Buffer;
  bunOffsets: BunOffsets;
  elfBinary: LIEF.ELF.Binary;
  format: BunFormat;
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
 * Parse a single module record. Layout depends on the stride (36 vs 52) — the
 * NEW 52-byte record carries two extra StringPointers before the flag bytes.
 */
function parseModule(buffer: Buffer, offset: number, stride: number): BunModule {
  const base: BunModule = {
    name: parseStringPointer(buffer, offset),
    contents: parseStringPointer(buffer, offset + 8),
    sourcemap: parseStringPointer(buffer, offset + 16),
    bytecode: parseStringPointer(buffer, offset + 24),
    encoding: 0,
    loader: 0,
    moduleFormat: 0,
    side: 0,
  };

  if (stride >= SIZEOF_MODULE_NEW) {
    base.moduleInfo = parseStringPointer(buffer, offset + 32);
    base.bytecodeOriginPath = parseStringPointer(buffer, offset + 40);
    base.encoding = buffer.readUInt8(offset + 48);
    base.loader = buffer.readUInt8(offset + 49);
    base.moduleFormat = buffer.readUInt8(offset + 50);
    base.side = buffer.readUInt8(offset + 51);
  } else {
    base.encoding = buffer.readUInt8(offset + 32);
    base.loader = buffer.readUInt8(offset + 33);
    base.moduleFormat = buffer.readUInt8(offset + 34);
    base.side = buffer.readUInt8(offset + 35);
  }

  return base;
}

/**
 * Check whether a candidate stride yields a coherent module table.
 *
 * The table length must divide evenly by the stride, and a sample of records
 * (first, second, middle, last) must carry in-bounds name/contents pointers
 * with plausibly short names. A wrong stride reads misaligned u32s — typically
 * a giant name length that points past the buffer (the 2.1.246 OOM). We only
 * read u32s here and never decode a string, so validation itself is safe.
 */
function strideValid(tableBytes: Buffer, bunDataLen: number, stride: number): boolean {
  if (tableBytes.length === 0 || tableBytes.length % stride !== 0) return false;
  const count = tableBytes.length / stride;

  const sample = [...new Set([0, 1, Math.floor(count / 2), count - 1])].filter(i => i >= 0 && i < count);
  for (const i of sample) {
    const off = i * stride;
    const nameOff = tableBytes.readUInt32LE(off);
    const nameLen = tableBytes.readUInt32LE(off + 4);
    const contentOff = tableBytes.readUInt32LE(off + 8);
    const contentLen = tableBytes.readUInt32LE(off + 12);

    if (nameLen === 0 || nameLen > MAX_MODULE_NAME_LEN) return false;
    if (nameOff + nameLen > bunDataLen) return false;
    if (contentOff + contentLen > bunDataLen) return false;
  }
  return true;
}

/**
 * Determine the module-record stride (36 vs 52) for this binary.
 *
 * Prefer the NEW 52-byte layout (the go-forward format, 2.1.222+); fall back to
 * the legacy 36-byte layout for older binaries. Both are validated against the
 * actual pointer contents, so an ambiguous length that divides by both resolves
 * to whichever produces a coherent table.
 */
function detectModuleStride(bunData: Buffer, bunOffsets: BunOffsets): number {
  const tableBytes = getStringContent(bunData, bunOffsets.modulesPtr);
  const len = tableBytes.length;

  if (len % SIZEOF_MODULE_NEW === 0 && strideValid(tableBytes, bunData.length, SIZEOF_MODULE_NEW)) {
    return SIZEOF_MODULE_NEW;
  }
  if (len % SIZEOF_MODULE_OLD === 0 && strideValid(tableBytes, bunData.length, SIZEOF_MODULE_OLD)) {
    return SIZEOF_MODULE_OLD;
  }

  throw new Error(
    `Could not determine Bun module stride: modulesPtr.length=${len} ` +
    `divides by neither ${SIZEOF_MODULE_NEW} nor ${SIZEOF_MODULE_OLD} with valid pointers.`
  );
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
    name === 'claude.exe' ||
    // 2.1.69+ moved to src/entrypoints/cli.js
    name.endsWith('/src/entrypoints/cli.js')
  );
}

// ============ Module Iteration ============

/**
 * Iterate through all modules in the Bun data, calling visitor for each.
 * Auto-detects the record stride (36 vs 52) unless one is supplied.
 */
function mapModules<T>(
  bunData: Buffer,
  bunOffsets: BunOffsets,
  visitor: (module: BunModule, moduleName: string, index: number) => T | undefined,
  stride?: number
): T | undefined {
  const modulesListBytes = getStringContent(bunData, bunOffsets.modulesPtr);
  const size = stride ?? detectModuleStride(bunData, bunOffsets);
  const modulesCount = Math.floor(modulesListBytes.length / size);

  debug(`Found ${modulesCount} modules (stride ${size})`);

  for (let i = 0; i < modulesCount; i++) {
    const offset = i * size;
    const module = parseModule(modulesListBytes, offset, size);
    const moduleName = getStringContent(bunData, module.name).toString('utf-8');

    const result = visitor(module, moduleName, i);
    if (result !== undefined) {
      return result;
    }
  }

  return undefined;
}

// ============ Multi-Module Extraction (transparent concat) ============

/**
 * Extract every JS chunk from a native binary in module-table index order.
 *
 * Inclusion rule is `loader === 1` (JS) — NOT the module name suffix. Verified
 * in the Phase 0 spike: 2.1.246 carries 1405 real JS chunks at `loader=1`
 * (`encoding=1`, Latin1), while three `.js`-named modules are `loader=5` assets.
 * Non-JS modules (assets, `.node`, html) are skipped entirely.
 *
 * Returns the chunks plus the raw Bun data / offsets so callers (setup for the
 * read path, the repack for the write path) share one walk.
 */
function extractAllJsModules(binaryPath: string): {
  chunks: JsChunk[];
  bunData: Buffer;
  bunOffsets: BunOffsets;
  elfBinary: LIEF.ELF.Binary;
  format: BunFormat;
  stride: number;
} {
  const { bunData, bunOffsets, elfBinary, format } = extractBunData(binaryPath);
  const stride = detectModuleStride(bunData, bunOffsets);
  const tableBase = bunOffsets.modulesPtr.offset;
  const tableBytes = getStringContent(bunData, bunOffsets.modulesPtr);
  const count = Math.floor(tableBytes.length / stride);

  const chunks: JsChunk[] = [];
  for (let i = 0; i < count; i++) {
    const module = parseModule(tableBytes, i * stride, stride);
    if (module.loader !== 1) continue; // JS only

    chunks.push({
      index: i,
      name: getStringContent(bunData, module.name).toString('utf-8'),
      contents: getStringContent(bunData, module.contents),
      origOffset: module.contents.offset,
      origLen: module.contents.length,
      entryOffset: tableBase + i * stride,
      bytecode: module.bytecode,
      encoding: module.encoding,
      loader: module.loader,
    });
  }

  debug(`Extracted ${chunks.length} JS chunks of ${count} modules (stride ${stride})`);
  return { chunks, bunData, bunOffsets, elfBinary, format, stride };
}

/**
 * Concatenate JS chunk contents (index order) into one pristine corpus, with a
 * boundary index mapping concat offsets back to source chunks. The boundaries
 * are what the write path uses to route a match found in the concat to the
 * chunk buffer it lives in. Deterministic and recomputed from the live binary —
 * never persisted.
 */
function concatJsModules(chunks: JsChunk[]): ConcatResult {
  const boundaries: ConcatResult['boundaries'] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    const start = cursor;
    cursor += chunk.contents.length;
    boundaries.push({ index: chunk.index, start, end: cursor });
  }
  const concat = Buffer.concat(chunks.map(c => c.contents), cursor);
  return { concat, boundaries };
}

// ============ Extraction ============

/**
 * Extract Bun data from an ELF binary.
 *
 * Tries two formats:
 * 1. Legacy overlay: [...ELF...][data][OFFSETS(32)][TRAILER(16)][totalByteCount(8)]
 * 2. .bun section:  [totalByteCount(8)][data][OFFSETS(32)][TRAILER(16)]
 */
function extractBunData(binaryPath: string): BunData {
  const elfBinary = LIEF.parse(binaryPath);

  if (!elfBinary) {
    throw new Error(`Failed to parse ELF binary: ${binaryPath}`);
  }

  if (elfBinary.hasOverlay) {
    return extractFromOverlay(elfBinary);
  }

  // Try .bun section (2.1.83+ format)
  const bunSection = elfBinary.getSection('.bun');
  if (bunSection && bunSection.content) {
    return extractFromSection(elfBinary, bunSection);
  }

  throw new Error(
    'ELF binary has no overlay data and no .bun section.\n' +
    'This binary format is not recognized as a Bun standalone.'
  );
}

/**
 * Legacy format: overlay appended after ELF sections.
 * Layout: [data region][OFFSETS(32)][TRAILER(16)][totalByteCount(8)]
 */
function extractFromOverlay(elfBinary: LIEF.ELF.Binary): BunData {
  const overlayData = elfBinary.overlay;

  if (overlayData.length < BUN_TRAILER.length + 8 + SIZEOF_OFFSETS) {
    throw new Error(`ELF overlay data too small: ${overlayData.length} bytes`);
  }

  debug(`Overlay format, size: ${overlayData.length} bytes`);

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
    format: 'overlay',
  };
}

/**
 * Section format (2.1.83+): data in named `.bun` ELF section.
 * Layout: [totalByteCount(8)][data region][OFFSETS(32)][TRAILER(16)]
 */
function extractFromSection(elfBinary: LIEF.ELF.Binary, bunSection: LIEF.ELF.Section): BunData {
  const sectionData = Buffer.from(bunSection.content);
  const sectionSize = sectionData.length;

  if (sectionSize < 8 + SIZEOF_OFFSETS + BUN_TRAILER.length) {
    throw new Error(`.bun section too small: ${sectionSize} bytes`);
  }

  debug(`Section format, size: ${sectionSize} bytes`);

  // totalByteCount is the first 8 bytes
  const totalByteCount = sectionData.readBigUInt64LE(0);

  if (totalByteCount < 4096n || totalByteCount > 2n ** 32n - 1n) {
    throw new Error(`.bun section total byte count out of range: ${totalByteCount}`);
  }

  debug(`totalByteCount: ${totalByteCount}`);

  // Verify trailer at the very end (last 16 bytes)
  const trailerStart = sectionSize - BUN_TRAILER.length;
  const trailerBytes = sectionData.subarray(trailerStart);

  if (!trailerBytes.equals(BUN_TRAILER)) {
    throw new Error('BUN trailer not found at end of .bun section');
  }

  // Parse Offsets at [end - trailer_len - sizeof_offsets : end - trailer_len]
  const offsetsStart = sectionSize - BUN_TRAILER.length - SIZEOF_OFFSETS;
  const offsetsBytes = sectionData.subarray(offsetsStart, trailerStart);
  const bunOffsets = parseOffsets(offsetsBytes);

  debug(`Offsets byteCount: ${bunOffsets.byteCount}`);
  debug(`Modules ptr: offset=${bunOffsets.modulesPtr.offset}, length=${bunOffsets.modulesPtr.length}`);

  // Data region: bytes 8 through offsetsStart (skip the 8-byte totalByteCount header)
  const dataRegion = sectionData.subarray(8, offsetsStart);

  debug(`Data region: 8 to ${offsetsStart} (${dataRegion.length} bytes)`);

  // Reconstruct full blob [data][offsets][trailer] for consistent handling
  const bunDataBlob = Buffer.concat([dataRegion, offsetsBytes, trailerBytes]);

  return {
    bunOffsets,
    bunData: bunDataBlob,
    elfBinary,
    format: 'section',
  };
}

/**
 * Extract the Claude JS corpus from a native binary.
 *
 * Since CC 2.1.246 Bun splits the code across ~1400 JS chunk modules (the
 * legacy monolithic `/cli` module is now a 20KB bootstrap stub). We return the
 * **transparent concat** of every `loader===1` chunk in module-table order —
 * for older single-module binaries this is just that one module, so the return
 * contract (one JS Buffer) is unchanged and callers need no edits.
 *
 * The concat is returned as raw bytes; `setup.js`/`patch-runner.js` write the
 * Buffer without re-encoding, so the corpus is byte-faithful (Latin1-safe).
 */
function extractClaudeJs(binaryPath: string): Buffer {
  const { chunks } = extractAllJsModules(binaryPath);

  if (chunks.length === 0) {
    throw new Error('No JS modules (loader===1) found in binary.');
  }

  const { concat } = concatJsModules(chunks);

  // Validate it's JS, not a stray binary (first chunk must not be an ELF).
  if (concat[0] === 0x7f && concat[1] === 0x45) {
    throw new Error('Extraction failed: got ELF binary instead of JS');
  }

  // Sanity check total size (single-module ~10MB; 2.1.246 split concat ~36MB).
  if (concat.length < 1_000_000 || concat.length > 80_000_000) {
    throw new Error(`Unexpected JS corpus size: ${concat.length} bytes (${chunks.length} chunks)`);
  }

  debug(`Concatenated ${chunks.length} JS chunks -> ${concat.length} bytes`);
  return concat;
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
  const stride = detectModuleStride(bunData, bunOffsets);

  // Guard: this single-module in-place path only works when exactly one JS
  // module (loader===1) carries the code. Multi-module binaries (CC 2.1.246+)
  // are routed to repackMultiModule by repackWithModifiedJs before reaching
  // here, so this is a defensive check for any direct caller.
  let jsModuleCount = 0;
  mapModules(bunData, bunOffsets, (module) => {
    if (module.loader === 1 && module.contents.length > 0) jsModuleCount++;
    return undefined;
  }, stride);
  if (jsModuleCount > 1) {
    throw new Error(
      `Multi-module binary (${jsModuleCount} JS chunks): use repackMultiModule, not ` +
      `replaceClaudeJsInPlace. See docs/plans/2026-08-26-multi-module-patching-design.md.`
    );
  }

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
  }, stride);

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
  // Each module is `stride` bytes; contents pointer is at offset +8.
  const moduleEntryOffset = bunOffsets.modulesPtr.offset + (claudeIndex * stride);
  const contentsLengthOffset = moduleEntryOffset + 8 + 4; // +8 for contents field, +4 for offset (to get to length)
  result.writeUInt32LE(newLength, contentsLengthOffset);

  debug(`Updated contents length at byte ${contentsLengthOffset}: ${originalLength} -> ${newLength}`);

  // ── Invalidate the embedded bytecode (CRITICAL — see below) ──────────────
  //
  // Bun `--compile --bytecode` binaries embed a precompiled JSC bytecode blob
  // alongside the JS source. At runtime Bun runs that bytecode and lazily
  // compiles uncached functions from the source using byte-offset ranges
  // baked into the bytecode. Our in-place source edits change byte offsets
  // (net deletions shift everything downstream), so any function the bytecode
  // resolves by offset now slices the WRONG bytes from the patched source —
  // silently breaking code paths whose stale offsets happen to misalign
  // (e.g. the skill_listing attachment builder, which throws and gets
  // swallowed by the attachment try/catch, so the skill roster never reaches
  // the model). Symptoms are partial and version-fragile.
  //
  // We don't regenerate the bytecode (that needs Bun's compiler). Instead we
  // zero the module's bytecode StringPointer so Bun finds no bytecode and
  // compiles everything from the patched source — the source IS our source of
  // truth. The 123 MB blob stays in the data region as dead bytes (zeroing
  // the pointer, not the bytes, preserves every other offset and the region
  // size). On pre-bytecode builds this is a no-op (pointer already {0,0}).
  //
  // The bytecode StringPointer sits at module +24 (offset u32) / +28 (length).
  const bytecodeOffsetField = moduleEntryOffset + 24;
  const bytecodeLengthField = moduleEntryOffset + 28;
  const oldBytecodeLen = result.readUInt32LE(bytecodeLengthField);
  result.writeUInt32LE(0, bytecodeOffsetField);
  result.writeUInt32LE(0, bytecodeLengthField);

  debug(`Zeroed bytecode StringPointer (was ${oldBytecodeLen} bytes) to force source compilation`);

  return result;
}

/**
 * Replace JS in a native binary and write to output path.
 *
 * Handles both formats:
 * - Overlay: splice ELF bytes + new overlay (avoids LIEF's bloated write)
 * - Section: direct binary splice at section offset within the file
 */
function repackWithModifiedJs(
  binaryPath: string,
  modifiedJs: Buffer,
  outputPath: string
): void {
  // Multi-module (2.1.246+): route the patched concat back to individual chunks.
  const { chunks } = extractAllJsModules(binaryPath);
  if (chunks.length > 1) {
    repackMultiModule(binaryPath, modifiedJs, outputPath);
    return;
  }

  const { bunData, bunOffsets, elfBinary, format } = extractBunData(binaryPath);

  debug(`Original bunData size: ${bunData.length}, format: ${format}`);

  // In-place replacement: swap claude JS within the existing data layout.
  // This preserves the Bun format's overlapping string regions.
  const newBunData = replaceClaudeJsInPlace(bunData, bunOffsets, modifiedJs);

  debug(`New bunData size: ${newBunData.length}`);

  const originalBinary = fs.readFileSync(binaryPath);

  if (format === 'overlay') {
    repackOverlay(originalBinary, elfBinary, newBunData, outputPath, binaryPath);
  } else {
    repackSection(originalBinary, elfBinary, newBunData, outputPath, binaryPath);
  }

  // Validate the output
  validateRepackedBinary(outputPath);
}

/**
 * Repack using the legacy overlay format.
 */
function repackOverlay(
  originalBinary: Buffer,
  elfBinary: LIEF.ELF.Binary,
  newBunData: Buffer,
  outputPath: string,
  binaryPath: string
): void {
  const originalOverlay = elfBinary.overlay;
  const overlayStart = originalBinary.length - originalOverlay.length;

  // Rebuild overlay: [newBunData][totalByteCount from original]
  const totalByteCountBuf = originalOverlay.subarray(originalOverlay.length - 8);
  const newOverlay = Buffer.concat([newBunData, totalByteCountBuf]);

  debug(`ELF portion: 0..${overlayStart} (${overlayStart} bytes)`);
  debug(`Original overlay: ${originalOverlay.length} bytes`);
  debug(`New overlay: ${newOverlay.length} bytes`);

  const elfPortion = originalBinary.subarray(0, overlayStart);

  writeAtomically(outputPath, binaryPath, (fd) => {
    fs.writeSync(fd, elfPortion);
    fs.writeSync(fd, newOverlay);
  });
}

/**
 * Repack using the .bun section format.
 *
 * The section is at a fixed offset in the file. We write the full binary
 * as a copy, then overwrite just the section's data region in place.
 * The section size doesn't change (in-place replacement preserves sizes).
 */
function repackSection(
  originalBinary: Buffer,
  elfBinary: LIEF.ELF.Binary,
  newBunData: Buffer,
  outputPath: string,
  binaryPath: string
): void {
  const bunSection = elfBinary.getSection('.bun');
  if (!bunSection) {
    throw new Error('.bun section disappeared during repack');
  }

  const sectionOffset = Number(bunSection.offset);
  const sectionSize = Number(bunSection.size);

  // Section layout: [totalByteCount(8)][data][OFFSETS(32)][TRAILER(16)]
  // newBunData is [data][OFFSETS(32)][TRAILER(16)] — need to prepend totalByteCount
  const totalByteCountBuf = Buffer.alloc(8);
  // Read original totalByteCount from the section start
  originalBinary.copy(totalByteCountBuf, 0, sectionOffset, sectionOffset + 8);

  const newSectionContent = Buffer.concat([totalByteCountBuf, newBunData]);

  if (newSectionContent.length !== sectionSize) {
    throw new Error(
      `Section size mismatch: expected ${sectionSize}, got ${newSectionContent.length}.\n` +
      'In-place replacement should preserve section size.'
    );
  }

  debug(`Section at offset ${sectionOffset}, size ${sectionSize}`);
  debug(`Writing modified section content (${newSectionContent.length} bytes)`);

  // Copy full binary, splice in the new section content
  writeAtomically(outputPath, binaryPath, (fd) => {
    // Write everything before the section
    fs.writeSync(fd, originalBinary.subarray(0, sectionOffset));
    // Write the modified section
    fs.writeSync(fd, newSectionContent);
    // Write everything after the section
    fs.writeSync(fd, originalBinary.subarray(sectionOffset + sectionSize));
  });
}

/**
 * Write to a temp file then atomically rename into place.
 */
function writeAtomically(
  outputPath: string,
  binaryPath: string,
  writer: (fd: number) => void
): void {
  const tempPath = outputPath + '.tmp';
  try {
    const fd = fs.openSync(tempPath, 'w');
    writer(fd);
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

// ============ Multi-Module Repack (Phase B — write path) ============
//
// Since CC 2.1.246 the code is split across ~1400 JS chunks and `extractClaudeJs`
// returns their transparent concat. Patches rewrite that concat opaquely (they
// are subprocesses doing find/replace on the temp file), so on apply we recover
// the edits by DIFFING the pristine concat against the patched one, route each
// edit hunk back to the single chunk it lives in (by original concat offset),
// rebuild that chunk's content, and repack per-chunk (shrink+pad+length-update+
// bytecode-zero — the primitive proven by the Phase 0 spike). A final
// reconstruction check (rebuilt concat === patched concat) guards correctness
// before the binary is touched; a hunk that straddles a chunk boundary aborts.
// Design: docs/plans/2026-08-26-multi-module-patching-design.md.

// The __CLAUDE_PATCHES__ metadata comment is prepended to the concat by
// writePatchMetadata (shared.js). Left in place it would land at concat offset 0
// and grow chunk 0 past its original length (illegal under shrink-only). We
// strip it before diffing and re-inject it into a chunk that has slack.
const META_RE = /\/\* __CLAUDE_PATCHES__ \{[\s\S]*?\} \*\/\n?/;

/** Longest common prefix (in bytes) of a[aLo,aHi) and b[bLo,bHi). */
function commonPrefixLen(a: Buffer, b: Buffer, aLo: number, aHi: number, bLo: number, bHi: number): number {
  const max = Math.min(aHi - aLo, bHi - bLo);
  const BLK = 65536;
  let i = 0;
  while (i < max) {
    const n = Math.min(BLK, max - i);
    if (a.compare(b, bLo + i, bLo + i + n, aLo + i, aLo + i + n) === 0) { i += n; continue; }
    for (let j = 0; j < n; j++) if (a[aLo + i + j] !== b[bLo + i + j]) return i + j;
  }
  return max;
}

/** Longest common suffix (in bytes) of a[aLo,aHi) and b[bLo,bHi). */
function commonSuffixLen(a: Buffer, b: Buffer, aLo: number, aHi: number, bLo: number, bHi: number): number {
  const max = Math.min(aHi - aLo, bHi - bLo);
  const BLK = 65536;
  let i = 0;
  while (i < max) {
    const n = Math.min(BLK, max - i);
    if (a.compare(b, bHi - i - n, bHi - i, aHi - i - n, aHi - i) === 0) { i += n; continue; }
    for (let j = 0; j < n; j++) if (a[aHi - i - 1 - j] !== b[bHi - i - 1 - j]) return i + j;
  }
  return max;
}

interface Hunk { srcStart: number; srcEnd: number; bytes: Buffer; }

/**
 * Recover the set of edit hunks turning `src` (pristine concat) into `dst`
 * (patched concat). Divide-and-conquer: trim common prefix/suffix, and if the
 * residual differing region still spans more than one chunk, split it at an
 * interior anchor (a 64-byte window shared by both sides) and recurse. A region
 * confined to one chunk becomes a single hunk (the whole span, unchanged middle
 * included — correct, since we replace the exact byte range in that chunk).
 */
function recoverHunks(
  src: Buffer,
  dst: Buffer,
  chunkPosAt: (off: number) => number,
  boundaries: ConcatResult['boundaries']
): Hunk[] {
  const hunks: Hunk[] = [];
  const W = 64;

  // Primary anchor: split at an interior CHUNK BOUNDARY. Since no patch edit
  // straddles a boundary, the bytes around every interior boundary are unedited,
  // so a boundary is a guaranteed sync point — and splitting there keeps every
  // sub-region chunk-aligned, driving the recursion straight to single chunks.
  // A chunk whose very first bytes were edited is handled by probing the tail of
  // the preceding chunk instead. Returns a zero-width split {s0==s1, d0==d1}.
  function boundaryAnchor(sLo: number, sHi: number, dLo: number, dHi: number) {
    const kLo = chunkPosAt(sLo);
    const kHi = chunkPosAt(sHi - 1);
    for (let k = kLo; k < kHi; k++) {
      const b = boundaries[k].end; // interior boundary: end of chunk k == start of chunk k+1
      if (b <= sLo || b >= sHi) continue;
      // Probe the start of chunk k+1 (unedited unless an edit begins at its head).
      if (b + W <= sHi) {
        const idx = dst.indexOf(src.subarray(b, b + W), dLo);
        if (idx >= 0 && idx + W <= dHi) return { s0: b, s1: b, d0: idx, d1: idx };
      }
      // Fall back to the tail of chunk k (unedited unless an edit ends at its tail).
      if (b - W >= sLo) {
        const idx = dst.indexOf(src.subarray(b - W, b), dLo);
        if (idx >= 0 && idx + W <= dHi) return { s0: b, s1: b, d0: idx + W, d1: idx + W };
      }
    }
    return null;
  }

  // Fallback anchor: a shared 64-byte window sampled from dst, located in src.
  function windowAnchor(sLo: number, sHi: number, dLo: number, dHi: number) {
    for (const f of [0.5, 0.25, 0.75, 0.12, 0.88]) {
      let dp = dLo + Math.floor((dHi - dLo) * f);
      if (dp + W > dHi) dp = dHi - W;
      if (dp < dLo) continue;
      const probe = dst.subarray(dp, dp + W);
      const idx = src.indexOf(probe, sLo);
      if (idx < 0 || idx + W > sHi) continue;
      let s0 = idx, s1 = idx + W, d0 = dp, d1 = dp + W;
      while (s0 > sLo && d0 > dLo && src[s0 - 1] === dst[d0 - 1]) { s0--; d0--; }
      while (s1 < sHi && d1 < dHi && src[s1] === dst[d1]) { s1++; d1++; }
      return { s0, s1, d0, d1 };
    }
    return null;
  }

  const findAnchor = (sLo: number, sHi: number, dLo: number, dHi: number) =>
    boundaryAnchor(sLo, sHi, dLo, dHi) || windowAnchor(sLo, sHi, dLo, dHi);

  function rec(sLo: number, sHi: number, dLo: number, dHi: number): void {
    const p = commonPrefixLen(src, dst, sLo, sHi, dLo, dHi); sLo += p; dLo += p;
    const s = commonSuffixLen(src, dst, sLo, sHi, dLo, dHi); sHi -= s; dHi -= s;
    if (sLo === sHi && dLo === dHi) return; // identical region

    const cA = chunkPosAt(sLo);
    const cB = sHi > sLo ? chunkPosAt(sHi - 1) : cA;
    if (cA === cB) { hunks.push({ srcStart: sLo, srcEnd: sHi, bytes: dst.subarray(dLo, dHi) }); return; }

    const anc = findAnchor(sLo, sHi, dLo, dHi);
    if (!anc) { hunks.push({ srcStart: sLo, srcEnd: sHi, bytes: dst.subarray(dLo, dHi) }); return; } // straddle → caught by guard
    rec(sLo, anc.s0, dLo, anc.d0);
    rec(anc.s1, sHi, anc.d1, dHi);
  }

  rec(0, src.length, 0, dst.length);
  return hunks;
}

/**
 * Repack a multi-module (2.1.246+) binary from the patched concat.
 * `modifiedJs` is the concat as rewritten by the patch subprocesses, carrying
 * the prepended __CLAUDE_PATCHES__ comment.
 */
function repackMultiModule(binaryPath: string, modifiedJs: Buffer, outputPath: string): void {
  const { chunks, bunData, elfBinary, format } = extractAllJsModules(binaryPath);
  const { concat: pristine, boundaries } = concatJsModules(chunks);

  // Peel the metadata comment off the front; it is re-injected into a slack chunk.
  const modStr = modifiedJs.toString('latin1');
  const metaMatch = modStr.match(META_RE);
  const meta = metaMatch ? metaMatch[0] : null;
  const bodyStr = meta ? modStr.replace(META_RE, '') : modStr;
  const body = Buffer.from(bodyStr, 'latin1');

  const total = pristine.length;
  const starts = boundaries.map(b => b.start);
  const chunkPosAt = (off: number): number => {
    if (off >= total) return boundaries.length - 1;
    let lo = 0, hi = boundaries.length - 1, ans = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= off) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  };

  const hunks = recoverHunks(pristine, body, chunkPosAt, boundaries);

  // Group hunks by chunk position; a straddle is a hard error.
  const byChunk = new Map(); // pos -> Hunk[]
  for (const h of hunks) {
    const a = chunkPosAt(h.srcStart);
    const b = h.srcEnd > h.srcStart ? chunkPosAt(h.srcEnd - 1) : a;
    if (a !== b) {
      throw new Error(
        `Patch edit straddles chunk boundary (chunks ${boundaries[a].index}..${boundaries[b].index}, ` +
        `concat offset ${h.srcStart}-${h.srcEnd}). Multi-module routing requires each edit within one chunk.`
      );
    }
    if (!byChunk.has(a)) byChunk.set(a, []);
    byChunk.get(a).push(h);
  }

  // Rebuild each edited chunk's content (edits applied back-to-front).
  const newContent = new Map(); // pos -> Buffer
  for (const [pos, hs] of byChunk) {
    const bnd = boundaries[pos];
    let buf = Buffer.from(pristine.subarray(bnd.start, bnd.end));
    const local = hs.map((h: Hunk) => ({ start: h.srcStart - bnd.start, end: h.srcEnd - bnd.start, bytes: h.bytes }))
      .sort((x: { start: number }, y: { start: number }) => x.start - y.start);
    for (let k = local.length - 1; k >= 0; k--) {
      const e = local[k];
      buf = Buffer.concat([buf.subarray(0, e.start), e.bytes, buf.subarray(e.end)]);
    }
    newContent.set(pos, buf);
  }

  // Verify routing: reconstructing the concat from routed chunks must reproduce
  // the patched body exactly. This is the correctness gate — if the diff
  // mis-routed anything, we abort here, before the binary is touched.
  {
    const parts = [];
    for (let pos = 0; pos < boundaries.length; pos++) {
      parts.push(newContent.has(pos) ? newContent.get(pos) : pristine.subarray(boundaries[pos].start, boundaries[pos].end));
    }
    const rebuilt = Buffer.concat(parts);
    if (!rebuilt.equals(body)) {
      throw new Error(
        `Multi-module routing verification failed: rebuilt concat (${rebuilt.length}B) ` +
        `!= patched concat (${body.length}B). Diff routing is unsound; binary untouched.`
      );
    }
  }

  // Re-inject the metadata comment into the edited chunk with the most slack.
  if (meta) {
    let best = -1, bestSlack = -1;
    for (const [pos, buf] of newContent) {
      const slack = (boundaries[pos].end - boundaries[pos].start) - buf.length;
      if (slack > bestSlack) { bestSlack = slack; best = pos; }
    }
    if (best < 0 || bestSlack < meta.length) {
      throw new Error(`No edited chunk has slack (${bestSlack}B) to store the ${meta.length}B patch metadata comment.`);
    }
    newContent.set(best, Buffer.concat([newContent.get(best), Buffer.from(meta, 'latin1')]));
  }

  // Splice each edited chunk in place: content at original offset, pad to
  // original length (space), update the contents StringPointer length, zero the
  // bytecode pointer (force recompile from patched source). Offsets never move,
  // section size stays constant. See replaceClaudeJsInPlace for the rationale.
  // A patch may GROW its chunk (an injection patch: feature-flag toggles, cron
  // visibility, spinner frames, …). It cannot grow in place — the next chunk's
  // bytes sit immediately after. But every edited chunk's bytecode pointer is
  // zeroed anyway (recompile from source), so its bytecode region becomes dead
  // space — and Phase 0 proved contents regions never overlap bytecode regions.
  // So a grown chunk RELOCATES into its own freed bytecode region (repoint the
  // contents StringPointer offset there). Shrunk/equal chunks stay in place.
  const unplaceable = [];
  for (const [pos, buf] of newContent) {
    const chunk = chunks[pos];
    if (buf.length > chunk.origLen && buf.length > chunk.bytecode.length) {
      const bnd = boundaries[pos];
      const pfx = commonPrefixLen(pristine, buf, bnd.start, bnd.end, 0, buf.length);
      const snip = buf.subarray(pfx, Math.min(pfx + 80, buf.length)).toString('latin1');
      unplaceable.push(
        `chunk ${chunk.index}: ${chunk.origLen} -> ${buf.length} (+${buf.length - chunk.origLen}), ` +
        `bytecode region only ${chunk.bytecode.length}B — near "${snip}"`
      );
    }
  }
  if (unplaceable.length > 0) {
    throw new Error(
      `cannot place ${unplaceable.length} grown chunk(s) — growth exceeds the freed bytecode region:\n  ` +
      unplaceable.join('\n  ')
    );
  }

  const result = Buffer.from(bunData);
  for (const [pos, buf] of newContent) {
    const chunk = chunks[pos];
    if (buf.length <= chunk.origLen) {
      // In place: overwrite at original offset, pad tail to preserve size.
      buf.copy(result, chunk.origOffset);
      if (buf.length < chunk.origLen) {
        result.fill(0x20, chunk.origOffset + buf.length, chunk.origOffset + chunk.origLen);
      }
      result.writeUInt32LE(buf.length, chunk.entryOffset + 12);     // contents.length
    } else {
      // Relocate into the (now-dead) bytecode region; repoint contents there.
      buf.copy(result, chunk.bytecode.offset);
      result.writeUInt32LE(chunk.bytecode.offset, chunk.entryOffset + 8);  // contents.offset
      result.writeUInt32LE(buf.length, chunk.entryOffset + 12);           // contents.length
    }
    result.writeUInt32LE(0, chunk.entryOffset + 24);                // bytecode.offset
    result.writeUInt32LE(0, chunk.entryOffset + 28);                // bytecode.length
  }

  debug(`Multi-module repack: ${newContent.size} chunks edited of ${chunks.length}`);

  const originalBinary = fs.readFileSync(binaryPath);
  if (format === 'overlay') {
    repackOverlay(originalBinary, elfBinary, result, outputPath, binaryPath);
  } else {
    repackSection(originalBinary, elfBinary, result, outputPath, binaryPath);
  }
  validateRepackedBinary(outputPath);
}

// ============ Exports ============

module.exports = {
  extractClaudeJs,
  repackWithModifiedJs,
  // Multi-module (transparent concat) — read path + Phase B building blocks
  extractAllJsModules,
  concatJsModules,
  repackMultiModule,
  // Expose internals for testing/debugging
  extractBunData,
  detectModuleStride,
  replaceClaudeJsInPlace,
  isClaudeModule,
};

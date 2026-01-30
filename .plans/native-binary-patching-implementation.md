# Native Binary Patching Implementation Plan

## Overview

Implement proper Bun binary extraction and reassembly for native Claude Code installations. The current implementation is fundamentally broken and corrupts binaries.

**Key References:**
- tweakcc source: `/tmp/tweakcc/src/nativeInstallation.ts`
- TypeScript research: `/home/phate/Documents/second-brain/00_Inbox/patching-node-ts-research.md`
- Node.js version: 25.5.0 (native TypeScript support, no build step needed)

## Problem Statement

The native binary patching in `claude-patching.js` has two critical bugs:

### Bug 1: Extraction (`extractJsFromBinary`, lines 245-258)

```javascript
const jsContent = buffer.slice(0, info.trailerOffset);
```

This extracts **the entire binary** (~223MB) instead of just the JS module (~10MB). It incorrectly assumes the format is:
```
[JS content][trailer][size]  ← WRONG
```

### Bug 2: Reassembly (`reassembleBinary`, lines 263-276)

```javascript
const newSize = patchedJs.length + TRAILER_SIZE + SIZE_MARKER_SIZE;
const newBuffer = Buffer.alloc(newSize);
patchedJs.copy(newBuffer, 0);
BUN_TRAILER.copy(newBuffer, patchedJs.length);
```

This creates `[patched content][trailer][size]`, completely discarding the ELF binary and Bun data structure.

### Evidence

A broken binary was produced (saved as `2.1.19.broken` for analysis):
- Original: 223,057,187 bytes (starts with ELF magic `7f 45 4c 46`)
- Broken: 343,941,058 bytes (starts with JS: `/* __CLAUDE_PATCHES__`)
- The broken binary is interpreted as a shell script, not an executable

---

## Bun Binary Format

### Actual Structure (ELF)

```
[ELF binary sections][Bun data region][OFFSETS (32 bytes)][TRAILER (16 bytes)][totalByteCount (8 bytes)]
                     ^                ^                    ^
                     |                |                    └── "\n---- Bun! ----\n"
                     |                └── Points to modules table
                     └── Contains modules table with JS embedded
```

### Bun Data Region Layout

The Bun data region contains:
1. **Strings data** - All module names, contents, sourcemaps (null-terminated)
2. **Modules table** - Array of module structures pointing into strings data
3. **compileExecArgv** - Compiler arguments

### OFFSETS Structure (32 bytes)

```
Offset  Size  Field
0       8     byteCount (u64) - Total size of [data][OFFSETS][TRAILER]
8       4     modulesPtr.offset (u32)
12      4     modulesPtr.length (u32)
16      4     entryPointId (u32)
20      4     compileExecArgvPtr.offset (u32)
24      4     compileExecArgvPtr.length (u32)
28      4     (padding)
```

### Module Structure (36 bytes each)

```
Offset  Size  Field
0       4     name.offset (u32)
4       4     name.length (u32)
8       4     contents.offset (u32)
12      4     contents.length (u32)
16      4     sourcemap.offset (u32)
20      4     sourcemap.length (u32)
24      4     bytecode.offset (u32)
28      4     bytecode.length (u32)
32      1     encoding
33      1     loader
34      1     moduleFormat
35      1     side
```

### The Claude Module

The JS we want to patch is in the module named `/$bunfs/root/claude` (or just `claude`). Its `contents` StringPointer points to the minified JS.

---

## Reference Implementation: tweakcc

**Source**: `/tmp/tweakcc/src/nativeInstallation.ts` (981 lines)

### Key Functions to Port

1. **`extractBunDataFromELFOverlay`** (lines 299-386)
   - Uses LIEF to get `elfBinary.overlay` (data after ELF sections)
   - Parses the overlay to extract Bun data region and offsets

2. **`mapModules`** (lines 96-168)
   - Iterates through the modules table
   - Parses each BunModule structure
   - Calls visitor function for each module

3. **`isClaudeModule`** (lines 83-90)
   - Checks if module name ends with `/claude` or is `claude`

4. **`getStringPointerContent`** (lines 63-71)
   - Extracts content from Bun data using StringPointer

5. **`repackBunData`** (lines 495-686)
   - **This is the complex part**
   - Collects all module data
   - Replaces claude module contents with modified JS
   - Recalculates ALL offsets (strings move when JS size changes)
   - Rebuilds the entire Bun data buffer

6. **`repackELF`** (lines 903-930)
   - Creates new overlay: `[newBunData][totalByteCount]`
   - Sets `elfBinary.overlay = newOverlay`
   - Writes binary with LIEF

### Offset Recalculation (The Hard Part)

When the JS changes size, every string offset after it must be adjusted:

```javascript
// Phase 1: Collect all module data into arrays
mapModules(bunData, bunOffsets, (module, moduleName) => {
  if (isClaudeModule(moduleName)) {
    contentsBytes = modifiedClaudeJs;  // Use patched JS
  } else {
    contentsBytes = getStringPointerContent(bunData, module.contents);
  }
  // Store name, contents, sourcemap, bytecode for each module
});

// Phase 2: Calculate new layout
let currentOffset = 0;
for (const stringData of stringsData) {
  stringOffsets.push({ offset: currentOffset, length: stringData.length });
  currentOffset += stringData.length + 1;  // +1 for null terminator
}

// Phase 3: Write new buffer with updated pointers
for (let i = 0; i < modulesMetadata.length; i++) {
  // Write module struct with NEW offsets
  newBuffer.writeUInt32LE(newOffset, pos);
  newBuffer.writeUInt32LE(newLength, pos + 4);
  // ... etc
}
```

---

## Implementation Approach

### Dependencies

- `node-lief`: ^1.0.0 (already added to package.json and installed)
- Node.js 25.5.0+ (native TypeScript support, no build step needed)

### TypeScript Implementation

**Reference:** See `/home/phate/Documents/second-brain/00_Inbox/patching-node-ts-research.md` for full details on Node.js native TypeScript support.

Node.js 25.x supports TypeScript natively via type stripping. This allows us to write `lib/bun-binary.ts` in TypeScript (matching the tweakcc reference) without any build toolchain:

- **No flags needed** for erasable-only syntax (types, interfaces, generics)
- **File extension required** in imports: `require('./lib/bun-binary.ts')`
- **No type checking at runtime** - use `tsc --noEmit` separately

### New File: `lib/bun-binary.ts`

Create a dedicated module for Bun binary handling (~400-500 lines):

```typescript
import LIEF from 'node-lief';

// Constants
const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
const SIZEOF_OFFSETS = 32;
const SIZEOF_STRING_POINTER = 8;
const SIZEOF_MODULE = 36;

// Types (matching tweakcc)
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

// Exported functions
export { extractClaudeJs, repackWithModifiedJs };
```

### Functions to Implement

#### 1. `parseStringPointer(buffer, offset)` - ~5 lines
Read a StringPointer (offset + length) from buffer.

#### 2. `parseBunOffsets(buffer, offsetsStart)` - ~15 lines
Parse the 32-byte OFFSETS structure.

#### 3. `parseModule(buffer, offset)` - ~20 lines
Parse a single 36-byte module structure.

#### 4. `getStringContent(buffer, stringPointer)` - ~5 lines
Extract string content using a StringPointer.

#### 5. `isClaudeModule(name)` - ~5 lines
Check if module name matches claude entry point.

#### 6. `extractBunData(binaryPath)` - ~60 lines
- Load binary with LIEF
- Get overlay data
- Parse trailer, offsets
- Return { bunData, bunOffsets, elfBinary }

#### 7. `extractClaudeJs(binaryPath)` - ~40 lines
- Call extractBunData
- Iterate modules to find claude
- Return JS content as Buffer

#### 8. `repackBunData(bunData, bunOffsets, modifiedJs)` - ~200 lines
**The complex function:**
- Collect all module data
- Replace claude module contents
- Recalculate all offsets
- Build new buffer with:
  - All strings (with null terminators)
  - Modules table (with new offsets)
  - compileExecArgv
  - OFFSETS structure (with new pointers)
  - TRAILER

#### 9. `repackWithModifiedJs(binaryPath, modifiedJs, outputPath)` - ~40 lines
- Extract Bun data
- Call repackBunData with modified JS
- Create new overlay
- Set elfBinary.overlay
- Write to outputPath

### Changes to `claude-patching.js`

1. **Replace `extractJsFromBinary`** (~line 245)
   ```javascript
   const { extractClaudeJs } = require('./lib/bun-binary.ts');  // Note: .ts extension required!
   // ... use extractClaudeJs(binaryPath)
   ```

2. **Replace `reassembleBinary`** (~line 263)
   ```javascript
   const { repackWithModifiedJs } = require('./lib/bun-binary.ts');
   // ... use repackWithModifiedJs(binaryPath, patchedJs, outputPath)
   ```

3. **Update error handling** in `applyPatches`
   - LIEF may throw different errors
   - Add validation for binary format

---

## File Structure After Implementation

```
claude-patching/
├── claude-patching.js      # Main CLI (modified)
├── lib/
│   └── bun-binary.ts       # NEW: Bun binary handling (TypeScript)
├── tsconfig.json           # TypeScript config for editor/linting
├── patches/
│   ├── 2.1.14/
│   │   ├── index.json
│   │   └── patch-*.js
│   └── 2.1.19/
│       ├── index.json
│       └── patch-*.js
├── package.json            # Has node-lief dependency
└── node_modules/
    └── node-lief/          # ~48MB native binary
```

---

## Testing Strategy

### 1. Unit Tests for Bun Parsing

```bash
# Test extraction produces correct size (~10MB, not ~223MB)
node -e "
  const { extractClaudeJs } = require('./lib/bun-binary.ts');
  const js = extractClaudeJs('/home/phate/.local/share/claude/versions/2.1.19.bak');
  console.log('Extracted size:', js.length);
  console.log('Starts with:', js.slice(0, 50).toString());
"
```

Expected: ~10MB, starts with JS code (not ELF magic).

### 2. Round-Trip Test

```bash
# Extract, repack without modification, verify binary works
node -e "
  const { extractClaudeJs, repackWithModifiedJs } = require('./lib/bun-binary.ts');
  const original = '/home/phate/.local/share/claude/versions/2.1.19.bak';
  const output = '/tmp/test-repack';

  const js = extractClaudeJs(original);
  repackWithModifiedJs(original, js, output);

  // Verify sizes are similar
  const fs = require('fs');
  console.log('Original:', fs.statSync(original).size);
  console.log('Repacked:', fs.statSync(output).size);
"

# Test repacked binary runs
/tmp/test-repack --version
```

### 3. Integration Test with Patches

```bash
# Dry run on native
node claude-patching.js --native --check

# Apply to test copy (not the live binary)
cp /home/phate/.local/share/claude/versions/2.1.19.bak /tmp/test-native
node claude-patching.js --native --apply  # with modified target path

# Run patched binary
/tmp/test-native --version
```

### 4. Verify Patches Work (Manual - User Must Perform)

**Note:** These tests require manual verification by the user because:
- Claude Code is an interactive CLI application
- The patches modify graphical/visual elements
- Cannot be automated from within a Claude session

The user should start the patched Claude Code and verify:
- Thinking blocks visible inline (visibility patch)
- Thinking text renders in dim gray (style patch)
- Custom spinner animation displays correctly (spinner patch)
- Ghostty terminal shows truecolor (ghostty patch)

---

## Implementation Order

1. **Create `tsconfig.json`** for editor support and type checking
2. **Create `lib/bun-binary.ts`** with types and parsing functions
3. **Implement `extractClaudeJs`** - verify extraction works
4. **Implement `repackBunData`** - the complex offset recalculation
5. **Implement `repackWithModifiedJs`** - LIEF integration
6. **Update `claude-patching.js`** to use new module (note: requires `.ts` extension in require)
7. **Test round-trip** (extract + repack = working binary)
8. **Test with actual patches**
9. **Update `patch-setup` skill** - see below

---

## Update patch-setup Skill

The skill at `.claude/skills/patch-setup/SKILL.md` currently uses a broken extraction method (same bug as claude-patching.js). Update it to use the new `lib/bun-binary.ts` module.

### Changes Required

1. **Step 2: Extract JS (Native Only)** - Replace the inline Python script with:
   ```bash
   # Use the proper extraction from lib/bun-binary.ts
   node -e "
     const { extractClaudeJs } = require('./lib/bun-binary.ts');
     const fs = require('fs');
     const js = extractClaudeJs('$BINARY_PATH');
     fs.writeFileSync('cli.js.extracted', js);
     console.log('Extracted', js.length.toLocaleString(), 'bytes');
   "
   ```

2. **Update verification** - The extracted file should be ~10MB (not ~223MB)

3. **Add dependency note** - The skill now requires `npm install` to be run first for node-lief

### File to Modify

- `.claude/skills/patch-setup/SKILL.md` (lines 72-94)

---

## Risk Mitigation

1. **Always backup before patching** - Already implemented
2. **Verify ELF magic after repack** - Add validation
3. **Size sanity check** - Warn if size differs by >20%
4. **Test on copy first** - Don't patch live binary during development

---

## Platform Scope

**This implementation targets Linux (ELF) only.** The user's system is Linux. Mach-O (macOS) and PE (Windows) support can be added later if needed, but are out of scope for this initial implementation.

tweakcc supports all three formats, but porting Mach-O requires:
- Page alignment detection (4KB for x86_64, 16KB for ARM64)
- Code signature removal and re-signing
- Section header size detection (4 or 8 bytes)

These are not needed for ELF.

---

## Implementation Details (Gap Fills)

### TypeScript Implementation Notes

Since we're using Node.js 25.5+ with native TypeScript support, the code can match tweakcc's TypeScript directly:

```typescript
// lib/bun-binary.ts - matches tweakcc patterns
interface StringPointer {
  offset: number;
  length: number;
}

function parseStringPointer(buffer: Buffer, offset: number): StringPointer {
  return { ... };
}
```

**Key differences from tweakcc:**
- We use CommonJS exports (`export { ... }`) since the main entry is `.js`
- No build step - Node runs `.ts` files directly via type stripping
- Type checking is optional (`tsc --noEmit`) - not enforced at runtime

### node-lief Initialization

```typescript
// lib/bun-binary.ts - top of file
import * as LIEF from 'node-lief';

// Suppress verbose LIEF output
LIEF.logging.disable();
```

**Note:** If node-lief import fails, Node will throw a clear module resolution error.

### Function Signatures (Complete)

```typescript
// Types (defined at top of lib/bun-binary.ts)
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
  bunData: Buffer;        // The raw Bun data region
  bunOffsets: BunOffsets; // Parsed offsets structure
  elfBinary: any;         // LIEF ELF binary object (any due to node-lief types)
}

// Function signatures:

/** Extract Bun data from an ELF binary */
function extractBunData(binaryPath: string): BunData { ... }

/** Extract the Claude JS module content */
function extractClaudeJs(binaryPath: string): Buffer { ... }

/** Repack Bun data with modified JS */
function repackBunData(bunData: Buffer, bunOffsets: BunOffsets, modifiedJs: Buffer): Buffer { ... }

/** Replace JS in binary and write to output */
function repackWithModifiedJs(binaryPath: string, modifiedJs: Buffer, outputPath: string): void { ... }
```

### compileExecArgv Handling (Critical)

The `compileExecArgv` is a SEPARATE string region, not part of the modules. It must be:

1. **Extracted separately** during `extractBunData`:
   ```typescript
   const compileExecArgv = getStringContent(bunData, bunOffsets.compileExecArgvPtr);
   ```

2. **Preserved during repack** - it goes AFTER the modules table:
   ```
   [strings...][modules table][compileExecArgv + null][OFFSETS][TRAILER]
   ```

3. **Its new offset recorded** in the rebuilt OFFSETS structure.

From tweakcc lines 559-565 and 631-640:
```typescript
// Extraction
const compileExecArgvBytes = getStringContent(bunData, bunOffsets.compileExecArgvPtr);

// Repack - write after modules table
compileExecArgvBytes.copy(newBuffer, compileExecArgvOffset);
newBuffer[compileExecArgvOffset + compileExecArgvBytes.length] = 0; // null terminator

// Update offsets
newOffsets.compileExecArgvPtr = {
  offset: compileExecArgvOffset,
  length: compileExecArgvBytes.length
};
```

### Buffer Allocation Strategy

Use `Buffer.allocUnsafe()` for the main repack buffer since we write every byte:
```typescript
// Good - we're writing all bytes
const newBuffer = Buffer.allocUnsafe(totalSize);

// Still use Buffer.alloc() for small fixed-size structures if paranoid
const offsetsBuffer = Buffer.alloc(SIZEOF_OFFSETS);
```

### Error Handling Patterns

```typescript
// File busy error (user running Claude while patching)
function atomicWriteBinary(elfBinary: any, outputPath: string, originalPath: string): void {
  const tempPath = outputPath + '.tmp';
  try {
    elfBinary.write(tempPath);
    const stat = fs.statSync(originalPath);
    fs.chmodSync(tempPath, stat.mode);
    fs.renameSync(tempPath, outputPath);
  } catch (err: any) {
    // Clean up temp file
    try { fs.unlinkSync(tempPath); } catch (e) {}

    if (err.code === 'ETXTBSY' || err.code === 'EBUSY') {
      throw new Error(
        'Cannot update Claude binary while it is running.\n' +
        'Please close all Claude instances and try again.'
      );
    }
    throw err;
  }
}

// Module not found
function extractClaudeJs(binaryPath: string): Buffer {
  // ... extraction logic ...
  if (!claudeModule) {
    throw new Error(
      'Claude module not found in binary.\n' +
      'Expected module named "/$bunfs/root/claude" or "claude".\n' +
      'Found modules: ' + moduleNames.join(', ')
    );
  }
}
```

### Debugging/Logging

Add debug output controlled by environment variable:

```typescript
const DEBUG = process.env.DEBUG_BUN_BINARY;

function debug(...args: any[]): void {
  if (DEBUG) console.log('[bun-binary]', ...args);
}

// Usage in repackBunData:
debug(`Found ${modules.length} modules`);
debug(`Claude module: ${claudeModule.contents.length} bytes`);
debug(`Modified JS: ${modifiedJs.length} bytes`);
debug(`Size delta: ${modifiedJs.length - claudeModule.contents.length} bytes`);
debug(`New buffer size: ${newBuffer.length} bytes`);
```

### Integration Flow (claude-patching.js)

Current broken flow:
```javascript
// Old (broken)
const { tempPath, originalBuffer } = extractJsFromBinary(install.path);
// ... patches modify tempPath ...
reassembleBinary(tempPath, install.path);
```

New correct flow:
```javascript
// New (correct)
const { extractClaudeJs, repackWithModifiedJs } = require('./lib/bun-binary.ts');

// 1. Extract JS to temp file (for patch scripts to modify)
const jsBuffer = extractClaudeJs(install.path);
const tempPath = path.join(os.tmpdir(), `claude-cli-${Date.now()}.js`);
fs.writeFileSync(tempPath, jsBuffer);

// 2. Run patch scripts on tempPath (unchanged)
for (const patch of patches) {
  runPatch(patch, tempPath, dryRun);
}

// 3. Read back modified JS and repack
const modifiedJs = fs.readFileSync(tempPath);
repackWithModifiedJs(install.path, modifiedJs, install.path);

// 4. Cleanup
fs.unlinkSync(tempPath);
```

### Validation Checks

Add these verification steps:

```typescript
// After extraction - verify it's JS, not binary
function validateExtractedJs(buffer: Buffer): void {
  // Should start with JS code, not ELF magic
  if (buffer[0] === 0x7f && buffer[1] === 0x45) {
    throw new Error('Extraction failed: got ELF binary instead of JS');
  }
  // Should be reasonable size (1MB - 50MB)
  if (buffer.length < 1_000_000 || buffer.length > 50_000_000) {
    throw new Error(`Unexpected JS size: ${buffer.length} bytes`);
  }
}

// After repack - verify ELF magic preserved
function validateRepackedBinary(outputPath: string): void {
  const header = Buffer.alloc(4);
  const fd = fs.openSync(outputPath, 'r');
  fs.readSync(fd, header, 0, 4, 0);
  fs.closeSync(fd);

  if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error('Repacked binary missing ELF magic - corrupted');
  }
}
```

---

## Common Pitfalls

1. **Forgetting null terminators** - Every string in Bun data is null-terminated. The offset calculation must add +1 for each string.

2. **Confusing byteCount** - In OFFSETS, `byteCount` is the total size of `[data][OFFSETS][TRAILER]`, NOT the full overlay size. The overlay adds 8 more bytes for `totalByteCount`.

3. **Module iteration order** - Modules must be written in the same order they were read. Don't sort or reorder.

4. **StringPointer length** - The `length` field does NOT include the null terminator. When writing, write `length` bytes of content, then one 0x00 byte.

5. **Old extracted files** - Any `cli.js.extracted` files from the broken implementation are invalid (~223MB instead of ~10MB). Delete and re-extract.

---

## patch-setup Skill Dependency Handling

Update `.claude/skills/patch-setup/SKILL.md` to check for dependencies:

```bash
# Add to Step 2, before extraction:

# Check if node-lief is installed
if [ ! -d "node_modules/node-lief" ]; then
  echo "⚠ node-lief not installed. Installing dependencies..."
  # Use nvm if available
  if [ -f "$HOME/.nvm/nvm.sh" ]; then
    source "$HOME/.nvm/nvm.sh"
  fi
  npm install
fi
```

And update the extraction command:
```bash
# New extraction (correct)
node -e "
  const { extractClaudeJs } = require('./lib/bun-binary.ts');
  const fs = require('fs');
  const js = extractClaudeJs('$SOURCE_PATH');
  fs.writeFileSync('cli.js.extracted', js);
  console.log('Extracted', js.length.toLocaleString(), 'bytes to cli.js.extracted');
"

# Verify extraction (should be ~10MB, not ~223MB)
size=$(wc -c < cli.js.extracted)
if [ "$size" -gt 50000000 ]; then
  echo "ERROR: Extracted file too large ($size bytes). Extraction may have failed."
  exit 1
fi
```

---

## References

- tweakcc source: `/tmp/tweakcc/src/nativeInstallation.ts` (981 lines, battle-tested)
- Broken binary for analysis: `/home/phate/Projects/claude-patching/2.1.19.broken`
- Original backup: `/home/phate/.local/share/claude/versions/2.1.19.bak`
- node-lief docs: https://github.com/Piebald-AI/node-lief

### Key tweakcc Line References

| Function | Lines | Purpose |
|----------|-------|---------|
| `extractBunDataFromELFOverlay` | 299-386 | Parse ELF overlay to get Bun data |
| `mapModules` | 96-168 | Iterate modules table |
| `repackBunData` | 495-686 | Rebuild Bun data with modified JS |
| `repackELF` | 903-930 | Set new overlay and write binary |
| `atomicWriteBinary` | 695-736 | Safe file replacement |
| `getStringPointerContent` | 63-71 | Read string from Bun data |
| `parseStringPointer` | 73-78 | Parse offset+length pair |
| `isClaudeModule` | 83-90 | Check if module is claude entry |

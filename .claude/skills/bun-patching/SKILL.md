---
name: bun-patching
description: Knowledge for patching Bun-compiled binaries. Use when analyzing or modifying Bun executables like native Claude Code installs. Covers binary structure, extraction, patching approaches, and reassembly.
---

# Bun Binary Patching

Guide to understanding and patching Bun-compiled executables (created with `bun build --compile`).

## Binary Structure

Bun compiles JS into a single executable with this structure:

```
[ELF header + Bun runtime ~3-5MB] [JS payload] [\n---- Bun! ----\n] [8-byte size]
```

| Section | Size | Description |
|---------|------|-------------|
| ELF + Runtime | ~3-5 MB | Bun's native runtime, static |
| JS Payload | Variable | Embedded JavaScript, **plaintext latin1** |
| Trailer | 16 bytes | Literal `\n---- Bun! ----\n` |
| Size Marker | 8 bytes | Total file size as little-endian u64 |

## Key Facts

- **No integrity checks** - Bun only validates trailer presence and bounds
- **JS is plaintext** - Not bytecode, not compressed, stored as latin1
- **Size marker must match** - After patching, update the 8-byte size at EOF

## Finding the Structure

```bash
# Check if it's a Bun binary
strings /path/to/binary | grep 'Bun!'

# Find trailer offset
python3 -c "
with open('/path/to/binary', 'rb') as f:
    f.seek(-50, 2)
    data = f.read()
    print('Last 50 bytes:', repr(data))
"
```

Expected output shows `\n---- Bun! ----\n` followed by 8 bytes (the file size).

## Extracting JS Content

```python
# Read binary and extract JS
with open('binary', 'rb') as f:
    data = f.read()

# Find trailer
trailer = b'\n---- Bun! ----\n'
trailer_offset = data.rfind(trailer)

# JS is everything before trailer
js_content = data[:trailer_offset]

# Write to file for analysis
with open('extracted.js', 'wb') as f:
    f.write(js_content)
```

## Patching Approach

### Option 1: Direct Binary Patching (same-length only)

If your patch doesn't change length, use sed/Python on the binary directly:

```bash
# Only works if replacement is EXACT same length
sed -i 's/oldpattern/newpattern/g' binary
```

### Option 2: Extract-Patch-Reassemble (recommended)

For patches that change file size:

```python
import struct

def patch_bun_binary(binary_path, output_path, patch_func):
    with open(binary_path, 'rb') as f:
        data = f.read()

    trailer = b'\n---- Bun! ----\n'
    trailer_offset = data.rfind(trailer)

    # Extract JS
    js_content = data[:trailer_offset]

    # Apply patches (as latin1 string for text operations)
    js_str = js_content.decode('latin1')
    patched_js = patch_func(js_str)
    patched_bytes = patched_js.encode('latin1')

    # Reassemble: [patched JS][trailer][new size]
    new_size = len(patched_bytes) + 16 + 8  # trailer + size marker

    with open(output_path, 'wb') as f:
        f.write(patched_bytes)
        f.write(trailer)
        f.write(struct.pack('<Q', new_size))  # Little-endian u64

    # Make executable
    import os
    os.chmod(output_path, 0o755)
```

## Node.js Implementation

```javascript
const fs = require('fs');

const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');

function parseBunBinary(buffer) {
  const fileSize = buffer.length;
  const trailerStart = fileSize - 16 - 8;  // trailer + size marker
  const trailer = buffer.slice(trailerStart, trailerStart + 16);

  if (!trailer.equals(BUN_TRAILER)) {
    return { valid: false, error: 'Trailer not found' };
  }

  return { valid: true, trailerOffset: trailerStart, fileSize };
}

function reassembleBinary(patchedJs, outputPath) {
  const newSize = patchedJs.length + 16 + 8;
  const buffer = Buffer.alloc(newSize);

  patchedJs.copy(buffer, 0);
  BUN_TRAILER.copy(buffer, patchedJs.length);
  buffer.writeBigUInt64LE(BigInt(newSize), patchedJs.length + 16);

  fs.writeFileSync(outputPath, buffer);
  fs.chmodSync(outputPath, 0o755);
}
```

## Searching for Patterns

The JS is minified but searchable:

```bash
# Find patterns in the binary
strings binary | grep 'case"thinking"'

# Get offset for context
python3 -c "
import re
with open('binary', 'rb') as f:
    data = f.read()

pattern = b'case\"thinking\"'
for m in re.finditer(pattern, data):
    print(f'Offset {m.start()}: {data[m.start():m.start()+100]}')"
```

## Common Patterns in Claude Code

| Pattern | Purpose |
|---------|---------|
| `case"thinking":` | Thinking block renderer |
| `case"redacted_thinking":` | Redacted thinking renderer |
| `isTranscriptMode` | Controls visibility in different modes |
| `createElement` | React component instantiation |

## Bun Source Reference

The standalone binary format is defined in:
- `/tmp/bun/src/standalone_bun.zig` (if cloned locally)
- Key function: `readTailMeta()` - reads trailer and validates structure

Relevant code (Zig):
```zig
const trailer = "\n---- Bun! ----\n";
// Size is u64 LE after trailer
var end = @as([]u8, &trailer_bytes).ptr + read_amount - @sizeOf(usize);
const total_byte_count: usize = @as(usize, @bitCast(end[0..8].*));
```

## Troubleshooting

### Binary won't run after patching
- Check size marker matches actual file size
- Verify trailer is intact (exactly 16 bytes)
- Ensure file is executable (`chmod +x`)

### Pattern not found
- JS may have changed between versions
- Use flexible regex: `[$\w]+` matches any identifier
- Variable names change per version; match structure, not names

### Encoding issues
- Always use `latin1` for reading/writing JS content
- Don't use `utf8` - will corrupt binary data in the ELF header

## Related Files

- `apply-patches-binary.js` - Working implementation
- `/tmp/bun/src/standalone_bun.zig` - Bun source (if cloned)

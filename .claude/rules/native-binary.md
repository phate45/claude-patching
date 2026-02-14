---
paths:
  - "lib/bun-binary.ts"
  - "patches/**/native/**"
---

# Native Binary Internals

## Bun Overlay Format

The native install is an ELF binary with Bun data appended after ELF sections:

```
[ELF sections][Bun data region][OFFSETS 32B][TRAILER 16B][totalByteCount 8B]
```

- **JS location**: Module named `/$bunfs/root/claude` in the modules table
- **Dependency**: `node-lief` for ELF parsing (`npm install`)
- **Extraction**: `extractClaudeJs(binaryPath)` in `lib/bun-binary.ts`

## Size Budget Constraint

Patched JS **must be <= original size**. The data region uses overlapping string regions
(bytecode, source, sourcemaps share memory).

- `replaceClaudeJsInPlace()` overwrites the module content, pads remainder with spaces,
  updates the StringPointer length
- LIEF's `elfBinary.write()` produces bloated output — bypass it entirely by splicing
  original ELF bytes + new overlay
- Patches that add code eat into the budget. Prefer removing conditions over injecting logic.

## Key Lessons

- Rebuilding the data region from scratch inflates massively (119MB -> 1.5GB)
- The correct approach is always **in-place replacement**
- Different builds of the same CC version produce different minified variable names

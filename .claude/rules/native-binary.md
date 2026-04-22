---
paths:
  - "lib/bun-binary.ts"
  - "patches/**/native/**"
---

# Bun Binary Internals

Applies to **both** install types since 2.1.117: native (`~/.local/bin/claude` → Bun ELF)
and bare (pnpm wrapper whose postinstall hardlinks a Bun ELF to `bin/claude.exe`). The
two binaries are separate builds but ship byte-identical JS payloads in their overlays,
so the same patch set works for both.

## Bun Overlay Format

The binary is an ELF with Bun data appended after ELF sections:

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
- Bare install's `bin/claude.exe` is hardlinked into pnpm's content-addressed store. `repackWithModifiedJs()` uses `fs.renameSync` of a temp file into place, which allocates a fresh inode and breaks the hardlink cleanly — no extra plumbing needed.

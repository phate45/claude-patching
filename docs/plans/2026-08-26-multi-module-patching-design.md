# Multi-Module Patching — Design (2026-08-26)

Porting the patch mechanism to CC 2.1.246+, where Bun split the monolithic `cli.js`
into ~1576 chunk modules. See memory `bun-format-break-2-1-246` for the discovery.

## Problem

- CC 2.1.246's native binary uses a **52-byte** Bun module record (was 36): Bun inserted
  `module_info` + `bytecode_origin_path` StringPointers (`StandaloneModuleGraph.rs:331`).
- The monolithic `cli.js` is gone: **1576 modules (1408 JS, 36.4MB)**. Entry
  `module[7] = /$bunfs/root/cli` is a **20KB bootstrap stub**, not the code.
- Patchable code is **scattered**: system prompt + `renderToolUseMessage` in `_441.js`
  (6.8MB); `system-reminder` across dozens of chunks; `Bash(git` across 4+.
- Our old `extractClaudeJs` (36-byte stride, single-module) OOMs and can't work.
- tweakcc (HEAD @ 2.1.241) doesn't solve this either — no entryId use, no reassembly.

## Decisions

- **Scope:** durable, phased (not an MVP hack).
- **Engine model:** Approach 1 — **transparent global concat**. Setup produces the same
  big `.native.original` / `.native.pretty` files; authoring and `--check` are unchanged;
  `--apply` does the re-chunking in the background.
- **Repack:** per-chunk **shrink-only in-place + pad to original length**, so every chunk
  keeps its original *offset* and the total section size is constant (ELF placement never
  moves). Only StringPointer *lengths* change; bytecode pointer zeroed per patched chunk.

## Core invariant

Matches are located in the **pristine** concatenated corpus; edits are routed back to
individual chunk buffers by **original** offset. No cumulative-delta math — we never split
the patched blob. A match must lie entirely within one chunk (boundary-straddle = error).

## Read path (`--setup` / `--port`)

1. `bun-binary.ts` walks all modules at **stride 52**, with tweakcc-style
   `modulesPtr.length % size` auto-detect (36 vs 52) so older versions still work.
2. New `extractAllJsModules()` → ordered JS chunks `{index, name, contents,
   origOffset, origLen, bytecodePtr, encoding, loader}` in module-table index order.
   **Inclusion rule = `loader===1` (JS), NOT name suffix** — verified in Phase 0: 1405
   real JS chunks are `loader=1`/`encoding=1` (Latin1), while 3 `.js`-named modules are
   `loader=5`/`encoding=0` assets. Non-JS modules (assets, `.node`, html, the 3
   loader=5) pass through untouched.
3. Concat chunk `contents` (index order) → `cli.js.native.original` (~36MB). Beautify →
   `.pretty`. Transparent: user sees one file.
4. Boundary index (offsets into concat) is **recomputed deterministically at apply time
   from the live binary** — not persisted, can't go stale. Assert rebuilt concat ==
   `.original` at apply.
5. `--check` / `--status` unchanged — dry-run match against the concat. **Unblocks the
   changelog port-triage.**

## Write path (`--apply`)

1. Re-extract live binary → chunk list + boundary index (source of truth).
2. Find matches in concat. For match `(G, L, R)`: map `(G,L) → (chunkIndex, localOffset)`;
   guard single-chunk; apply `(localOffset, L, R)` to that chunk's buffer. Multiple edits
   per chunk applied **back-to-front**.
3. Per modified chunk: overwrite content at original offset, pad tail to original length,
   update StringPointer **length** in module table, **zero bytecode pointer** (recompile
   from patched source — stale-bytecode gotcha, now per-chunk).
4. Unmodified chunks + all non-JS modules byte-for-byte untouched. Offsets never reshuffle.
5. Splice `[ELF][modified overlay]`; encoding + syntax checks (**per modified chunk** so a
   break names the chunk); reassemble.
6. `__CLAUDE_PATCHES__` metadata written into one designated chunk (entry `cli` or `_441`)
   for `--status` / gate detection.

## Feasibility spike (Phase 0 — go/no-go gate)

Three unverified assumptions, all cheap:
1. **Inter-chunk overlap** — ✅ PASS (2026-08-26): 0/1408 adjacent JS-chunk `contents`
   overlaps; 0 overlaps with any other module's sourcemap/bytecode/module_info region.
2. **Encoding** — ✅ PASS: all 1405 `loader=1` JS chunks are Latin1 (`encoding=1`); no
   UTF-16. (Drove the `loader===1` inclusion rule above.)
3. **`module_info` / bytecode staleness** — ⏳ pending the no-op round-trip below.

**Killer de-risker — no-op round-trip:** extract → concat → split back → repack an
**unmodified** binary → run `claude --version`. Proves the machinery before any patch
logic. If it fails, we learn exactly where (overlap / encoding / module_info).

### Phase 0 result — ✅ GO (2026-08-26, spike `/tmp/rt-spike.js`)
- **T1 no-op reassembly:** byte-identical to original + binary runs (`2.1.246`). Stride-52
  table walk + `.bun` section reassembly + splice is faithful.
- **T2 shrink edit** (`VERSION:"2.1.246"`→`"2.1.7"`): edited **57 chunks / 250 occurrences**,
  each shrink+pad+length-update+bytecode-zero, **`module_info` left intact** → binary runs
  and reports **`2.1.7`**. Risk #3 (module_info staleness) **PASS** — zeroing bytecode alone
  suffices; recompiles from patched source.
- **Findings that shape Phase A:**
  1. **1402/1405 JS chunks carry bytecode** → per-chunk bytecode-zero is MANDATORY.
  2. **Version string appears in 57 chunks / 250 copies** → Bun code-splitting inlines/
     duplicates constants across chunks. The concat corpus will surface **many more matches
     than the old monolith**. The patch engine needs a **match-multiplicity policy**
     (patch-all vs. expect-unique per patch) — a patch meant for one site could otherwise
     fire in dozens. NEW requirement for Phase B routing.
  3. Section file offset = 86872064, size = 160976213 (2.1.246); totalByteCount header is
     the section's first 8 bytes.

## Phasing

- **Phase 0 — spike:** three checks + no-op round-trip. Go/no-go.
- **Phase A — read path:** stride-52 walk, `extractAllJsModules`, setup concat, `.pretty`.
  Exit: `--check` runs (mechanism sound), unblocking patch-regex triage. **✅ DONE
  (2026-08-26, commit c43a318).** Live 2.1.246: stride-52 auto-detected, **1405 JS
  chunks (loader===1), 30.4MB concat**, boundary round-trip 0 mismatches, 666ms at
  **default heap** (OOM was purely the mis-strided walk). `extractClaudeJs` returns
  the concat; `setup.js`/`patch-runner.js` unchanged. `--check` = **14/29 pass**; the
  15 fails are genuine 24-version regex drift (spot-checked: `xterm-ghostty` present
  verbatim in concat, spinner memo *shape* changed upstream) — boundary-straddle ruled
  out structurally (Bun lays each source module contiguously) and empirically. The
  36.4MB earlier estimate counted the 3 `loader=5` `.js` assets; 30.4MB is the honest
  JS-only corpus. Single-module in-place apply now guarded with a Phase-B-pending error.
- **Phase B — write path:** match→chunk routing + per-chunk repack + `--apply`.
  Exit: patched binary runs; patches verified. **✅ DONE (2026-08-26, commits
  eda3d9f + 0c9c563).** Full 28-patch native `--apply` produces a working binary
  (live install test-driven via `wclaude`, all patched paths exercised). Details
  below.

### Phase B result — ✅ DONE (2026-08-26)

`repackMultiModule` in `lib/bun-binary.ts` (dispatched from `repackWithModifiedJs`
when `chunks.length > 1`):

1. **Diff-and-route, not structured matches.** Patches rewrite the concat opaquely
   (subprocess find/replace), so we recover edits by diffing pristine-vs-patched
   concat. Divide-and-conquer: trim common prefix/suffix; a residual region inside
   one chunk becomes a hunk; a multi-chunk region is split at an interior **chunk
   boundary** (guaranteed sync point — no edit straddles one), window-probe as
   fallback. This mooted the "match-multiplicity policy" worry: we route the
   *actual* edits the patches made, not every literal occurrence.
2. **Reconstruction gate.** Rebuild the concat from routed chunks and assert it
   equals the patched body before touching the binary. A mis-route aborts clean.
3. **Relocation-on-grow (design correction).** The "shrink-only + pad" assumption
   was wrong: 8 *injection* patches grow their chunk (feature-flags +3591, cron
   +925, highlights +635, skills +310, timestamp +206, spinner +104, thinking +27,
   ghostty +26). A chunk can't grow in place. Fix: since each edited chunk's
   bytecode pointer is zeroed anyway and Phase 0 proved contents/bytecode regions
   are disjoint (verified again: 0 overlaps for all 8), a grown chunk **relocates
   into its own freed bytecode region** (repoint contents.offset; every grown
   chunk's bytecode region is 3–4× the space needed). Shrunk/equal chunks stay in
   place + pad. Section size stays constant.
4. **Metadata** is peeled off the concat front (it would grow chunk 0) and
   re-injected into the max-slack edited chunk (chunk 381, heavily shrunk by
   prompt-slim). `readPatchMetadata`/`--status` find it after re-extraction.
5. **Syntax check flipped to node-first** (`lib/patch-runner.js`): `Bun.Transpiler
   .scan()` is pathological on the 32MB concat (5+ minutes); `node --check` clears
   it in 0.1s and node 22+ handles the stage-3 syntax that once justified Bun. Bun
   stays as a fallback only when node reports an error.

**Cross-cutting lesson (bit us here):** a green `--check` on a multi-module binary
proves the *pattern matched*, not that the patch is *runtime-correct* — and now that
`--apply` works, runtime bugs surface. `disable-bundled-skills` (ported from 2.1.162)
matched the wrong function in 2.1.246 (`qs`, whose return is destructured) and its
`return;` crashed startup; re-anchored on the real registrar `Zo` (commit 0c9c563).
Always test-drive the patched binary after a port, not just `--check`.

## Safety net

`.bak` before apply; constant section size (pad) so ELF placement is stable; per-chunk
syntax check; auto-rollback on failure. Solo-master repo → direct commits per phase.

## Touched modules

- `lib/bun-binary.ts` — stride 52 + auto-detect; `extractAllJsModules()`; multi-module
  in-place repack.
- `lib/setup.js` — concat `.original` from JS chunks.
- `lib/patch-runner.js` — match→chunk routing on apply.
- `lib/status.js` — module-count display (minor).

## Environment note

Bundle-heavy node commands need `--max-old-space-size` bump (memory `container-ram-oom`);
a clean stride-52 walk is cheap (the 6GB OOM was the mis-strided runaway loop).

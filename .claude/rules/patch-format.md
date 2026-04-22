---
paths:
  - "patches/**"
---

# Patch Module Format

## Invocation Contract

Every patch is a standalone Node.js script invoked by the orchestrator:

```bash
node patches/<version>/patch-name.js <cli.js path>          # apply
node patches/<version>/patch-name.js --check <cli.js path>  # dry run
```

The orchestrator calls via `execSync('node "<patchPath>" <args>')`.

**Patch responsibilities:**
1. Parse args: `const dryRun = args[0] === '--check'; const targetPath = dryRun ? args[1] : args[0];`
2. Read the target file
3. Find patterns and apply replacements
4. Write the modified file (skip if dry run)
5. Use `lib/output.js` for all output (supports JSON mode)
6. Exit 0 on success, exit 1 on failure

**Orchestrator detection of failures:**
- Exit code non-zero = failure
- Stderr containing "Could not find", "already patched", "pattern not found" = treated as "not found" (soft failure)

## index.json Format

Each `patches/<version>/index.json` maps patch IDs to files. Since 2.1.117, where
bare and native ship byte-identical JS payloads, the default shape is a **flat
array**:

```json
{
  "version": "2.1.117",
  "patches": [
    { "id": "patch-name", "file": "2.1.117/js-patches/patch-name.js" },
    { "id": "older-patch", "file": "2.1.42/patch-older.js" }
  ]
}
```

- **file**: Path relative to `patches/` — can reference older versions if the patch still works. New files land under `patches/<version>/js-patches/` (see below).

**Legacy bucketed shape** (still supported by the runner for back-compat):

```json
"patches": {
  "common": [...],
  "bare":   [...],
  "native": [...]
}
```

Only reintroduce the buckets if bare and native ever diverge structurally again. The runner in `lib/patch-runner.js::loadPatchIndex()` accepts both shapes.

## Directory Layout

Convention going forward:

```
patches/<version>/
├── index.json                 # flat patches array + notes
├── js-patches/                # JS patch files (NEW - mirrors prompt-patches/ convention)
│   └── patch-<name>.js
├── prompt-patches/            # prompt find/replace pairs
│   ├── patches.json
│   └── <name>.{find,replace}.txt
├── baseline-find.txt          # prompt patch baselines (generated)
├── baseline-replace.txt
├── stats.txt
└── upstream-comparison.txt
```

- **New or updated JS patches** — write to `patches/<version>/js-patches/patch-<name>.js`. Do **not** create `bare/`, `native/`, or `common/` subdirectories; that distinction is gone at the filesystem level.
- **Legacy subdirs** — `patches/<older-version>/bare/` and `patches/<older-version>/native/` are preserved verbatim to keep older CC versions working. Never move, rename, or consolidate them.
- **Legacy flat files** — patches for versions before this convention (e.g. `patches/2.1.14/patch-ghostty-term.js`) stay at the version root. `index.json` can reference them from newer versions as long as the patterns still match.

## Version Porting

When a new CC version drops:

1. `node claude-patching.js --init` — copies latest index.json with new version
2. `node claude-patching.js --check` — shows which patches fail
3. For failures: create a **new copy** of the patch in `patches/<new-version>/js-patches/` — do not modify the original, so older versions remain supported as-is
4. Update index.json file paths for the fixed patches only (point at the new `js-patches/` file)

## Patch Development Rules

- Match structure, not specific variable names (`[$\w]+` for any identifier)
- Use word boundaries (`\b`) for regex performance
- Always test with `--check` before `--apply`
- Run `node --check <file>.js` after writing a patch to catch syntax errors
- Never inject inside comma-separated `let` declarations — match through the `;`
- The comma operator in `return` works for side effects: `return expr1,(expr2),expr3`
- Prefer removing conditions over injecting code (cheaper, safer for native size budget)
- Verify the display path before patching: trace from UI back to the function

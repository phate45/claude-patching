# Plan: Local-First Prompt Patches

## Context

Prompt patch files (`.find.txt`/`.replace.txt`) currently live only in `/tmp/prompt-patching/`, which gets wiped on container restart. When we port patches ourselves (e.g., 2.1.51→2.1.59), that work is lost. This change moves prompt patches into the project's `patches/` directory as the primary source, with the upstream repo as a fallback.

## Storage Format

New directory per version: `patches/<version>/prompt-patches/`

```
patches/2.1.59/prompt-patches/
├── patches.json                    # ordered patch list + provenance
├── tool-usage.find.txt
├── tool-usage.replace.txt
├── bash-tool.find.txt
├── bash-tool.replace.txt
└── ...
```

`patches.json`:
```json
{
  "source": "upstream:2.1.51",
  "patches": [
    { "name": "tool-usage", "file": "tool-usage" },
    ...
  ]
}
```

The `source` field tracks origin for debugging (e.g., `"upstream:2.1.51"`, `"local:2.1.59"`).

## Files to Modify

### 1. `lib/prompt-baseline.js`

**New function: `localPromptDir(version)`** — returns `patches/<version>/prompt-patches/`

**`parsePatchList(version)`** — local-first resolution:
1. Check `patches/<version>/prompt-patches/patches.json` → if exists, return its `patches` array
2. Fall back to upstream `/tmp/prompt-patching/system-prompt/<version>/patch-cli.js` (existing logic)

**`readPatchPair(version, fileId)`** — local-first resolution:
1. Check `patches/<version>/prompt-patches/<fileId>.{find,replace}.txt`
2. Fall back to upstream `/tmp/prompt-patching/system-prompt/<version>/patches/`

**`listVersions()`** — merge local + upstream:
- Scan both `patches/*/prompt-patches/patches.json` (local) and upstream `/tmp/prompt-patching/system-prompt/*/`
- Deduplicate, sort

**New function: `importPromptPatches(targetVersion)`**:
- Source resolution:
  1. Upstream exact version match → use it
  2. Otherwise: find best local (latest ≤ target) and best upstream (latest ≤ target), pick the higher version
- Copies all `.find.txt` / `.replace.txt` files into `patches/<targetVersion>/prompt-patches/`
- Writes `patches.json` with ordered list + `source` annotation (e.g., `"upstream:2.1.51"`, `"local:2.1.59"`)
- Returns `{ count, source, targetDir }` or `null` if no source found

**`hashPatchLogic(version)`** — unchanged (only meaningful for upstream sources)

**Export** the new functions.

### 2. `patches/2.1.42/patch-prompt-slim.js`

**`loadPatchPair(version, fileId)`** — local-first:
1. Check `patches/<version>/prompt-patches/<fileId>.{find,replace}.txt`
2. Fall back to upstream

**Version dir existence check** (line 285-292) — local-first:
1. Check local `patches/<version>/prompt-patches/patches.json` exists
2. Fall back to upstream `/tmp/prompt-patching/system-prompt/<version>/`
3. Error only if neither exists

**Logic hash check** — skip when running from local patches (no `patch-cli.js` to hash).

The `parsePatchList()` import from prompt-baseline already handles local-first after we change it there.

### 3. `claude-patching.js` (`--init` block, ~line 771)

After creating `index.json`, add prompt patch import:

```javascript
// Import prompt patches locally
const { importPromptPatches } = require('./lib/prompt-baseline');
const importResult = importPromptPatches(targetVersion);
if (importResult) {
  log(`  Imported ${importResult.count} prompt patches from ${importResult.source}`);
} else {
  log(`  No prompt patches available to import`);
}
```

Then run baseline generation from the now-local patches (existing code, but it'll read local-first).

### 4. `.claude/skills/upgrade-prompt-patches/SKILL.md`

Rewrite workflow to:

1. **Assess** — `--status` to identify version gap
2. **Setup** — `--setup` to clone/update upstream repo
3. **Init** — `--init` creates `index.json` + imports prompt patches locally
4. **Check** — `--check` runs patches, diagnostics classify failures
5. **Fix** — Edit local files in `patches/<version>/prompt-patches/`
6. **Iterate** — `--check` again until 100%
7. **Apply** — `--apply`

Remove: manual verification steps, any mention of editing upstream `patch-cli.js`.
Add: fallback precedence (local preceding version when upstream is behind).

## Resolution Order Summary

**Runtime (`--check`/`--apply`)**:
| What | Priority 1 (local) | Priority 2 (upstream) | Priority 3 |
|------|--------------------|-----------------------|-------------|
| Patch list | `patches/<v>/prompt-patches/patches.json` | `/tmp/.../system-prompt/<v>/patch-cli.js` | error |
| Patch files | `patches/<v>/prompt-patches/<f>.find.txt` | `/tmp/.../system-prompt/<v>/patches/<f>.find.txt` | error |

**Import (`--init`)** — best-of-both by version:
1. If upstream has exact version → use it (perfect match)
2. Otherwise: find best local candidate (latest `patches/*/prompt-patches/` ≤ target) and best upstream candidate (latest `/tmp/.../system-prompt/*/` ≤ target). **Pick whichever is the higher version.** Rationale: if CC 2.1.61 drops, upstream has 2.1.60, and we have local 2.1.59, use upstream 2.1.60 since it's closer to the target.

## Verification

1. `node claude-patching.js --init` on a version with upstream patches → imports locally
2. Delete `/tmp/prompt-patching/` → `--check` still works from local patches
3. `--init` on a version without upstream → falls back to local preceding
4. Existing `--check`/`--apply` flow unchanged when local patches exist

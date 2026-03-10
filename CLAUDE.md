# Claude Code Patching

Minimal patches for Claude Code without the full tweakcc toolchain.

## CLI Usage

```bash
node claude-patching.js --status              # Detect installations, show versions and patch state
node claude-patching.js --setup               # Prepare environment (backups, repos, prettify)
node claude-patching.js --init                # Create index + import prompt patches for installed version
node claude-patching.js --port                # Full porting pipeline: setup + init + check
node claude-patching.js --check               # Dry run — verify patch patterns match
node claude-patching.js --apply               # Apply all patches
node claude-patching.js --native --check      # Target native install explicitly
node claude-patching.js --bare --apply        # Target bare install explicitly
node claude-patching.js --restore             # Restore from .bak backup
```

**Installation types:**
- `--bare` — pnpm/npm install (standalone cli.js)
- `--native` — Bun-compiled binary (~/.local/bin/claude)

If only one install exists, target flags are optional. If both exist, you must specify.

## Porting to a New CC Version

When a new CC version drops, run `--port` against the updated target:

```bash
node claude-patching.js --native --port
```

This runs **setup** → **init** → **check** in one pass with condensed output. Passing patches are listed by name; failures include diagnostics.

**Typical follow-up:**

1. **Thinking-visibility fails** — This patch is target-specific (bare vs native have different React memo cache structures). Look at the `.pretty` file for the new condition pattern, create a new patch in `patches/<version>/native/` or `bare/`. See `patches/2.1.63/native/patch-thinking-visibility.js` for the current pattern.

2. **Prompt patches diverge** — Use the `upgrade-prompt-patches` skill, which reads the diagnostic output and walks through each failure. The most common causes: unicode escapes in find files (use literal chars), hardcoded variable names (use `__NAME__` placeholders), and restructured array boundaries.

3. **Other patches fail** — Usually a renamed minifier variable. Search the `.pretty` file for the surrounding structure, update the regex.

4. **Re-check iteratively:**
   ```bash
   node claude-patching.js --native --check
   ```

5. **Apply when all pass:**
   ```bash
   node claude-patching.js --native --apply
   ```

6. **Verify with `claude --version`** — The syntax check (built into `--apply`) catches JS errors before the binary is assembled, but always confirm the binary loads.

## What Each Command Does

| Command | Purpose | Idempotent? |
|---------|---------|-------------|
| `--status` | Detects bare/native installs, shows versions, applied patches, workspace artifact freshness | Yes |
| `--setup` | Clones/updates tweakcc + prompt-patching repos, creates `.original` backups from clean sources, generates `.pretty` files via js-beautify. Won't overwrite a clean backup if the source is already patched. | Yes |
| `--init` | Creates `patches/<version>/index.json` from latest existing index, imports prompt patches (upstream base + local customizations merged), generates `upstream-comparison.txt` | No — errors if index already exists |
| `--port` | Composes setup + init + check with condensed output. Init skips silently if index exists. | Yes (when index exists) |
| `--check` | Dry-runs all patches against target. Auto-falls back to latest patch version if none exists for the target version. | Yes |
| `--apply` | Applies patches, writes metadata comment, runs syntax check, reassembles binary (native). Creates `.bak` before patching. | No |
| `--restore` | Copies `.bak` over the live installation. | No |

## Detailed Rules

Scoped rules in `.claude/rules/` provide context-sensitive reference:

| Rule file | Scope | Content |
|-----------|-------|---------|
| `lib-api.md` | `lib/**`, `patches/**/*.js` | output.js, shared.js, prompt-baseline.js API |
| `patch-format.md` | `patches/**` | Patch module contract, index.json, version porting |
| `native-binary.md` | `lib/bun-binary.ts`, native patches | Bun overlay format, size budget |
| `code-exploration.md` | Global | Search tools, cli.js patterns, TUI architecture |
| `reference-repos.md` | Global | tweakcc and prompt-patching repo details |

## Prompt Patches

System prompt patches live in `patches/<version>/prompt-patches/` as `.find.txt`/`.replace.txt` pairs, listed in `patches.json`. Our local set is the **baseline** — it includes optimizations ported from the upstream [prompt-patching](https://github.com/ykdojo/claude-code-tips) repo plus our own custom patches.

**Custom patches** are tracked via the `customPatches` field in `patches.json`. These are carried forward automatically when `--init` imports from upstream:

| Patch | Type | Effect |
|-------|------|--------|
| `expressive-tone` | local-only | Replaces blunt brevity directive with natural expression guidance |
| `natural-emojis` | local-only | Replaces emoji ban with natural usage permission |
| `bash-tool` | divergent | Our version rewrites the full description; upstream only trims one line |
| `code-references` | divergent | Our version removes the adjacent "colon before tool calls" instruction too |
| `doing-tasks-intro` | divergent | Upstream's find cuts mid-sentence, leaving a garbled fragment; ours consumes the full sentence |

**Upstream** (`/tmp/prompt-patching/`, cloned by `--setup`) is a reference for new optimizations, not a dependency. `--init` uses upstream as the base when it has a newer version than our latest local, then merges our `customPatches` on top. The `upstream-comparison.txt` in each version directory shows what differs.

When porting to a new CC version, use the `upgrade-prompt-patches` skill.

## Feature Flag Toggles

`patch-feature-flag-toggles.js` replaces `IL("flag_name",!1)` calls with `!0` for selected flags. Currently enables:
- `tengu_mulberry_fog` — richer memory management prompt
- `tengu_session_memory` + `tengu_sm_compact` — structured session memory compaction

See `feature-flags-2.1.62.md` in the vault for the full flag map.

## Development Workflow

1. `--port` (or `--setup` + `--init` individually) — Prepare the environment
2. Explore cli.js with `rg` / `ast-grep` on `.pretty` files (see `code-exploration.md` rule)
3. Write patch (see `patch-format.md` rule for the contract)
4. `--check` — Dry run to verify (use iteratively as you fix patches)
5. `--apply` — Apply patches (includes syntax check + auto-rollback on failure)

Setup won't overwrite a clean backup if the source is already patched (`__CLAUDE_PATCHES__` marker).

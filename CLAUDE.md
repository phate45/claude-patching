# Claude Code Patching

Minimal patches for Claude Code without the full tweakcc toolchain.

## CLI Usage

```bash
node claude-patching.js --status              # Show detected installations
node claude-patching.js --setup               # Prepare environment (backups, repos, prettify)
node claude-patching.js --init                # Create index for installed version
node claude-patching.js --check               # Dry run (auto-select if single install)
node claude-patching.js --apply               # Apply patches
node claude-patching.js --native --check      # Target native install explicitly
node claude-patching.js --bare --apply        # Target bare install explicitly
```

**Installation types:**
- `--bare` — pnpm/npm install (standalone cli.js)
- `--native` — Bun-compiled binary (~/.local/bin/claude)

If only one install exists, target flags are optional. If both exist, you must specify.

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

**Custom patches** (behavioral, not optimization):
- `expressive-tone` — replaces blunt brevity directive with natural expression guidance
- `natural-emojis` — replaces emoji ban with natural usage permission

**Upstream** (`/tmp/prompt-patching/`, cloned by `--setup`) is a reference for new optimizations, not a dependency. `--init` generates `upstream-comparison.txt` in the version directory showing what upstream has that we don't, and where shared patches differ.

When porting to a new CC version, use the `upgrade-prompt-patches` skill.

## Feature Flag Toggles

`patch-feature-flag-toggles.js` replaces `IL("flag_name",!1)` calls with `!0` for selected flags. Currently enables:
- `tengu_mulberry_fog` — richer memory management prompt
- `tengu_session_memory` + `tengu_sm_compact` — structured session memory compaction

See `feature-flags-2.1.62.md` in the vault for the full flag map.

## Development Workflow

1. `--setup` — Clones/updates repos (tweakcc, prompt-patching), creates backups, prettifies
2. `--init` — Creates new version's index.json, imports prompt patches, generates upstream comparison
3. Explore cli.js with `rg` / `ast-grep` (see `code-exploration.md` rule)
4. Write patch (see `patch-format.md` rule for the contract)
5. `--check` — Dry run to verify
6. `--apply` — Apply patches

Setup won't overwrite a clean backup if the source is already patched (`__CLAUDE_PATCHES__` marker).

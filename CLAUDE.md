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

**Output format:** All commands emit **NDJSON** (one JSON object per line). The last line is always the summary.

```bash
# --check / --apply summary (last line)
... | tail -1 | jq '{applied, failed, success}'

# --port check results
... | jq -r 'select(.type=="port_check") | "Pass: \(.passed | length)/\(.total)"'

# --status install versions
... | jq '.installs | to_entries[] | "\(.key): \(.value.version)"'
```

**Installation types:**
- `--bare` — pnpm/npm install. Since 2.1.117 this ships a wrapper package whose postinstall hardlinks a platform-specific Bun ELF to `bin/claude.exe`. Pre-2.1.117 installs with a standalone `cli.js` are still detected and patched.
- `--native` — Bun-compiled binary (~/.local/bin/claude).

Both install types share the same patching mechanism (Bun overlay extract → patch JS → repack); the bare/native labels only distinguish which install on disk is targeted.

If only one install exists, target flags are optional. If both exist, you must specify.

## Porting to a New CC Version

When a new CC version drops, run `--port` against the updated target:

```bash
node claude-patching.js --native --port
```

This runs **setup** → **init** → **check** in one pass with condensed output. Passing patches are listed by name; failures include diagnostics.

**Typical follow-up:**

1. **Thinking-visibility fails** — Since 2.1.117 bare and native ship byte-identical JS payloads, so a single patch works for both. If the React memo cache structure changes, look at the `.pretty` file for the new condition pattern and create an updated patch in `patches/<version>/js-patches/` (the current going-forward convention). See `patches/2.1.69/native/patch-thinking-visibility.js` for the current pattern — note that older patches still live at their original paths under `bare/` or `native/` subdirs; those legacy locations are kept to support older CC versions and should never be moved.

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
| `--setup` | Clones/updates the tweakcc reference, creates `.original` backups from clean sources, generates `.pretty` files via js-beautify. Won't overwrite a clean backup if the source is already patched. | Yes |
| `--init` | Creates `patches/<version>/index.json` from latest existing index, imports prompt patches by copying the latest local version ≤ target | No — errors if index already exists |
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
| `reference-repos.md` | Global | tweakcc repo details |

## Prompt Patches

System prompt patches live in `patches/<version>/prompt-patches/` as `.find.txt`/`.replace.txt` pairs, listed in `patches.json`. The set is fully self-contained — `--init` populates a new version by copying the latest local version ≤ target. No external dependencies.

Some patches retain historical `customPatches` / `suppressedPatches` keys in `patches.json` (formerly used to merge upstream imports). These fields are now inert and propagate forward only as metadata.

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

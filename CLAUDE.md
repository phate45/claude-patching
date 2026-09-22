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
node claude-patching.js --restore --apply     # Reset state: restore .bak then re-apply all patches (use when editing an
                                              #   already-applied patch — the metadata gate in patch-runner skips IDs
                                              #   listed in __CLAUDE_PATCHES__, so re-applying without reset is a no-op)
```

**Note on the metadata gate:** `--apply` reads the existing `__CLAUDE_PATCHES__` metadata block and skips any patch whose ID already appears there (except `spinner`, which is always re-run). When iterating on a patch you've already applied once, run `--restore --apply` so the binary starts from a clean .bak before the new patch runs. The `--restore` step fails with `ETXTBSY` if a running Claude instance still holds the binary open — close all sessions first.

**Output format:** All commands emit **NDJSON** (one JSON object per line). The last line is always the summary.

`--check`/`--apply` (`type:"summary"`) and `--port` (`type:"port_check"`) share **one** summary shape — same keys, same value types, so the same jq works for either:

```jsonc
{ "passed": ["id", ...],            // applied cleanly
  "failed": [{"id","reason"}, ...], // pattern-not-found AND hard failures (need fixing)
  "skipped": ["id", ...],           // skipped intentionally (already applied per metadata)
  "total": 26,
  "success": true }                 // === failed.length === 0
```

A pattern that doesn't match is a **failure**, not a skip — that's what keeps `success` honest for porting. Counts come from `.passed|length` etc. (no separate count fields).

```bash
# --check / --apply summary (last line)
... | tail -1 | jq '{passed:(.passed|length), failed:(.failed|length), success}'

# failed patch IDs + reasons in one shot
... | tail -1 | jq -c '.failed[]'

# --port check results
... | jq -r 'select(.type=="port_check") | "Pass: \(.passed|length)/\(.total)"'

# --port broken-patch work order (file + diagnostics + top changelog match, per patch)
... | grep '"type":"port_broken"' | jq -r '.orders[] | "\(.id) → \(.file)\n  found: \(.found|join(" · "))\n  hint: \(.expected[0]//"")\n  cl: \(.changelog[0].bullet//"no match")"'

# --status install versions
... | jq '.installs | to_entries[] | "\(.key): \(.value.version)"'
```

**Installation types:**
- `--bare` — pnpm/npm install. Since 2.1.117 this ships a wrapper package whose postinstall hardlinks a platform-specific Bun ELF to `bin/claude.exe`. Pre-2.1.117 installs with a standalone `cli.js` are still detected and patched.
- `--native` — Bun-compiled binary (~/.local/bin/claude).

Both install types share the same patching mechanism (Bun overlay extract → patch JS → repack); the bare/native labels only distinguish which install on disk is targeted.

If only one install exists, target flags are optional. If both exist, you must specify.

## Porting to a New CC Version

**Use the `porting-patches` skill** — it's the concise, current playbook for this whole flow (drives `--port`, reads the work order, walks each fix). What follows is the reference detail.

When a new CC version drops, run `--port` against the updated target:

```bash
node claude-patching.js --native --port
```

This runs **setup** → **init** → **flag scan** → **env scan** → **check** → **changelog scan** → **work order** in one pass with condensed output. Passing patches are listed by name; each broken patch ends up in a **work order** (`type:"port_broken"`) that joins its source path, the discovery lines it emitted before failing (how far it got), its `Expected:` hints, and its top changelog match — one actionable record per broken patch, no artifact cross-referencing needed.

**Typical follow-up:**

1. **Thinking-visibility fails** — Since 2.1.117 bare and native ship byte-identical JS payloads, so a single patch works for both. If the React memo cache structure changes, look at the `.pretty` file for the new condition pattern and create an updated patch in `patches/<version>/js-patches/` (the current going-forward convention). See `patches/2.1.69/native/patch-thinking-visibility.js` for the current pattern — note that older patches still live at their original paths under `bare/` or `native/` subdirs; those legacy locations are kept to support older CC versions and should never be moved.

2. **Prompt patches diverge** — Use the `upgrade-prompt-patches` skill, which reads the diagnostic output and walks through each failure. The most common causes: unicode escapes in find files (use literal chars), hardcoded variable names (use `__NAME__` placeholders), and restructured array boundaries.

3. **Other patches fail** — Usually a renamed minifier variable. Search the `.pretty` file for the surrounding structure, update the regex.

4. **Re-check iteratively, and once more before calling the port done:**
   ```bash
   node claude-patching.js --native --check
   ```
   `--port` skips the chunk-scope stage, so a green `--port` is not a finished port — only a green standalone `--check` is. See "Chunk Scope" below.

5. **Apply when all pass:**
   ```bash
   node claude-patching.js --native --apply
   ```

6. **Verify with `claude --version`** — The encoding and syntax checks (built into `--apply`) catch injected raw non-ASCII and JS errors before the binary is assembled, but always confirm the binary loads.

## What Each Command Does

| Command | Purpose | Idempotent? |
|---------|---------|-------------|
| `--status` | Detects bare/native installs, shows versions, applied patches, workspace artifact freshness | Yes |
| `--setup` | Clones/updates the tweakcc and claude-code reference repos, creates `.original` backups from clean sources, generates `.pretty` files via js-beautify. Won't overwrite a clean backup if the source is already patched. | Yes |
| `--init` | Creates `patches/<version>/index.json` from latest existing index, imports prompt patches by copying the latest local version ≤ target | No — errors if index already exists |
| `--port` | Composes setup + init + check with condensed output. Init skips silently if index exists. Also runs `scan-feature-flags.js` and `scan-env-vars.js` after setup to produce `flags.json`/`env-vars.json` (plus `diff-<prev>.json`/`env-diff-<prev>.json` if a prior inventory exists), and — after check (Phase 3.5) — `scan-changelog.js` to produce `changelog-impact.json`, all under `patches/<version>/`. Finally (Phase 3.6) emits a broken-patch **work order** (`type:"port_broken"`): per broken patch, its file path + `found`/`expected` diagnostics + top changelog matches, joined for direct action. | Yes (when index exists) |
| `--check` | Dry-runs all patches against target, then scans chunk scope (see below). Auto-falls back to latest patch version if none exists for the target version. | Yes |
| `--apply` | Applies patches, writes metadata comment, runs encoding + syntax checks, reassembles binary (native). Creates `.bak` before patching. | No |
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

**Write literal unicode characters in both `.find.txt` and `.replace.txt` — never hand-write `\uXXXX`.** The engine matches the find side either way and escapes the replacement unconditionally; raw UTF-8 reaching the bundle renders as mojibake. `--apply` fails if a patch gains non-ASCII. Details in the `reference-repos.md` rule.

Some patches retain historical `customPatches` / `suppressedPatches` keys in `patches.json` (formerly used to merge upstream imports). These fields are now inert and propagate forward only as metadata.

When porting to a new CC version, use the `upgrade-prompt-patches` skill.

## Feature Flag Toggles

The gate function name and enabled flags are documented in the patch file itself — see `patches/2.1.133/js-patches/patch-feature-flag-toggles.js` for the current list and retired flag history.

For a full flag inventory for any version, run:

```bash
node scan-feature-flags.js cli.js.native.pretty --save patches/<version>/flags.json
node scan-feature-flags.js cli.js.native.pretty --diff patches/<prev>/flags.json
```

See `feature-flags-2.1.143.md` in the vault for the current flag map (as of 2.1.143).

## Env Var Tracking

`scan-env-vars.js` is the sibling of the flag scanner — same NDJSON contract, same per-version inventory + diff layout — but tracks `CLAUDE_CODE_*` and `ANTHROPIC_*` environment variable names instead of GrowthBook flags. Env reads have no uniform accessor (`process.env.X`, the minified env mirror `z$.X`, quoted keys), so it extracts by **name token** and records the normalised access **forms** (`process.env` / `property` / `string` / `bracket` / `other`) plus occurrence counts rather than a default value. `--port` runs it automatically (Phase 2.6).

```bash
node scan-env-vars.js cli.js.native.pretty --save patches/<version>/env-vars.json
node scan-env-vars.js cli.js.native.pretty --diff patches/<prev>/env-vars.json
```

Inventory lands at `patches/<version>/env-vars.json`; the diff at `patches/<version>/env-diff-<prev>.json`. The diff surfaces `added` / `occurrences_changed` / removed (no `default_changed` — env reads carry no default). Note: a bare `rg 'ANTHROPIC_[A-Z0-9_]+'` over-counts because names like `CLAUDE_CODE_USE_ANTHROPIC_AWS` embed an `ANTHROPIC_` substring; the scanner consumes the enclosing `CLAUDE_CODE_` token first, so its counts are the honest ones.

## Changelog Impact

`scan-changelog.js` correlates the upstream CC changelog against our patch set. It answers two things: **what changed** between the version we last patched and the target, and **what might break** — which patches are most likely impacted, especially those flagged broken by `--check`.

The changelog source is `anthropics/claude-code`'s `CHANGELOG.md` (chosen over `feed.xml`: plain markdown, trivial to parse, and — decisively — it preserves the backticks around env vars, flags, tool names, and settings keys, which is exactly the impact signal). `--setup` shallow-clones the repo to `/tmp/claude-code-src`.

Matching is **BM25 fuzzy search** via SQLite FTS5 — reached through `node:sqlite` (Node 22+) or `bun:sqlite` (Bun), selected at runtime. **No `better-sqlite3`, no native addon, no build step.** The changelog bullets in range `(from, to]` are the corpus; each patch's document (its id + `index.json` notes + the patch file's leading `/** */` header) is tokenised into an OR-query. BM25's IDF surfaces the shared *feature* words (thinking, skill, background, table, …) and ignores minified var names that never appear in prose. It's a **triage aid, not a verdict** — every patch matches something; read the relative ranking, and expect a noise floor for patches with no real change in-window.

```bash
node scan-changelog.js /tmp/claude-code-src/CHANGELOG.md --to <ver> [--from <prev>] \
  --index patches/<ver>/index.json --save patches/<ver>/changelog-impact.json [--broken id1,id2]
```

`--port` runs this automatically (Phase 3.5), passing the `--broken` ids from the check phase and using the previous indexed version as `--from`. The artifact (`patches/<version>/changelog-impact.json`) carries `changelog` (the between-versions overview), `patchImpacts` (per-patch ranked matches, broken patches sorted first), and a **`reasoning` block that starts empty** — that's the human/LLM layer: fill it in with your findings as you fix broken patches (e.g. "thinking-visibility: matches are noise, no relevant entry" or "cron-visibility broke because 2.1.209 reverted the background-session guard").

```bash
# broken patches + their top changelog match, from the artifact
jq -r '.patchImpacts[] | select(.broken) | "\(.id): \(.matches[0].bullet // "no match")"' patches/<ver>/changelog-impact.json
```

## Chunk Scope

Since 2.1.246 the bundle is ~1700 separately-scoped Bun chunk modules. A patch
injecting a captured identifier into a chunk that never imported it produces a
free variable — which passes `--check`, passes the syntax check, assembles and
loads, then throws `ReferenceError` the first time that expression runs. See the
cross-chunk rule in `patch-format.md` for how to write around it.

`--check` catches it. After the pattern pass it shadow-applies every patch to a
pristine extract, maps each inserted span back to the chunk that owns it, and
reports identifiers the chunk has no binding for. Findings land in `failed`, so
`success` goes false and the summary jq works unchanged:

```bash
node claude-patching.js --native --check 2>&1 | grep '"type":"chunk_scope"' | jq -c '.findings[]'
```

Two things to know before trusting a green result:

- It needs an **unpatched** binary for chunk boundaries — patching shifts them.
  It uses `install.path` when clean, else `install.path + '.bak'`. With neither it
  emits `chunk_scope_skipped` with a reason rather than a false pass.
- It roughly doubles `--check`'s runtime, which is why `--port` skips it
  (Phase 3 stays fast, and a cross-chunk reference is only actionable once the
  patterns match). `--no-chunk-scope` skips it on demand.

## Development Workflow

1. `--port` (or `--setup` + `--init` individually) — Prepare the environment
2. Explore cli.js with `rg` / `ast-grep` on `.pretty` files (see `code-exploration.md` rule)
3. Write patch (see `patch-format.md` rule for the contract)
4. `--check` — Dry run to verify (use iteratively as you fix patches)
5. `--apply` — Apply patches (includes syntax check + auto-rollback on failure)

Setup won't overwrite a clean backup if the source is already patched (`__CLAUDE_PATCHES__` marker).

**Branching:** This is a solo single-maintainer repo — commit directly to `master`, no feature branches or PRs. (Overrides the default "branch first" guardrail.)

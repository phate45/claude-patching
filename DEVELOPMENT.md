# Development

Guide for creating, maintaining, and porting patches.

## Tools

Optional requirements for developing new patches:
- `js-beautify` for prettifying the minified JS to something readable
- `ast-grep` for semantic code search in the prettified JS

The `chunk-pretty.sh` utility splits the prettified file into chunks for `ast-grep` (the pretty JS has ~500K lines, and `ast-grep` chokes at 200K).

## CLI Reference

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

| Command | Purpose | Idempotent? |
|---------|---------|-------------|
| `--status` | Detects bare/native installs, shows versions, applied patches, workspace artifact freshness | Yes |
| `--setup` | Clones/updates tweakcc + prompt-patching repos, creates `.original` backups from clean sources, generates `.pretty` files via js-beautify | Yes |
| `--init` | Creates `patches/<version>/index.json` from latest existing index, imports prompt patches (upstream base + local customizations merged), generates `upstream-comparison.txt` | No — errors if index already exists |
| `--port` | Composes setup + init + check with condensed output. Init skips silently if index exists. | Yes (when index exists) |
| `--check` | Dry-runs all patches against target. Auto-falls back to latest patch version if none exists for the target version. | Yes |
| `--apply` | Applies patches, writes metadata comment, runs syntax check, reassembles binary (native). Creates `.bak` before patching. | No |
| `--restore` | Copies `.bak` over the live installation. | No |

**JSON output:** Set `CLAUDECODE=1` for structured JSONL output (agent-friendly). Automatically set within Claude Code's `Bash` tool.

## Version Porting Workflow

When a new CC version drops, run `--port` against the updated target:

```bash
node claude-patching.js --native --port
```

This runs **setup** → **init** → **check** in one pass with condensed output. Passing patches are listed by name; failures include diagnostics.

**Typical follow-up:**

1. **Thinking-visibility fails** — This patch is target-specific (bare vs native have different React memo cache structures). Look at the `.pretty` file for the new condition pattern, create a new patch in `patches/<version>/native/` or `bare/`.

2. **Prompt patches diverge** — Use the `upgrade-prompt-patches` skill, which reads the diagnostic output and walks through each failure. Common causes: unicode escapes in find files (use literal chars), hardcoded variable names (use `__NAME__` placeholders), and restructured array boundaries.

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

You can also test patches from a different version explicitly:

```bash
node claude-patching.js --native --check --patches-from 2.1.63
```

## Patch Structure

Patches are organized by CC version in `patches/<version>/`:

```
patches/
├── 2.1.14/
│   ├── index.json           # Defines which patches apply to this version
│   ├── patch-spinner.js
│   └── patch-thinking-visibility.js
├── 2.1.23/
│   ├── index.json
│   └── bare/
│       └── patch-thinking-style.js   # Install-type specific
```

**index.json format:**
```json
{
  "version": "2.1.23",
  "patches": {
    "common": [
      { "id": "ghostty-term", "file": "2.1.14/patch-ghostty-term.js" }
    ],
    "bare": [
      { "id": "thinking-style", "file": "2.1.23/bare/patch-thinking-style.js" }
    ],
    "native": [
      { "id": "thinking-style", "file": "2.1.19/patch-thinking-style.js" }
    ]
  }
}
```

- **common**: Applied to both bare and native installs
- **bare**: Only for pnpm/npm installs
- **native**: Only for Bun binary installs
- **file**: Path relative to `patches/` — can reference patches from older versions if they still work

## Writing Patches

Claude Code's JS is a ~11MB minified/bundled file (~215MB in the native binary). The minifier is deterministic — same source produces the same variable names — but names change between versions.

### Pattern Matching Strategy

1. **Explore** — Find target code with `rg` and/or `ast-grep` against the prettified file
2. **Understand** — Read surrounding code in `cli.js.{type}.pretty` to grasp context
3. **Pattern** — Build regex against the ORIGINAL minified `cli.js`:
   - Match structure, not specific variable names
   - Use `[$\w]+` to match any identifier (includes `$`)
   - Use word boundaries (`\b`) for performance
   - Capture variable names dynamically from matches
4. **Test** — Always test with `--check` before applying

### Individual Patch Usage

Individual patch scripts require the `cli.js` path explicitly (no auto-discovery):

```bash
node patch-thinking-visibility.js --check /path/to/cli.js    # dry run
node patch-thinking-visibility.js /path/to/cli.js             # apply
```

**Note:** Individual patches are not idempotent — they search for original patterns which don't exist after patching. The metadata system in `claude-patching.js` handles this; for individual patches, restore from backup before re-applying.

## Prompt Patches

System prompt patches live in `patches/<version>/prompt-patches/` as `.find.txt`/`.replace.txt` pairs, listed in `patches.json`.

### Custom Patches

The `customPatches` field in `patches.json` tracks patches we wrote or intentionally diverged from upstream. These are carried forward automatically when `--init` imports from a newer upstream version:

| Patch | Type | Effect |
|-------|------|--------|
| `expressive-tone` | local-only | Replaces blunt brevity directive with natural expression guidance |
| `natural-emojis` | local-only | Replaces emoji ban with natural usage permission |
| `bash-tool` | divergent | Our version rewrites the full description; upstream only trims one line |
| `code-references` | divergent | Our version removes the adjacent "colon before tool calls" instruction too |

Without `customPatches`, the merge logic can't distinguish "our custom patch" from "upstream patch they dropped" — which would cause dropped upstream patches to be incorrectly resurrected on import.

### Upstream Integration

The upstream [prompt-patching](https://github.com/ykdojo/claude-code-tips) repo (`/tmp/prompt-patching/`, cloned by `--setup`) is a reference for new optimizations, not a dependency. `--init` uses upstream as the base when it has a newer version than our latest local, then merges our `customPatches` on top. The `upstream-comparison.txt` in each version directory shows what differs.

### Regex Engine

The prompt patch regex engine (`createRegexPatch()` from upstream):
- `${varName}` placeholders match template literal vars (`${n3}`, `${T3}`) — auto-adapts across versions
- `__NAME__` placeholders match plain identifiers (`kY7`, `aDA`)
- Placeholders become regex capture groups with backreferences in replacements
- Also handles native unicode escapes (em-dash, arrows, smart quotes → `\\uXXXX`)

The patch checks a logic hash of the upstream engine at runtime. If the engine changes between CC versions, a warning is emitted.

## Patch Implementation Details

### thinking-visibility

Modifies the `case"thinking"` branch in the message renderer to always pass `isTranscriptMode:!0`, bypassing the visibility gate that normally hides thinking blocks outside transcript mode.

### thinking-style (dormant)

Modifies the markdown renderer to accept a `dim` prop. When `dim=true`, wraps rendered text strings in `chalk.dim.italic()`. The thinking component passes `dim:!0` to the markdown renderer. Wraps *text strings* before they become React elements, avoiding the "Box can't be inside Text" issue. Must apply after the visibility patch.

### spinner

1. Finds the spinner function that returns platform-specific characters
2. Replaces it with a function returning a custom character sequence
3. Patches animation mode (loop vs mirror) and the freeze-on-disconnect behavior

**Configuration** — constants at the top of the patch file:

```javascript
const SPINNER_CHARS = ["·","·","✧","✦","✧","·"];  // character sequence
const LOOP_MODE = true;           // true=continuous loop, false=bounce
const NO_FREEZE = true;           // true=always animate, false=freeze on disconnect
const SPINNER_ROW_PADDING = 1;    // left padding (chars) for spinner row
```

Supports re-patching — edit `SPINNER_CHARS` and re-run without restoring from backup first.

### ghostty-term

Finds the `xterm-kitty` truecolor detection check and adds `xterm-ghostty` as an additional condition. Ghostty uses `TERM=xterm-ghostty` and supports truecolor, but CC only recognizes `xterm-kitty`.

### feature-flag-toggles

Replaces `IL("flag_name",!1)` calls with `!0` for selected flags:
- `tengu_mulberry_fog` — Richer memory management prompt
- `tengu_session_memory` + `tengu_sm_compact` — Structured session memory compaction

### system-reminders

**Configuration** — constants at the top of the patch file:

```javascript
const MALWARE_REMINDER = 'remove';       // 'remove' or 'keep'
const TASK_REMINDER = 'concise';         // 'concise', 'remove', or 'keep'
const FILE_MODIFIED_REMINDER = 'concise'; // 'concise', 'remove', or 'keep'
```

### quiet-notifications

1. Flags task IDs in a `globalThis` Set when `TaskOutput` successfully retrieves output
2. Intercepts the queue dispatch function (dequeue path) — skips notification if flagged
3. Intercepts the main loop consumer (streaming fallback path) — skips with `continue` if flagged

### read-summary

Finds the verbose-mode gate in `renderToolUseMessage` for the Read tool and removes the verbose flag from the condition so offset/limit info always displays.

## Patch Metadata

The patching script tracks applied patches via a JSON comment embedded in the JS:

```javascript
/* __CLAUDE_PATCHES__ {"ccVersion":"2.1.68","appliedAt":"2026-03-04","patches":[...]} */
```

This works for both bare and native installs (the native binary contains plaintext JS). Run `--status` to see applied patches.

## Backups and Recovery

`--apply` creates a `.bak` next to the installation before patching. `--setup` creates workspace backups (`cli.js.{type}.original`) and prettified files.

**Safety:** `--setup` won't overwrite an existing backup if the source is already patched (`__CLAUDE_PATCHES__` marker).

### Full Recovery (bare install)

If both `.bak` and `.original` are tainted, download a fresh package:

```bash
npm pack @anthropic-ai/claude-code@2.1.68 --pack-destination /tmp
mkdir -p /tmp/cc-pristine
tar xzf /tmp/anthropic-ai-claude-code-2.1.68.tgz -C /tmp/cc-pristine
cp /tmp/cc-pristine/package/cli.js /path/to/cli.js
```

If pnpm cache is stale:

```bash
pnpm remove -g @anthropic-ai/claude-code
pnpm store prune
pnpm install -g @anthropic-ai/claude-code --force
```

Native binary must be re-downloaded separately.

## Troubleshooting

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for lessons learned about Ink component hierarchy, chalk styling, pattern matching, and debugging techniques.

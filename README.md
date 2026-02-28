# Claude Code Patches

Minimal patches for Claude Code, supporting both installation methods:
- **bare** — pnpm/npm install (standalone `cli.js`) — **fully supported**
- **native** — Bun-compiled binary (`~/.local/bin/claude`) — **fully supported**

## Explainer

This is my little collection of 'adjustments', originally inspired by [tweakcc](https://github.com/Piebald-AI/tweakcc). However, their approach is a little heavy handed, so i went and made my own thing with just the things i want/need.
Use at your own peril.

For currently supported CC versions, see the contents of the [patches](./patches/) folder.

**Current status (2.1.63):**
- 9 patches working (ghostty-term, thinking-visibility, spinner, system-reminders, no-collapse-reads, quiet-notifications, read-summary, prompt-slim, feature-flag-toggles) for both installations
- 60 prompt patches (58 upstream optimizations + 2 custom expression patches)
- auto-memory patch retired — evolved into feature-flag-toggles (see below)
- thinking-style patch is currently redundant as the 'default' style is the dim i was patching for
- Prompt patches now use **local-first storage** (`patches/<version>/prompt-patches/`), with upstream comparison on `--init`
- Regex engine fix: `__NAME__` placeholders now correctly interleave with `${__VAR__}` placeholders regardless of text position

**Runtime:** Node.js 22+ or [Bun](https://bun.sh). Bun handles the TypeScript sources natively without additional flags. If using Node < 25, you may need `--experimental-strip-types`.

## Quick Start

```bash
# Show detected installations and patch status
node claude-patching.js --status

# Dry run - verify patterns match
node claude-patching.js --check

# Apply all patches
node claude-patching.js --apply

# Full porting pipeline for a new version
node claude-patching.js --native --port

# See all options
node claude-patching.js --help
```

If both installation types exist, specify the target explicitly:

```bash
node claude-patching.js --native --check    # Check native install
node claude-patching.js --bare --apply      # Apply to bare install
```

**JSON output:** Set `CLAUDECODE=1` for structured JSONL output (agent-friendly).
Note: This is automatically set within Claude Code's `Bash` tool executions.

## After CC Updates

CC updates replace the installation entirely, removing patches and metadata.

**If patches still match the new version** (minor bump, no code changes):

```bash
node claude-patching.js --check     # verify patterns match
node claude-patching.js --apply     # re-apply
```

**If it's a new version that needs porting:**

```bash
node claude-patching.js --native --port
```

`--port` runs **setup** → **init** → **check** in one pass with condensed output. It prepares backups, creates `patches/<version>/index.json` from the latest existing set, imports prompt patches, and dry-runs everything — reporting which patches pass, which fail, and diagnostic context for failures.

Typical porting workflow after `--port`:

1. Fix failing patches (search `.pretty` files for new patterns)
2. `--check` iteratively until everything passes
3. `--apply` when ready
4. Verify with `claude --version`

For prompt patch failures specifically, use the `upgrade-prompt-patches` skill in Claude Code — it reads the diagnostic output and walks through each failure.

## Patches

### thinking-visibility

Makes thinking/reasoning blocks visible inline in the TUI (normally only visible in transcript mode via Ctrl+O).

### thinking-style

Styles thinking block content with dim gray italic text (like older CC versions).

**What it does:**
1. Modifies the markdown renderer to accept a `dim` prop
2. When `dim=true`, wraps rendered text strings in `chalk.dim.italic()`
3. Modifies the thinking component to pass `dim:!0` to the markdown renderer

This approach wraps *text strings* with chalk styling before they become React elements, avoiding the "Box can't be inside Text" issue.

**Note:** Apply after the visibility patch.

### patch-spinner

Customizes the spinner animation shown while Claude is working.

**What it does:**
1. Finds the spinner function that returns platform-specific characters
2. Replaces it with a simple function returning a custom character sequence
3. Optionally patches animation mode (loop vs mirror)
4. Optionally removes the freeze-on-disconnect behavior

**Configuration:**
Edit the constants at the top of the patch file:

```javascript
const SPINNER_CHARS = ["·","·","✧","✦","✧","·"];  // default: thought surfacing
const LOOP_MODE = true;           // true=continuous loop, false=bounce back-and-forth
const NO_FREEZE = true;           // true=always animate, false=freeze when disconnected
const SPINNER_ROW_PADDING = 1;    // left padding (chars) for the spinner + status row
```

**Character sequences:**
- `["·","·","✧","✦","✧","·"]` - thought surfacing (default)
- `["·","∴","∴","·","∵","∵"]` - therefore/because doubled (matches "∴ Thinking")
- `["◐","◓","◑","◒"]` - rotating half-moon
- `["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]` - braille spinner
- `["○","◔","◑","◕","●","◕","◑","◔"]` - filling circle
- `["◢","◣","◤","◥"]` - rotating triangle
- `["✧","·","✦","·"]` - twinkling star

**Tip:** Double up characters (e.g., `["◢","◢","◣","◣",...]`) to slow down the animation.

**Re-patching:** This patch supports changing spinner characters on an already-patched cli.js. Just edit `SPINNER_CHARS` and re-run — no need to restore from backup first.

### ghostty-term

Adds truecolor (16M colors) support for Ghostty terminal.

**What it does:**
1. Finds the `xterm-kitty` truecolor detection check
2. Adds `xterm-ghostty` as an additional condition for truecolor support

**Why it's needed:**
Ghostty uses `TERM=xterm-ghostty` and supports truecolor, but Claude Code only recognizes `xterm-kitty` for truecolor detection. Without this patch, Ghostty only gets basic 16 colors because it matches `/^xterm/` but not `/-256(color)?$/`.

### feature-flag-toggles

Enables hidden feature flags that improve memory and compaction behavior.

**Flags enabled:**
- `tengu_mulberry_fog` — Richer memory management prompt with MUST directives, frontmatter format, and cross-session knowledge building instructions
- `tengu_session_memory` + `tengu_sm_compact` — Structured session memory compaction: maintains a living `summary.md` per session instead of throw-away summaries during context compaction

**Kill switch:** `DISABLE_CLAUDE_CODE_SM_COMPACT=1` disables session memory compaction.

**History:** Replaces the retired auto-memory patch (`tengu_oboe`, removed in 2.1.59 when auto-memory graduated to always-on).

### no-collapse-reads

Disables the collapsing of consecutive Read/Search tool calls into summary lines.

**What it does:**
1. Finds the predicate function that classifies tool uses as "collapsible" (Read, Grep, Glob)
2. Short-circuits it to always return false

**Why it's needed:**
CC 2.1.39 introduced `collapsed_read_search` grouping — consecutive Read/Grep/Glob calls get collapsed into a single line like "Read 3 files (ctrl+o to expand)". This hides useful context about which files were read and how many lines each contained. The patch restores the previous behavior where each tool call is displayed individually.

### system-reminders

Reduces token overhead from injected system reminders.

**What it does:**
1. Removes the malware warning injected after every file read (~70 tokens each)
2. Replaces the verbose task tools reminder with a concise version
3. Replaces the file modification notice (removes file content dump)

**Why it's needed:**
CC injects `<system-reminder>` tags into tool results. The malware warning fires on *every* `Read` tool call, burning ~70 tokens each time. The file modification reminder dumps entire file contents on every external change. Over a long conversation history, this adds up to millions of wasted tokens.

**Configuration:**
Edit the constants at the top of the patch file:

```javascript
const MALWARE_REMINDER = 'remove';       // 'remove' or 'keep'
const TASK_REMINDER = 'concise';         // 'concise', 'remove', or 'keep'
const FILE_MODIFIED_REMINDER = 'concise'; // 'concise', 'remove', or 'keep'
```

**Token savings:**
- Malware reminder: ~70 tokens × N file reads per conversation
- Task reminder: ~100 tokens → ~15 tokens (when triggered)
- File modification: ~500+ tokens → ~25 tokens (per changed file)

### quiet-notifications

Suppresses duplicate background agent notifications when `TaskOutput` has already read the output.

**What it does:**
1. Flags task IDs in a `globalThis` Set when `TaskOutput` successfully retrieves output
2. Intercepts the queue dispatch function (dequeue path) — skips notification if flagged
3. Intercepts the main loop consumer (streaming fallback path) — skips with `continue` if flagged

**Why it's needed:**
When a background agent completes, its notification is enqueued via polling *before* `TaskOutput` can read the result (100ms polling delay). If the model calls `TaskOutput` during its turn, the notification is still queued and fires after the turn ends — duplicating the agent's output in context. Over sessions with heavy background agent use, this wastes significant context on redundant content.

**Behavior:**
- If `TaskOutput` reads the output → notification is silently suppressed
- If `TaskOutput` is never called → notification fires normally
- If `TaskOutput` returns `not_ready` (agent still running) → no flag set, notification fires normally

### read-summary

Shows offset/limit information in the Read tool's compact display.

**What it does:**
1. Finds the verbose-mode gate in `renderToolUseMessage` for the Read tool
2. Removes the verbose flag from the condition so offset/limit info always displays

**Before:** `Read(claude-patching.js)`
**After:** `Read(claude-patching.js · lines 200-229)`

**Why it's needed:**
When reading a section of a file with offset/limit, the compact tool display only shows the filename — you can't tell which part of the file was read without expanding to verbose mode. This patch surfaces the line range in the compact view, using the same `· lines X-Y` format that verbose mode already provides.

### prompt-slim

Reduces system prompt token overhead and adjusts behavioral instructions via 60 find/replace patches. 58 are optimization patches adapted from [claude-code-tips](https://github.com/ykdojo/claude-code-tips), plus 2 custom expression patches.

**What it does:**
1. Reads patch pairs (`.find.txt` / `.replace.txt`) from `patches/<version>/prompt-patches/` (our baseline), with fallback to the upstream repo
2. Uses a regex engine with placeholder support (`${varName}`, `__NAME__`) to match patterns across minified variable names
3. Applies all patches sequentially, handling both plain string matches and native unicode escapes
4. Built-in diagnostics classify failures as `chained`, `diverged`, or `not found` with context snippets

**Effect:**
- ~38KB of verbose system prompt text replaced with concise equivalents
- Tool descriptions, multi-paragraph examples, and redundant instructions condensed
- `expressive-tone` — replaces "Your responses should be short and concise" with natural expression guidance
- `natural-emojis` — replaces the blanket emoji ban with "Use emojis naturally to enhance communication"

**Local storage:** `--init` imports prompt patches locally so they survive container restarts. It also generates an upstream comparison report (`upstream-comparison.txt`) showing new patches, content differences, and patches unique to our set.

**Upstream tracking:** The patch checks a logic hash of the upstream `createRegexPatch()` engine at runtime. If the engine changes between CC versions, a warning is emitted.

## Patch Metadata

The patching script tracks applied patches via a JSON comment embedded in the JS:

```javascript
/* __CLAUDE_PATCHES__ {"ccVersion":"2.1.17","appliedAt":"2026-01-23","patches":[...]} */
```

This works for both bare and native installs (the native binary contains plaintext JS). Run `--status` to see applied patches.

## Backups and Recovery

### Before Patching

Run `--setup` to create local backups automatically:

```bash
node claude-patching.js --setup
```

This creates:
- `cli.js.bare.original` — backup of bare install (if detected and unpatched)
- `cli.js.native.original` — backup of native install (if detected and unpatched)
- `cli.js.{type}.pretty` — prettified versions for code exploration

**Safety:** Setup won't overwrite an existing backup if the source is already patched. This prevents accidentally losing a clean backup.

The `--apply` command also creates `.bak` files next to the original as an additional safeguard.

### Restoring from Backup

If patches cause issues:

```bash
# Restore from .bak (created by --apply before patching)
node claude-patching.js --bare --restore
node claude-patching.js --native --restore

# Or manually from workspace backup:
cp ./cli.js.bare.original /path/to/cli.js
```

### Full Recovery (Fresh CC Install)

If backup is missing or corrupted, reinstall CC from scratch. **pnpm caches aggressively**, so you must clear the cache to get a fresh copy:

```bash
# 1. Remove the global package
pnpm remove -g @anthropic-ai/claude-code

# 2. Prune orphaned packages from pnpm store
pnpm store prune

# 3. Reinstall fresh (--force ensures fresh download)
pnpm install -g @anthropic-ai/claude-code --force

# 4. Run setup to prepare for patching
node claude-patching.js --setup

# 5. Verify installation
claude --version
```

If that doesn't work, nuclear option:

```bash
# Remove global package
pnpm remove -g @anthropic-ai/claude-code

# Find and remove from pnpm store manually
STORE_PATH=$(pnpm store path)
rm -rf "$STORE_PATH"/*claude-code*

# Reinstall
pnpm install -g @anthropic-ai/claude-code
```

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for patch development workflow, tooling, and individual patch usage.

## Troubleshooting

See `TROUBLESHOOTING.md` for lessons learned about:
- Ink component hierarchy (Box vs Text)
- Chalk styling on strings vs components
- Pattern matching strategies
- Debugging techniques

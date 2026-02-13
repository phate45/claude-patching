# Claude Code Patches

Minimal patches for Claude Code, supporting both installation methods:
- **bare** — pnpm/npm install (standalone `cli.js`) — **fully supported**
- **native** — Bun-compiled binary (`~/.local/bin/claude`) — **fully supported**

## Explainer

This is my little collection of 'adjustments', originally inspired by [tweakcc](https://github.com/Piebald-AI/tweakcc). However, their approach is a little heavy handed, so i went and made my own thing with just the things i want/need.
Use at your own peril.

For currently supported CC versions, see the contents of the [patches](./patches/) folder.

**Current status (2.1.41):**
- 8 patches working (ghostty-term, thinking-visibility, spinner, system-reminders, auto-memory, no-collapse-reads, quiet-notifications, read-summary) for both installations
- thinking-style patch is currently redundant as the 'default' style is the dim i was patching for

**Runtime:** Node.js 22+ or [Bun](https://bun.sh). Bun handles the TypeScript sources natively without additional flags. If using Node < 25, you may need `--experimental-strip-types`.

## Quick Start

```bash
# Show detected installations and patch status
node claude-patching.js --status

# Dry run - verify patterns match
node claude-patching.js --check

# Apply all patches
node claude-patching.js --apply

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

```bash
# Check status (will show "Patches: (none)")
node claude-patching.js --status

# Test patches (patterns may have changed between versions)
node claude-patching.js --check

# Create index.json for the new version (copies from latest existing)
# Great if the above check returns that all the patches can be applied without changes.
node claude-patching.js --init

# If so, re-apply patches
node claude-patching.js --apply

# If not, update backups and prettified files, and get ready for some js spelunking
node claude-patching.js --setup
```

`--init` detects the installed version(s) and creates a new `patches/<version>/index.json` from the most recent existing index. If bare and native are on different versions, it picks the newer one.

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
const SPINNER_CHARS = ["·","∴","∴","·","∵","∵"];  // default: therefore/because (doubled)
const LOOP_MODE = true;   // true=continuous loop, false=bounce back-and-forth
const NO_FREEZE = true;   // true=always animate, false=freeze when disconnected
```

**Character sequences:**
- `["·","∴","∴","·","∵","∵"]` - therefore/because doubled (default, matches "∴ Thinking")
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

### auto-memory

Enables the `tengu_oboe` feature-flagged auto memory system.

**What it does:**
1. Finds the GrowthBook feature flag check for `tengu_oboe`
2. Replaces the server-side flag lookup with a hard `true`
3. Preserves the `CLAUDE_CODE_DISABLE_AUTO_MEMORY` env var kill switch

**Effect when enabled:**
- `MEMORY.md` is loaded into the system prompt from `~/.claude/projects/<project>/memory/`
- First 200 lines are injected; longer files are truncated with a warning
- Custom agents gain memory scopes (`user`, `project`, `local`) via frontmatter
- Memory directories get automatic read/write permission bypasses

**Disable at runtime:** `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude`

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
2. Intercepts the hD1 queue consumer (React useEffect path) — skips notification if flagged
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

# 4. Verify installation
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

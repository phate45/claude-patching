# Claude Code Patches

Minimal patches for Claude Code, supporting both installation methods:
- **bare** — pnpm/npm install (standalone `cli.js`)
- **native** — Bun-compiled binary (`~/.local/bin/claude`)

## Explainer

This is my little collection of 'adjustments', originally inspired by [tweakcc](https://github.com/Piebald-AI/tweakcc). However, their approach is a little heavy handed, so i went and made my own thing with just the things i want/need.
Use at your own peril.

### Supported setup

Optional requirements (for developing new patches):
- `js-beautify` for prettifying the minified js to something that can be parsed and read
- `ast-grep` for semantic code search in the prettified js

The `chunk-pretty.sh` utility splits the prettified file into chunks for `ast-grep` (the pretty js has ~500K lines, and `ast-grep` chokes at 200K).

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

## Patches

### patch-thinking-visibility.js

Makes thinking/reasoning blocks visible inline in the TUI (normally only visible in transcript mode via Ctrl+O).

**What it does:**
1. Finds the `case"thinking":` renderer in the minified React code
2. Removes the `if(!isTranscriptMode && !verbose) return null` guard
3. Sets `isTranscriptMode` to `true` so thinking renders inline

### patch-thinking-style.js

Styles thinking block content with dim gray italic text (like older CC versions).

**What it does:**
1. Modifies `QV` (markdown renderer) to accept a `dim` prop
2. When `dim=true`, wraps rendered text strings in `chalk.dim.italic()`
3. Modifies `dvA` (thinking component) to pass `dim:!0` to QV

This approach wraps *text strings* with chalk styling before they become React elements, avoiding the "Box can't be inside Text" issue.

**Note:** Apply after the visibility patch. Both are independent but complementary.

### patch-spinner.js

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

### patch-ghostty-term.js

Adds truecolor (16M colors) support for Ghostty terminal.

**What it does:**
1. Finds the `xterm-kitty` truecolor detection check
2. Adds `xterm-ghostty` as an additional condition for truecolor support

**Why it's needed:**
Ghostty uses `TERM=xterm-ghostty` and supports truecolor, but Claude Code only recognizes `xterm-kitty` for truecolor detection. Without this patch, Ghostty only gets basic 16 colors because it matches `/^xterm/` but not `/-256(color)?$/`.

## Patch Metadata

The patching script tracks applied patches via a JSON comment embedded in the JS:

```javascript
/* __CLAUDE_PATCHES__ {"ccVersion":"2.1.17","appliedAt":"2026-01-23","patches":[...]} */
```

This works for both bare and native installs (the native binary contains plaintext JS). Run `--status` to see applied patches.

## Individual Patch Usage

Individual patch scripts require the cli.js path explicitly (no auto-discovery):

```bash
# Dry run - check if pattern matches
node patch-thinking-visibility.js --check /path/to/cli.js

# Apply patch
node patch-thinking-visibility.js /path/to/cli.js
```

**Note:** Individual patches are not idempotent - they search for original patterns which don't exist after patching. The metadata system in `claude-patching.js` handles this; for individual patches, restore from backup before re-applying.

## Backups and Recovery

### Before Patching

**The script creates `.bak` backups automatically.** For extra safety, keep a clean copy in this repo:

```bash
# Get the path from --status, then backup
node claude-patching.js --status

# For bare install:
cp /path/to/cli.js ./cli.js.original

# For native install:
cp ~/.local/share/claude/versions/X.Y.Z ./claude.original
```

### Restoring from Backup

If patches cause issues:

```bash
# For bare:
cp ./cli.js.original /path/to/cli.js

# For native:
cp ./claude.original ~/.local/share/claude/versions/X.Y.Z
chmod +x ~/.local/share/claude/versions/X.Y.Z
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

### After CC Updates

CC updates replace the installation entirely, removing patches and metadata. After updating:

```bash
# Check status (will show "Patches: (none)")
node claude-patching.js --status

# Test patches (patterns may have changed between versions)
node claude-patching.js --check

# Re-apply patches
node claude-patching.js --apply
```

If developing new patches, also update the local backup and prettified version:

```bash
# Get path from --status, then backup and prettify
cp /path/to/source ./cli.js.original
js-beautify -f cli.js.original -o cli.pretty.js
```

## Troubleshooting

See `TROUBLESHOOTING.md` for lessons learned about:
- Ink component hierarchy (Box vs Text)
- Chalk styling on strings vs components
- Pattern matching strategies
- Debugging techniques

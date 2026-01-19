# Claude Code Patches

Minimal patches for Claude Code's `cli.js`, supporting the version i'm currently using (as of this commit, `2.1.12`).

## Explainer

This is my little collection of 'adjustments', originally inspired by [tweakcc](https://github.com/Piebald-AI/tweakcc). However, their approach is a little heavy handed, so i went and made my own thing with just the things i want/need.  
Use at your own peril.

The patches themselves are installation-method-independent, but i prefer using `pnpm` for easy CC version management, so the descriptions are partial for that.

### Supported setup

Optional requirements:
- `js-beautify` for destructuring the minified js file to something that can be actually parsed and read.  
- `ast-grep` for parsing that prettified js

The `chunk-pretty.sh` utility exists to split the prettified file into chunks for use with `ast-grep` (otherwise the pretty js has close to half a million lines of code, and `ast-grep` chokes at 200k lines).

## Quick Start

```bash
# Check current patch status
node apply-patches.js --status

# Dry run - verify patterns match
node apply-patches.js --check

# Apply all patches
node apply-patches.js

# See all options
node apply-patches.js --help
```

The script auto-discovers the cli.js path from pnpm installations. For other package managers, provide the path manually:

```bash
node apply-patches.js /path/to/cli.js
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
1. Finds the `RxA()` function that returns platform-specific spinner characters
2. Replaces it with a simple function returning a custom character sequence

**Configuration:**
Edit `SPINNER_CHARS` at the top of the patch file:

```javascript
const SPINNER_CHARS = ["◐","◓","◑","◒"];  // rotating half-moon (default)
```

**Alternative sequences:**
- `["·","∴","·","∵"]` - therefore/because (matches "∴ Thinking" header)
- `["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]` - braille spinner
- `["○","◔","◑","◕","●","◕","◑","◔"]` - filling circle
- `["◢","◣","◤","◥"]` - rotating triangle
- `["✧","·","✦","·"]` - twinkling star

### patch-ghostty-term.js

Adds truecolor (16M colors) support for Ghostty terminal.

**What it does:**
1. Finds the `xterm-kitty` truecolor detection check
2. Adds `xterm-ghostty` as an additional condition for truecolor support

**Why it's needed:**
Ghostty uses `TERM=xterm-ghostty` and supports truecolor, but Claude Code only recognizes `xterm-kitty` for truecolor detection. Without this patch, Ghostty only gets basic 16 colors because it matches `/^xterm/` but not `/-256(color)?$/`.

## Patch Metadata

The `apply-patches.js` script tracks applied patches via a JSON comment at the start of cli.js:

```javascript
/* __CLAUDE_PATCHES__ {"ccVersion":"2.1.12","appliedAt":"2026-01-19","patches":[...]} */
```

This allows safe re-runs - already-applied patches are skipped automatically. Use `--force` to re-apply all patches, or `--stamp` to mark patches as applied without running them (useful for already-patched files).

## Individual Patch Usage

Individual patch scripts require the cli.js path explicitly (no auto-discovery):

```bash
# Dry run - check if pattern matches
node patch-thinking-visibility.js --check /path/to/cli.js

# Apply patch
node patch-thinking-visibility.js /path/to/cli.js
```

**Note:** Individual patches are not idempotent - they search for original patterns which don't exist after patching. The metadata system in `apply-patches.js` handles this; for individual patches, restore from backup before re-applying.

## Backups and Recovery

### Before Patching

**Always back up cli.js before patching.** CC updates overwrite patches, and bad patches can break CC entirely.

```bash
# Find cli.js location - read the wrapper script to get the path
cat ~/.local/share/pnpm/claude

# The path is in the exec line, e.g.:
# /home/USER/.local/share/pnpm/global/5/.pnpm/@anthropic-ai+claude-code@VERSION/.../cli.js

# Create a backup in this repo (do this once per CC version)
cp /path/to/cli.js ./cli.js.original

# Verify backup
ls -la cli.js.original
```

The `apply-patches.js` script creates a `.bak` file automatically, but keeping a clean `cli.js.original` in this repo is safer.

### Restoring from Backup

If patches cause issues:

```bash
# Use the same path from the wrapper script
cp ./cli.js.original /path/to/cli.js
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

CC updates replace cli.js entirely, removing both patches and metadata. After updating:

```bash
# Check status (will show "No patch metadata found")
node apply-patches.js --status

# Test patches (patterns may have changed between versions)
node apply-patches.js --check

# Re-apply patches
node apply-patches.js
```

If developing new patches, also update the local backup and prettified version:

```bash
# Get the cli.js path from --status output, then:
cp /path/to/cli.js ./cli.js.original
js-beautify -f cli.js.original -o cli.pretty.js
```

## Troubleshooting

See `TROUBLESHOOTING.md` for lessons learned about:
- Ink component hierarchy (Box vs Text)
- Chalk styling on strings vs components
- Pattern matching strategies
- Debugging techniques

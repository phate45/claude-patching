---
name: patch-setup
description: Prepare environment for Claude Code patching work. Run this when starting a patching session, after a CC upgrade, or when setting up the workspace. Triggers on mentions of patch setup, preparation, environment check, or CC version changes.
model: sonnet
context: fork
allowed-tools: Read, Bash, Glob, Grep
---

# Patch Setup

Prepare the claude-patching workspace for development. This skill runs as an isolated agent and reports status back to the main conversation.

## Overview

You are setting up the patching environment. Execute each step in order, checking state before acting. Report status precisely and exit early if blockers are found.

**Two installation types are supported:**
- **pnpm/npm install**: Standalone `cli.js` file
- **Native install**: Bun-compiled binary at `~/.local/bin/claude`

The skill auto-detects which type is installed and adjusts accordingly.

## Output Format

Begin your response with a status summary:

```
## Patch Environment Status

| Component | Status | Details |
|-----------|--------|---------|
| Install type | pnpm/native | path to cli.js or binary |
| CC version | X.Y.Z | extracted from path |
| Backup (cli.js.original) | ✓/✗/⚠ | version info |
| tweakcc reference | ✓/✗/⚠ | update status |
| Prettified (cli.pretty.js) | ✓/✗/⚠ | line count |
| AST chunks (cli.chunks/) | ✓/✗/⚠ | chunk count |
```

Then provide details for any issues found.

## Step 1: Detect Installation Type

Check for both installation types and determine which is active:

```bash
# Check for native install (Bun binary)
ls -la ~/.local/bin/claude 2>/dev/null && file $(readlink -f ~/.local/bin/claude) 2>/dev/null

# Check for pnpm install
node apply-patches.js --status 2>/dev/null || echo "pnpm install not found"
```

**Detection logic:**
1. If `~/.local/bin/claude` exists and points to an ELF executable → **Native install**
2. If `apply-patches.js --status` succeeds → **pnpm install**
3. Neither found → Report error and exit

**For native install:**
- Binary path: resolve symlink `~/.local/bin/claude` → e.g., `~/.local/share/claude/versions/X.Y.Z`
- Version: extract from path (last component)
- Set `INSTALL_TYPE=native`

**For pnpm install:**
- cli.js path: from apply-patches.js output
- Version: from path `@anthropic-ai+claude-code@X.Y.Z`
- Set `INSTALL_TYPE=pnpm`

**Store** these values for later steps:
- `INSTALL_TYPE` (native or pnpm)
- `SOURCE_PATH` (binary or cli.js path)
- `CC_VERSION`

## Step 2: Extract JS (Native Only)

**Skip this step if `INSTALL_TYPE=pnpm`.**

For native installs, extract the embedded JS from the Bun binary.

See the `bun-patching` skill for full technical details. Quick summary:

```bash
# Extract JS from binary (everything before the Bun trailer)
python3 << 'EOF'
import sys
binary_path = sys.argv[1] if len(sys.argv) > 1 else "/home/phate/.local/share/claude/versions/2.1.17"

with open(binary_path, 'rb') as f:
    data = f.read()

trailer = b'\n---- Bun! ----\n'
trailer_offset = data.rfind(trailer)

if trailer_offset == -1:
    print("ERROR: Bun trailer not found", file=sys.stderr)
    sys.exit(1)

js_content = data[:trailer_offset]
with open('cli.js.extracted', 'wb') as f:
    f.write(js_content)

print(f"Extracted {len(js_content):,} bytes to cli.js.extracted")
EOF
```

**Verify extraction:**
```bash
head -c 100 cli.js.extracted  # Should show JS code, not binary
```

**States:**
- Extraction succeeds → Continue (use `cli.js.extracted` as source for backup)
- Trailer not found → ⚠ "Not a Bun binary or corrupted"
- Other error → Report and exit

## Step 3: Check/Create Backup

Check if `cli.js.original` exists in the project directory.

**Source file depends on install type:**
- Native: `cli.js.extracted` (from Step 2)
- pnpm: the cli.js path from Step 1

```bash
ls -la cli.js.original 2>/dev/null
```

**States:**
- File exists, same size as source → ✓ "Backup current"
- File exists, different size → ⚠ "Backup exists but size differs (CC may have updated)"
  - Report both sizes, ask user if they want to update backup
- File doesn't exist → Create backup:
  ```bash
  # For native:
  cp cli.js.extracted ./cli.js.original

  # For pnpm:
  cp /path/to/cli.js ./cli.js.original
  ```

**Verify backup** after creation by comparing sizes.

## Step 4: Update tweakcc Reference

Check and update the tweakcc repository:

```bash
cd /tmp/tweakcc && git pull 2>&1
```

**States:**
- Directory doesn't exist → ⚠ "tweakcc not cloned. Clone with: git clone https://github.com/Piebald-AI/tweakcc /tmp/tweakcc"
- Already up to date → ✓ "tweakcc current"
- Updated with changes → ✓ "tweakcc updated (list changed files)"
- Git error → ⚠ Report error, suggest manual intervention

## Step 5: Generate Prettified Version

Check if `cli.pretty.js` exists and matches current backup:

```bash
ls -la cli.pretty.js 2>/dev/null
ls -la cli.js.original 2>/dev/null
```

**States:**
- Doesn't exist → Generate:
  ```bash
  js-beautify -f cli.js.original -o cli.pretty.js
  ```
- Exists but older than cli.js.original → Regenerate
- Exists and newer than cli.js.original → ✓ "Prettified version current"

**Verify** by checking line count:
```bash
wc -l cli.pretty.js
```

Expected: ~468K lines, ~17MB

**Error states:**
- Generation fails → STOP. Report error details

**Things to report:**
- js-beautify not installed → SKIP. Report "js-beautify missing: Install js-beautify: `npm install -g js-beautify`?"

## Step 6: Generate AST Chunks

Check if `cli.chunks/` exists and has correct chunk count:

```bash
ls cli.chunks/*.js 2>/dev/null | wc -l
```

**States:**
- Directory doesn't exist or empty → Generate:
  ```bash
  ./chunk-pretty.sh
  ```
- Has 5 chunks (for ~468K line file) → ✓ "AST chunks ready"
- Wrong chunk count → ⚠ "Chunk count mismatch, regenerating"

**Verify** chunks are usable:
```bash
ast-grep run --pattern 'function $N() { $$$B }' --lang js cli.chunks/ 2>&1 | head -5
```

If ast-grep returns matches, chunks are working.
If the tool is missing, simply `ls` the chunk folder `cli.chunks/` to verify file existence.

**Things to report:**
- ast-grep not installed → SKIP. Report "ast-grep missing"

## Early Exit Conditions

Stop immediately and report if:
1. Neither pnpm nor native install detected
2. Cannot determine source path (cli.js or binary)
3. Native binary extraction fails (trailer not found)
4. File system errors (permissions, disk space)

### Things to note

1. Required tools missing (`js-beautify`, `ast-grep`)
2. tweakcc repo not checked out at `/tmp/tweakcc`

Include these facts in the output for the user to decide what to do.

## Final Report

End with actionable summary based on install type:

**For pnpm install:**
```
## Ready for Patching (pnpm)

Environment is ready. You can now:
- Check status: `node apply-patches.js --status`
- Search code: `ast-grep run --pattern '...' --lang js cli.chunks/`
- Test patches: `node apply-patches.js --check`
- Apply patches: `node apply-patches.js`

CC version: X.Y.Z
Install type: pnpm
```

**For native install:**
```
## Ready for Patching (native)

Environment is ready. You can now:
- Check status: `node apply-patches-binary.js --status`
- Search code: `ast-grep run --pattern '...' --lang js cli.chunks/`
- Test patches: `node apply-patches-binary.js --check`
- Apply patches: `node apply-patches-binary.js`

CC version: X.Y.Z
Install type: native (Bun binary)
Binary path: ~/.local/share/claude/versions/X.Y.Z
```

Or if issues found:

```
## Action Required

The following issues need resolution before patching:
1. [Issue description and fix]
2. [Issue description and fix]
```

## Notes

- This skill is idempotent - safe to run multiple times
- Only performs work that's actually needed
- Reports version information for debugging
- Does NOT apply patches - that's a separate step


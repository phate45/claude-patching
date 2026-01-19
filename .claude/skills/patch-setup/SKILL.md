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

## Output Format

Begin your response with a status summary:

```
## Patch Environment Status

| Component | Status | Details |
|-----------|--------|---------|
| Patch status | ✓/✗/⚠ | patches applied, CC version |
| Backup (cli.js.original) | ✓/✗/⚠ | version info |
| tweakcc reference | ✓/✗/⚠ | update status |
| Prettified (cli.pretty.js) | ✓/✗/⚠ | line count |
| AST chunks (cli.chunks/) | ✓/✗/⚠ | chunk count |
```

Then provide details for any issues found.

## Step 1: Check Patch Status

Use the apply-patches script to check current status (it auto-discovers the cli.js path):

```bash
node apply-patches.js --status
```

This will show:
- The auto-discovered cli.js path
- CC version (extracted from path)
- Any existing patch metadata (patches already applied, date applied)

**Error states:**
- "Could not auto-discover cli.js path" → Report "Claude Code not installed via pnpm. Manual path required."
- Path shown but file doesn't exist → Report error details

**Extract** the cli.js path and CC version from the output for use in later steps.

## Step 2: Check/Create Backup

Check if `cli.js.original` exists in the project directory. Use the cli.js path from Step 1.

```bash
ls -la cli.js.original 2>/dev/null
ls -la /path/to/cli.js 2>/dev/null
```

**States:**
- File exists, same size as current cli.js → ✓ "Backup current"
- File exists, different size → ⚠ "Backup exists but size differs (CC may have updated)"
  - Report both sizes, ask user if they want to update backup
- File doesn't exist → Create backup using the path from Step 1:
  ```bash
  cp /path/to/cli.js ./cli.js.original
  ```

**Verify backup** after creation by comparing sizes.

## Step 3: Update tweakcc Reference

Check and update the tweakcc repository:

```bash
cd /tmp/tweakcc && git pull 2>&1
```

**States:**
- Directory doesn't exist → ⚠ "tweakcc not cloned. Clone with: git clone https://github.com/Piebald-AI/tweakcc /tmp/tweakcc"
- Already up to date → ✓ "tweakcc current"
- Updated with changes → ✓ "tweakcc updated (list changed files)"
- Git error → ⚠ Report error, suggest manual intervention

## Step 4: Generate Prettified Version

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

## Step 5: Generate AST Chunks

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
1. Claude Code not installed via pnpm
2. Cannot determine cli.js path
3. File system errors (permissions, disk space)

### Things to note

1. Required tools missing (`js-beautify`, `ast-grep`)
2. tweakcc repo not checked out at `/tmp/tweakcc`

Include these facts in the output for the user to decide what to do.

## Final Report

End with actionable summary:

```
## Ready for Patching

Environment is ready. You can now:
- Check status: `node apply-patches.js --status`
- Search code: `ast-grep run --pattern '...' --lang js cli.chunks/`
- Test patches: `node apply-patches.js --check`
- Apply patches: `node apply-patches.js`

CC version: X.Y.Z
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


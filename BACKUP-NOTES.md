# Backup System: Issues and Refactoring Notes

## Problem Summary

The workspace backup (`cli.js.bare.original`) can fall out of sync with the actual installed version. This session hit the issue: the workspace had a 2.1.34 backup while the live install was 2.1.41, causing regex patterns to match against the wrong build.

## How It Happens

1. User updates CC (e.g., `pnpm add -g @anthropic-ai/claude-code`) → fresh `cli.js` installed
2. User runs `--apply` before `--setup` → `--apply` creates a `.bak` at the install location (correct)
3. User runs `--setup` → detects `__CLAUDE_PATCHES__` in the live `cli.js` → skips overwriting `cli.js.bare.original`
4. Result: `.bak` is the real 2.1.41 original, workspace backup is stale from a previous version

## Current Backup Locations

| File | Created by | Location |
|------|-----------|----------|
| `cli.js.bak` | `--apply` | Next to the installed `cli.js` |
| `cli.js.bare.original` | `--setup` | Workspace (`claude-patching/`) |
| `cli.js.bare.pretty` | `--setup` | Workspace (js-beautify output) |

## Key Observations

- `--apply` always creates `.bak` before patching — this is the most reliable clean original
- `--setup` refuses to overwrite `cli.js.bare.original` when the source has `__CLAUDE_PATCHES__` marker — correct behavior to avoid backing up a patched file, but it should fall back to the `.bak`
- The `.bak` and the workspace original can be from entirely different builds even within the same CC version number (different minifier runs produce different variable names)
- Prettified files and chunk splits derived from a stale backup are useless for patch development against the current install

## Proposed Fix

When `--setup` detects the source `cli.js` is already patched:

1. Check for `.bak` at the install location
2. Verify the `.bak` is NOT patched (no `__CLAUDE_PATCHES__` marker)
3. If clean `.bak` exists: copy it to the workspace as `cli.js.bare.original`
4. Regenerate `cli.js.bare.pretty` from the updated backup
5. Log clearly what happened: "Source is patched, using .bak as backup source"

If neither source nor `.bak` is clean, warn the user that a reinstall is needed.

## Edge Cases to Handle

- `.bak` doesn't exist (user never ran `--apply`, only `--setup`)
- `.bak` is also patched (user ran `--apply` twice without restoring)
- `.bak` is from a different CC version than the live install (CC updated but `.bak` wasn't cleaned up)
- Version mismatch detection: compare a version fingerprint between `.bak` and live `cli.js` to catch stale `.bak` files

## Same Logic Applies to Native

The native install has the same two-backup structure:
- Binary-adjacent backup at the install location
- `cli.js.native.original` in the workspace

The `.bak` fallback logic should apply symmetrically.

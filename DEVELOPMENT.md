# Development

Guide for creating and maintaining patches.

## Tools

Optional requirements for developing new patches:
- `js-beautify` for prettifying the minified JS to something readable
- `ast-grep` for semantic code search in the prettified JS

The `chunk-pretty.sh` utility splits the prettified file into chunks for `ast-grep` (the pretty JS has ~500K lines, and `ast-grep` chokes at 200K).

## Version Porting Workflow

When CC updates:

```bash
# 1. Create index for new version
node claude-patching.js --init

# 2. Regenerate backups and prettified files
node claude-patching.js --setup

# 3. Check which patches still match
node claude-patching.js --check
```

For any failing patches:
1. Search the new `cli.js.{type}.pretty` to find what changed
2. Create an updated patch in `patches/<new-version>/` (or `bare/`/`native/` subdirs)
3. Update `index.json` to point to the new patch file
4. Re-run `--check` until everything passes

You can also test patches from a different version explicitly:

```bash
node claude-patching.js --native --check --patches-from 2.1.34
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

### Key Patterns in cli.js

The minified code uses consistent structures:

- **React components**: `X.createElement(ComponentVar, {props...})`
- **Case statements**: `case"typename":` for different message types
- **Module loader**: First few hundred chars define the bundler's module system

## Individual Patch Usage

Individual patch scripts require the `cli.js` path explicitly (no auto-discovery):

```bash
# Dry run - check if pattern matches
node patch-thinking-visibility.js --check /path/to/cli.js

# Apply patch
node patch-thinking-visibility.js /path/to/cli.js
```

**Note:** Individual patches are not idempotent — they search for original patterns which don't exist after patching. The metadata system in `claude-patching.js` handles this; for individual patches, restore from backup before re-applying.

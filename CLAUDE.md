# Claude Code Patching

Minimal patches for Claude Code without the full tweakcc toolchain.

## Applying Patches

Unified CLI supports both installation types:

```bash
node claude-patching.js --status              # Show detected installations
node claude-patching.js --setup               # Prepare environment (backups, prettify, tweakcc)
node claude-patching.js --check               # Dry run (auto-select if single install)
node claude-patching.js --apply               # Apply patches
node claude-patching.js --native --check      # Target native install explicitly
node claude-patching.js --bare --apply        # Target bare install explicitly
```

**Installation types:**
- `--bare` — pnpm/npm install (standalone cli.js)
- `--native` — Bun-compiled binary (~/.local/bin/claude)

If only one install exists, target flags are optional. If both exist, you must specify.

See `README.md` for individual patch descriptions. See `bun-patching` skill for binary format details.

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

**Version porting workflow:**
1. Create `patches/<new-version>/index.json`
2. Start by copying the previous version's index
3. Run `--check` to see which patches fail
4. For failing patches: search the new cli.js to find what changed, create updated patch in `patches/<new-version>/bare/` or `patches/<new-version>/`
5. Update index.json to point to the new patch file

## Reference: tweakcc

The [tweakcc](https://github.com/Piebald-AI/tweakcc) project is the authoritative reference for CC patching. A local clone lives at `/tmp/tweakcc`.
Run `node claude-patching.js --setup` to clone/update it automatically.

**Key resources in tweakcc:**
- `src/patches/` - Battle-tested patch patterns for many features
- `src/patches/index.ts` - Helper functions: `getReactVar()`, `findChalkVar()`, `findTextComponent()`, `findBoxComponent()`
- `src/patches/thinkingVisibility.ts` - Our visibility patch reference
- `data/prompts/` - Version-specific system prompt data
- `tools/promptExtractor.js` - Extracts prompts from cli.js

**Using tweakcc as reference:**
Liberally dispatch haiku explorers to pull information from `/tmp/tweakcc`. Examples:
- "Find how tweakcc locates the React variable"
- "What pattern does tweakcc use for theme customization?"
- "How does tweakcc handle version differences?"

## Development Workflow

Run `node claude-patching.js --setup` to prepare the environment. It:
- Detects installations and shows their patch status
- Updates tweakcc reference (`/tmp/tweakcc`)
- Creates backups (`cli.js.bare.original`, `cli.js.native.original`) - only if source is unpatched
- Generates prettified versions (`cli.js.bare.pretty`, `cli.js.native.pretty`)

**Note:** Setup won't overwrite a clean backup if the source is patched (detected via `__CLAUDE_PATCHES__` marker).

Claude Code's JS is a ~11MB minified/bundled file (~215MB in native binary). These tools make exploration easier.

### Tools

**Note:** These tooling commands are pre-approved for patching work - no need to ask before running them.

| Tool | Purpose | Example |
|------|---------|---------|
| **js-beautify** | Format minified JS for readability | `js-beautify -f cli.js -o cli.pretty.js` |
| **ast-grep** | Semantic code search (use on excerpts) | `ast-grep --lang js -p 'function $N() { $$$B }' file.js` |
| **jscodeshift** | AST queries (if ast-grep insufficient) | `pnpm dlx jscodeshift --parser=babel --dry --print ...` |
| **webcrack** | Bundle deobfuscation | `pnpm dlx webcrack cli.js > cracked.js` |
| **jq** | JSON data wrangling | For tool outputs, AST JSON, etc. |

**ast-grep limitation:** The parser fails silently after ~200K lines (tree-sitter limit). The workaround:

**Chunk the file**
```bash
./chunk-pretty.sh <--bare|--native> # Creates cli.chunks/ with 100K-line chunks, pick which source you are working on
```

### Working on patches

1. **Prepare the workspace**
   Run `node claude-patching.js --setup` to create backups and prettified files.

2. **Explore** - Find target code with `rg` and/or `ast-grep`:
   - Use `rg -oP '<query>' /path/to/minified.js` for targeted searching
   - Use `ast-grep run --pattern '<query>' --lang js cli.chunks/` for semantic search
   **Important:** Load the `ast-grep` skill before using the tool, the skill contains extra guidance and example queries

3. **Understand** - Read surrounding code in cli.pretty.js to grasp context

4. **Pattern** - Build regex against the ORIGINAL minified cli.js:
   - Match structure, not specific variable names
   - Use `[$\w]+` to match any identifier (includes `$`)
   - Use word boundaries (`\b`) for performance
   - Capture variable names dynamically from matches

5. **Test** - Always test with `--check` before applying

6. **Document** - Add to README.md with description and usage

### Key Patterns in cli.js

The minified code uses consistent structures:

- **React components**: `X.createElement(ComponentVar, {props...})`
- **Case statements**: `case"typename":` for different message types
- **Module loader**: First few hundred chars define the bundler's module system

### Notes

- Patches break on CC updates; reapply after updating
- The minifier is deterministic - same source = same variable names
- But variable names change between versions
- Patterns should match structure, not specific variable names

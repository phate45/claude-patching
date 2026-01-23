# Claude Code Patching

Minimal patches for Claude Code without the full tweakcc toolchain.

## Applying Patches

Two installation types are supported:

### pnpm/npm Install (cli.js)

```bash
node apply-patches.js           # Apply all patches
node apply-patches.js --check   # Dry run - verify patterns match
node apply-patches.js --status  # Show current patch status
```

Auto-discovers cli.js from pnpm installations. Patches tracked via metadata in cli.js.

### Native Install (Bun binary)

```bash
node apply-patches-binary.js           # Apply all patches
node apply-patches-binary.js --check   # Dry run - verify patterns match
node apply-patches-binary.js --status  # Show binary info
```

Auto-discovers from `~/.local/bin/claude` symlink. Extracts JS, patches, reassembles with updated size marker.

See `README.md` for individual patch descriptions. See `bun-patching` skill for binary format details.

## Reference: tweakcc

The [tweakcc](https://github.com/Piebald-AI/tweakcc) project is the authoritative reference for CC patching. A local clone lives at `/tmp/tweakcc`.

**Before starting any patching work:**
```bash
cd /tmp/tweakcc && git pull
```

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

Run `/patch-setup` to prepare the environment. It auto-detects install type and:
- For pnpm: copies cli.js → cli.js.original
- For native: extracts JS from binary → cli.js.extracted → cli.js.original
- Generates cli.pretty.js (prettified) and cli.chunks/ (for ast-grep)

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

**Tool notes:**
- `js-beautify` handles the 11MB cli.js well; `prettier` may OOM
- `ast-grep` works but struggles on 468K-line files; extract relevant sections first
- Keep `cli.pretty.js` around for exploration (17MB, ~468K lines)

**ast-grep limitation:** The parser fails silently after ~200K lines (tree-sitter limit). Two workarounds:

**Option A: Chunk the file** (preferred for broad searches)
```bash
./chunk-pretty.sh                              # Creates cli.chunks/ with 100K-line chunks
ast-grep run --pattern 'function $N() { $$$B }' --lang js cli.chunks/
```

**Option B: Extract sections** (for targeted searches)
```bash
grep -n 'targetString' cli.pretty.js           # Find location
sed -n '268000,270000p' cli.pretty.js > excerpt.js  # Extract section
ast-grep run --pattern 'function $N() { $$$B }' --lang js excerpt.js
```

### Creating a New Patch

1. **Prepare** - Format cli.js for readability (if not already done):
   ```bash
   js-beautify -f cli.js.original -o cli.pretty.js
   ```

2. **Explore** - Find target code with grep, then use ast-grep on excerpts:
   ```bash
   grep -n 'uniqueString' cli.pretty.js           # Find location
   sed -n '1000,2000p' cli.pretty.js > excerpt.js  # Extract section
   ast-grep --lang js -p 'function $N($$$P) { $$$B }' excerpt.js
   ```

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

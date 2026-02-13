# Troubleshooting Claude Code Patches

Lessons learned from patching CC 2.1.3. Future Claude instances: read this before diving into minified JS.

## Key Learnings

### 1. Ink Component Hierarchy Matters

**Error:** `<Box> can't be nested inside <Text> component`

Ink (the terminal UI library) has strict rules:
- `Text` (`$`) - for text content, supports `dimColor`, `bold`, `italic`, etc.
- `Box` (`T`) - for layout, supports `flexDirection`, `padding`, `border`, etc.

**You cannot wrap a Box in a Text component.** If a component renders Box elements internally (like the markdown renderer `QV`), you can't wrap its output in Text for styling.

**Solution:** Apply styling at the string level using chalk *before* the strings become React elements.

### 2. Chalk Styling on Strings, Not Components

The markdown renderer (`WE` function) returns chalk-styled strings like:
```js
W1.bold("some text")  // Returns ANSI-styled string
W1.dim.italic("text") // Chains work
```

These strings eventually get wrapped in `C8` (a Text component). To add styling:
- ✅ Wrap the string: `W1.dim(someString)` before it goes to createElement
- ❌ Wrap the component: `<Text dimColor><MarkdownRenderer/></Text>` - fails if MarkdownRenderer uses Box

### 3. Pattern Matching Strategy

The minified code uses short variable names (`A`, `Q`, `$`, `T`, `W1`, etc.). Patterns must:

1. **Use `[$\w]+` not `\w+`** - Dollar signs are valid in JS identifiers
2. **Start with word boundaries** - `\b` or specific chars like `,;{` for performance
3. **Capture variable names** - Extract them from matches, don't hardcode
4. **Match structure, not names** - Names change between versions

**Good pattern:**
```js
/([$\w]+\.default\.createElement)\(QV,null,([$\w]+)\)/
```

**Bad pattern:**
```js
/s4A\.default\.createElement\(QV,null,A\)/  // Hardcoded names will break
```

### 4. Finding Components in Minified Code

| Component | How to Find |
|-----------|-------------|
| React | `getReactVar()` - look for module loader pattern |
| Text (`$`) | `function X({color:...,backgroundColor:...,dimColor:...` |
| Box (`T`) | `X.displayName="Box"` |
| Chalk (`W1`) | Look for `.dim.italic(` or color method chains |
| Specific components | Search for unique strings they render |

### 5. The QV Markdown Renderer

`QV` is the markdown renderer component:
```js
function QV({children:A}){
  // Parses markdown with n7.lexer()
  // Renders tokens with WE() function
  // WE returns chalk-styled strings
  // Strings wrapped in C8 (Text) components
  // Returns Box with flexDirection:"column"
}
```

To style QV output:
1. Add a prop to QV (e.g., `dim`)
2. Modify the internal `X()` function that creates C8 elements
3. Wrap strings with chalk before createElement

### 6. The dvA Thinking Component

```js
function dvA({param:{thinking:A}, addMargin:Q, isTranscriptMode:B, verbose:G, ...}){
  // If not transcript mode and not verbose, returns collapsed view
  // Otherwise returns expanded view with QV(null, A)
}
```

Key patterns:
- `"∴ Thinking…"` - unique string to locate the component
- `isTranscriptMode` - controls visibility
- `createElement(QV,null,A)` - where thinking content is rendered

## Common Errors and Fixes

### "Could not find pattern X"

The minified code structure changed. Steps:
1. Search for unique strings near the target (e.g., `"∴ Thinking"`)
2. Extract surrounding code context
3. Update regex to match new structure
4. Test with `--check` before applying

### Patch applies but CC crashes

Likely a syntax error or invalid component nesting. Check:
1. Bracket matching in replacement strings
2. Component hierarchy (no Box in Text)
3. Variable scoping (is the variable accessible?)

### Styling doesn't appear

Chalk styling might be overridden by:
1. Other chalk calls wrapping the same text
2. Ink component props (`dimColor` on Text)
3. Theme colors overriding defaults

### 7. Recovering a Pristine cli.js from npm

If both the installed `cli.js` and `.bak` are tainted (patched without metadata, stale from a previous version, etc.), download the original package directly from the npm registry:

```bash
# Download the exact version as a tarball
npm pack @anthropic-ai/claude-code@2.1.41 --pack-destination /tmp

# Extract the pristine cli.js
mkdir -p /tmp/cc-pristine
tar xzf /tmp/anthropic-ai-claude-code-2.1.41.tgz -C /tmp/cc-pristine

# Compare against your backup to check for contamination
node -e '
const fs = require("fs");
const pristine = fs.readFileSync("/tmp/cc-pristine/package/cli.js", "utf8");
const backup = fs.readFileSync("/path/to/cli.js.bak", "utf8");
console.log("Match:", pristine === backup);
'

# Restore both backup and live file from pristine source
cp /tmp/cc-pristine/package/cli.js /path/to/cli.js.bak
cp /tmp/cc-pristine/package/cli.js /path/to/cli.js
```

This bypasses any local state entirely. Useful when `--check` reports all patterns failing on a version that should work — the file under test may already be patched.

## Debugging Techniques

### 1. Extract and Format Code Sections

```bash
# Find code around a unique string
grep -oP '.{200}∴ Thinking.{200}' cli.js

# Get more context
grep -oP '.{500}function dvA.{1000}' cli.js
```

### 2. Test Patterns Incrementally

```js
// Start broad
const match = content.match(/function QV/);

// Then narrow down
const match = content.match(/function QV\(\{children/);

// Then capture
const match = content.match(/function QV\(\{children:([$\w]+)\}/);
```

### 3. Verify Patches

```bash
# Count occurrences of patch markers
grep -c 'isTranscriptMode:true' cli.js
grep -c 'dim:_dimStyle' cli.js
```

### 4. Use tweakcc as Reference

The `/tmp/tweakcc/src/patches/` directory has battle-tested patterns:
- `thinkingVisibility.ts` - visibility patch patterns
- `userMessageDisplay.ts` - complex styling example
- `index.ts` - helper functions for finding components

## Version Compatibility

Patches are version-specific. When CC updates:

1. **Check if patterns still match** - Run patches with `--check`
2. **Compare with tweakcc** - They track CC versions in `data/prompts/`
3. **Look for structural changes** - Same feature, different code structure
4. **Update regex patterns** - Variable names will change, structure might too

## Quick Reference: Variable Names (CC 2.1.3)

These WILL change in other versions - always extract dynamically:

| Purpose | Variable | How Found |
|---------|----------|-----------|
| React | `lZ1`, `s4A`, `J5` | Module loader pattern |
| Text component | `$` | Function signature with color props |
| Box component | `T` | displayName="Box" |
| Chalk | `W1` | `.dim.italic(` pattern |
| Markdown renderer | `QV` | Unique, search by name |
| Thinking component | `dvA` | `"∴ Thinking"` string |

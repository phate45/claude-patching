# Exploring cli.js

Claude Code's JS is a ~11MB minified bundle (~215MB in the native binary).

## Workspace Files

After `--setup`:
- `cli.js.bare.original` / `cli.js.native.original` — unpatched backups
- `cli.js.bare.pretty` / `cli.js.native.pretty` — js-beautify formatted (~500K lines)

## Search Tools

These are pre-approved for patching work — no need to ask before running.

| Tool | Use for | Example |
|------|---------|---------|
| `rg` | Targeted pattern search in minified JS | `rg -oP 'VERSION:"[^"]*"' cli.js.bare.original` |
| `ast-grep` | Semantic search (use on chunks, not full file) | `ast-grep run --pattern '$F($$$)' --lang js cli.chunks/` |
| `js-beautify` | Format minified JS for reading | `js-beautify -f cli.js -o cli.pretty.js` |
| `jq` | JSON wrangling | Tool outputs, AST JSON |

**ast-grep limitation**: Tree-sitter fails silently after ~200K lines. Use chunks:
```bash
./chunk-pretty.sh <--bare|--native>  # Creates cli.chunks/ with 100K-line pieces
```

Load the `ast-grep` skill before using it — the skill has extra guidance and example queries.

## Key Patterns in cli.js

The minified code uses consistent structures:
- **React components**: `X.createElement(ComponentVar, {props...})`
- **Case statements**: `case"typename":` for message types
- **Module loader**: First few hundred chars define the bundler system
- **Version string**: `VERSION:"X.Y.Z"` (use `extractVersion()` from shared.js)

## Building Regex Patterns

- Match structure, not variable names
- `[$\w]+` matches any JS identifier (includes `$`)
- `\b` word boundaries for performance
- The minifier is deterministic (same source = same names) but names change between versions
- Capture variable names dynamically from matches for replacements

## TUI Rendering Architecture

Each tool has separate render functions as properties on the tool definition object:
- `userFacingName()` — tool label ("Read", "Edit", etc.)
- `getToolUseSummary()` — summary string
- `renderToolUseMessage(props, { verbose })` — React component for the tool-use display
- `renderToolResultMessage()` — collapsed result display
- `renderToolUseProgressMessage()` — spinner/progress
- `getActivityDescription()` — status text

`getToolUseSummary` and `renderToolUseMessage` are **independent paths**.
The parenthetical display the user sees comes from `renderToolUseMessage`, not `getToolUseSummary`.

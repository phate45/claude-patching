# Reference Repositories

## tweakcc (`/tmp/tweakcc`)

Cloned/updated by `node claude-patching.js --setup`.

The [tweakcc](https://github.com/Piebald-AI/tweakcc) project — authoritative CC patching reference.

**Key resources:**
- `src/patches/` — Battle-tested patch patterns
- `src/patches/index.ts` — Helpers: `getReactVar()`, `findChalkVar()`, `findTextComponent()`, `findBoxComponent()`
- `src/patches/thinkingVisibility.ts` — Our visibility patch reference
- `data/prompts/` — Version-specific system prompt data
- `tools/promptExtractor.js` — Extracts prompts from cli.js

Dispatch haiku explorers to pull information from `/tmp/tweakcc` when needed.

## Prompt patches

Prompt patches are now self-contained in `patches/<version>/prompt-patches/`. No external repo.

**Regex engine** (`createRegexPatch()` in `patches/2.1.59/patch-prompt-slim.js`):
- `${varName}` placeholders match template literal vars (`${n3}`, `${T3}`) — auto-adapts across versions
- `__NAME__` placeholders match plain identifiers (`kY7`, `aDA`)
- Placeholders become regex capture groups with backreferences in replacements
- Handles native unicode escapes (em-dash, arrows, smart quotes → `\\uXXXX`)
- Ternaries inside `${...}` (e.g. `${flag()?'on':''}`) do NOT tokenize as a `${var}` placeholder — the brace content allows only `[a-zA-Z0-9_.$]+` plus an optional `()` call. The surrounding `${...?...:...}` framing must appear literally, but the bare function-name token inside the ternary can still be made resilient by substituting an `__NAME__` placeholder (e.g. `${__FLAG__()?'on':''}`) — the identifier capture group `[a-zA-Z0-9_$]+` will track minifier renames across versions.

**Backtick escaping inside JS source.** When a target prompt string sits inside a template literal (delimited by `` ` ``), inner backticks at the source level are escaped as `\``. Inside `${...}` interpolations the context flips back to JS expression mode — backticks inside `"..."` or `'...'` strings within that interpolation stay plain. This matters because `.find.txt` content is matched byte-for-byte against the extracted JS:
- Template-literal bullets like ``- \`old_string\` must…`` → write `\`` in find.txt
- Ternary content like `${$?"… `:` …":"…"}` → write plain backticks
The divergence diagnostic surfaces this immediately — `bundle:` line will show `\`name\`` while `patch:` shows `` `name` ``.

**Baseline tool** (`lib/prompt-baseline.js`):
- Generates concatenated baselines in `patches/<version>/`
- Produces stats (per-patch savings) and version-to-version diffs
- Called automatically by `--init` for new versions

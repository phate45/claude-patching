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

**Baseline tool** (`lib/prompt-baseline.js`):
- Generates concatenated baselines in `patches/<version>/`
- Produces stats (per-patch savings) and version-to-version diffs
- Called automatically by `--init` for new versions

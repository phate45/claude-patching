# Reference Repositories

Both repos are cloned/updated by `node claude-patching.js --setup`.

## tweakcc (`/tmp/tweakcc`)

The [tweakcc](https://github.com/Piebald-AI/tweakcc) project — authoritative CC patching reference.

**Key resources:**
- `src/patches/` — Battle-tested patch patterns
- `src/patches/index.ts` — Helpers: `getReactVar()`, `findChalkVar()`, `findTextComponent()`, `findBoxComponent()`
- `src/patches/thinkingVisibility.ts` — Our visibility patch reference
- `data/prompts/` — Version-specific system prompt data
- `tools/promptExtractor.js` — Extracts prompts from cli.js

Dispatch haiku explorers to pull information from `/tmp/tweakcc` when needed.

## prompt-patching (`/tmp/prompt-patching`)

Repo: `https://github.com/ykdojo/claude-code-tips.git`

System prompt optimization toolkit using find/replace text pairs.

**Structure per version** (`system-prompt/<version>/`):
- `patch-cli.js` — Monolith patcher (hash validation, regex engine, patch list, application loop)
- `patches/<name>.find.txt` + `<name>.replace.txt` — Text pairs for each optimization

**Regex engine** (`createRegexPatch()`):
- `${varName}` placeholders match template literal vars (`${n3}`, `${T3}`) — auto-adapts across versions
- `__NAME__` placeholders match plain identifiers (`kY7`, `aDA`)
- Placeholders become regex capture groups with backreferences in replacements
- Also handles native unicode escapes (em-dash, arrows, smart quotes → `\\uXXXX`)

**Integration**: Our `patch-prompt-slim.js` copies their regex engine, reads their patch files,
applies them via our orchestrator. `hashPatchLogic()` detects upstream engine changes.

**Baseline tool** (`lib/prompt-baseline.js`):
- Generates concatenated baselines in `patches/<version>/`
- Produces stats (per-patch savings) and version-to-version diffs
- Logic hash tracks upstream `patch-cli.js` changes (strips config, hashes engine code)
- Called automatically by `--init` for new versions

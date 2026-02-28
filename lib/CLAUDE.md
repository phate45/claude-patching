# lib/ — Core Modules

These modules support the main `claude-patching.js` orchestrator. Individual patches in `patches/` import from `lib/output.js` and `lib/shared.js`; the orchestrator uses all five.

## Module Map

| Module | Purpose | Used by |
|--------|---------|---------|
| `shared.js` | Detection, metadata, version extraction | Everything |
| `output.js` | Structured output (JSON/human dual-mode) | Patch scripts |
| `setup.js` | `--setup` command: backups, prettify, repo cloning | Orchestrator |
| `bun-binary.ts` | Native binary extraction and repacking (LIEF + Bun overlay) | Orchestrator |
| `prompt-baseline.js` | Prompt patch import, baseline generation, upstream comparison | Orchestrator (`--init`, `--port`) |

## Key Conventions

- **Dual-mode output**: When `CLAUDECODE=1` (set automatically inside CC's Bash tool), output is structured JSONL. Otherwise human-readable. `output.js` handles this for patch scripts; the orchestrator has its own `log()`/`emitJson()` pair.
- **Lazy loading**: `bun-binary.ts` is loaded lazily because it requires `node-lief`, which isn't needed for bare-only workflows.
- **TypeScript in Node**: `bun-binary.ts` uses TypeScript syntax but runs under Node 25's `--experimental-strip-types` (or Bun natively). No build step.
- **`SetupStatus` class** (setup.js): Returned by `runSetup()`, carries `.toJSON()` and `.toReport()` methods. The orchestrator formats output from the raw object — `runSetup()` itself only logs progress messages (suppressed with `{ quiet: true }`).

## Detailed API

See `.claude/rules/lib-api.md` for function signatures, parameter types, and common mistakes.

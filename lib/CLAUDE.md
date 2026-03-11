# lib/ — Core Modules

These modules support the main `claude-patching.js` orchestrator. Individual patches in `patches/` import from `lib/output.js` and `lib/shared.js`; the orchestrator dispatches to the command modules.

## Module Map

| Module | Purpose | Used by |
|--------|---------|---------|
| `shared.js` | Constants, detection, metadata, version utilities, backup discovery | Everything |
| `output.js` | Structured output (JSON/human dual-mode) — semantic helpers + raw primitives | Patch scripts, all lib modules |
| `patch-runner.js` | Patch index loading, execution engine, `applyPatches` | Orchestrator, `port.js` |
| `init.js` | `--init` command: create index for new CC version, import prompt patches | Orchestrator, `port.js` |
| `port.js` | `--port` pipeline: setup + init + check with condensed formatters | Orchestrator |
| `status.js` | `--status` command: display installations and workspace artifacts | Orchestrator |
| `setup.js` | `--setup` command: backups, prettify, repo cloning | Orchestrator, `port.js` |
| `bun-binary.ts` | Native binary extraction and repacking (LIEF + Bun overlay) | `patch-runner.js` (lazy-loaded) |
| `prompt-baseline.js` | Prompt patch import, baseline generation, upstream comparison | `init.js` |

## Dependency Graph

```
orchestrator
├── shared.js
├── output.js
├── patch-runner.js ──→ shared, output, bun-binary.ts (lazy)
├── init.js ──→ shared, output, prompt-baseline.js
├── port.js ──→ shared, output, patch-runner, init, setup
├── status.js ──→ shared, output, patch-runner
└── setup.js
```

## Key Conventions

- **Dual-mode output**: When `CLAUDECODE=1` (set automatically inside CC's Bash tool), output is structured JSONL. Otherwise human-readable. `output.js` exports both semantic helpers (`section`, `discovery`, `result`) for patch scripts and raw primitives (`log`, `logError`, `emitJson`) for command modules.
- **Lazy loading**: `bun-binary.ts` is loaded lazily by `patch-runner.js` because it requires `node-lief`, which isn't needed for bare-only workflows.
- **TypeScript in Node**: `bun-binary.ts` uses TypeScript syntax but runs under Node 25's `--experimental-strip-types` (or Bun natively). No build step.
- **`SetupStatus` class** (setup.js): Returned by `runSetup()`, carries `.toJSON()` and `.toReport()` methods. The orchestrator and `port.js` format output from the raw object — `runSetup()` itself only logs progress messages (suppressed with `{ quiet: true }`).

## Detailed API

See `.claude/rules/lib-api.md` for function signatures, parameter types, and common mistakes.

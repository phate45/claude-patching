---
paths:
  - "patches/**"
---

# Patch Module Format

## Invocation Contract

Every patch is a standalone Node.js script invoked by the orchestrator:

```bash
node patches/<version>/patch-name.js <cli.js path>          # apply
node patches/<version>/patch-name.js --check <cli.js path>  # dry run
```

The orchestrator calls via `execSync('node "<patchPath>" <args>')`.

**Patch responsibilities:**
1. Parse args: `const dryRun = args[0] === '--check'; const targetPath = dryRun ? args[1] : args[0];`
2. Read the target file
3. Find patterns and apply replacements
4. Write the modified file (skip if dry run)
5. Use `lib/output.js` for all output (supports JSON mode)
6. Exit 0 on success, exit 1 on failure

**Orchestrator detection of failures:**
- Exit code non-zero = failure
- Stderr containing "Could not find", "already patched", "pattern not found" = treated as "not found" (soft failure)

## index.json Format

Each `patches/<version>/index.json` maps patch IDs to files:

```json
{
  "version": "2.1.42",
  "patches": {
    "common": [{ "id": "patch-name", "file": "2.1.42/patch-name.js" }],
    "bare": [{ "id": "bare-only", "file": "2.1.31/bare/patch-bare-only.js" }],
    "native": [{ "id": "native-only", "file": "2.1.19/patch-native-only.js" }]
  }
}
```

- **common**: Applied to both install types
- **bare**: pnpm/npm installs only
- **native**: Bun binary installs only
- **file**: Path relative to `patches/` — can reference older versions if the patch still works

## Version Porting

When a new CC version drops:

1. `node claude-patching.js --init` — copies latest index.json with new version
2. `node claude-patching.js --check` — shows which patches fail
3. For failures: search the new cli.js, create updated patch in `patches/<new-version>/`
4. Update index.json file paths for fixed patches

## Patch Development Rules

- Match structure, not specific variable names (`[$\w]+` for any identifier)
- Use word boundaries (`\b`) for regex performance
- Always test with `--check` before `--apply`
- Run `node --check <file>.js` after writing a patch to catch syntax errors
- Never inject inside comma-separated `let` declarations — match through the `;`
- The comma operator in `return` works for side effects: `return expr1,(expr2),expr3`
- Prefer removing conditions over injecting code (cheaper, safer for native size budget)
- Verify the display path before patching: trace from UI back to the function

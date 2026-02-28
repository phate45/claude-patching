# Plan: Add `--port` Command

## Context

Every CC version bump follows the same manual sequence: `--status` → `--setup` → `--init` → `--check`, four commands with four round-trips where one would do. The `--port` command composes these existing operations into a single pipeline with condensed output, so the porting session starts with one command and one actionable report.

Mark's workflow: native binary updates first, bare (still patched) drives the fixing session. The `--port` target is always the freshly-updated install.

**Note:** The syntax-check injection from earlier today (lines 464–491 of `claude-patching.js`) is already committed. This plan builds on that.

## Files to Modify

| File | Changes |
|------|---------|
| `claude-patching.js` | Extract `doInit()`, add `quiet` option to `applyPatches()`, add `runPort()` + formatters, update CLI parsing + help |
| `lib/setup.js` | Return `SetupStatus` object instead of formatted string, add `quiet` option |
| `CLAUDE.md` | Add "Porting to a New CC Version" workflow, rewrite existing CLI docs |

---

## Phase 1: Refactor `runSetup()` (lib/setup.js)

### What to change

`runSetup()` currently returns a formatted string. Change it to return the raw `SetupStatus` object. Add `quiet` option.

### Exact edits

**File: `lib/setup.js`**

1. Update JSDoc and add quiet option (line 567–575):

```js
// OLD (lines 567-575):
/**
 * Run the full setup process
 * @param {object} options - Options
 * @param {boolean} options.json - Force JSON output (auto-detected from CLAUDECODE env var)
 * @returns {string} Status report (markdown or JSON string)
 */
function runSetup(options = {}) {
  const jsonMode = options.json ?? process.env.CLAUDECODE === '1';
  const log = jsonMode ? () => {} : console.log.bind(console);

// NEW:
/**
 * Run the full setup process
 * @param {object} options - Options
 * @param {boolean} options.json - Force JSON output (auto-detected from CLAUDECODE env var)
 * @param {boolean} options.quiet - Suppress progress output
 * @returns {SetupStatus} Status object with .toJSON() and .toReport() methods
 */
function runSetup(options = {}) {
  const jsonMode = options.json ?? process.env.CLAUDECODE === '1';
  const quiet = options.quiet ?? false;
  const log = (jsonMode || quiet) ? () => {} : console.log.bind(console);
```

2. Change return value (line 611):

```js
// OLD (line 611):
  return jsonMode ? JSON.stringify(status.toJSON(), null, 2) : status.toReport();

// NEW:
  return status;
```

3. Also change the early return (line 585):

```js
// OLD (line 585):
    return jsonMode ? JSON.stringify(status.toJSON(), null, 2) : status.toReport();

// NEW:
    return status;
```

4. Export SetupStatus (line 614):

```js
// OLD:
module.exports = { runSetup };

// NEW:
module.exports = { runSetup, SetupStatus };
```

**File: `claude-patching.js`** — Update the `--setup` handler (lines 791–796):

```js
// OLD (lines 791-796):
if (wantSetup) {
  const { runSetup } = require('./lib/setup');
  const report = runSetup();
  console.log(report);
  process.exit(0);
}

// NEW:
if (wantSetup) {
  const { runSetup } = require('./lib/setup');
  const status = runSetup();
  console.log(jsonMode ? JSON.stringify(status.toJSON(), null, 2) : status.toReport());
  process.exit(status.errors.length === 0 ? 0 : 1);
}
```

### Verification
- `node --check lib/setup.js`
- `node --check claude-patching.js`
- `node claude-patching.js --setup` — should produce same table output as before

---

## Phase 2: Extract `doInit()` (claude-patching.js)

### What to change

Extract the inline `--init` code (lines 800–923) into a `doInit(installs, options)` function. Place it right after `applyPatches()` (after line 524), before the `// ============ CLI ============` section.

### Function signature and return type

```js
/**
 * Initialize patches for a new CC version.
 * @param {{ bare: object|null, native: object|null }} installs
 * @param {{ quiet?: boolean, skipExisting?: boolean }} options
 * @returns {{
 *   success: boolean,
 *   version?: string,
 *   copiedFrom?: string,
 *   alreadyExists?: boolean,
 *   promptImport?: { count: number, source: string, targetDir: string },
 *   upstream?: { upstreamVersion: string, onlyUpstream: string[], changed: Array<{file: string}>, reportPath: string },
 *   baseline?: { patchCount: number, charsSaved: number },
 *   error?: string
 * }}
 */
function doInit(installs, options = {}) {
```

### Transformation rules

The current inline code uses these constructs that must change:

| Old pattern | New pattern |
|-------------|-------------|
| `console.error('Error: ...')` then `process.exit(1)` | `return { success: false, error: '...' }` |
| `logError('...')` then `process.exit(1)` | `return { success: false, error: '...' }` |
| `log('...')` | `if (!options.quiet) log('...')` |
| `emitJson(...)` at the end | Remove (caller handles JSON emission) |
| `process.exit(0)` at the end | `return { success: true, version, copiedFrom, promptImport, upstream, baseline }` |

**Special case — `skipExisting`:** When `options.skipExisting` is true and `index.json` already exists (line 825), instead of erroring, return:
```js
return { success: true, alreadyExists: true, version: targetVersion };
```

### Collecting structured return data

The inline code already has local variables for all the data we need:

- `targetVersion` — from version detection (line 812)
- `sourceVersion` — the version we copied from (line 837)
- `importResult` — from `importPromptPatches(targetVersion)` (line 860), has `{ count, source, targetDir }`
- `baseline` — from `generateBaseline(targetVersion)` (line 871), has `{ patches, totalFindChars, totalReplaceChars }`
- `comparison` — from `compareWithUpstream(targetVersion)` (line 875), has `{ upstreamVersion, shared, onlyLocal, onlyUpstream, changed }`

Build the return object from these:
```js
const result = { success: true, version: targetVersion, copiedFrom: sourceVersion };
if (importResult) result.promptImport = importResult;
if (baseline) result.baseline = { patchCount: baseline.patches.length, charsSaved: baseline.totalFindChars - baseline.totalReplaceChars };
if (comparison) {
  result.upstream = {
    upstreamVersion: comparison.upstreamVersion,
    onlyUpstream: comparison.onlyUpstream,
    changed: comparison.changed,
    reportPath,
  };
}
return result;
```

### Update the `--init` handler

```js
// NEW --init handler (replaces lines 800-923):
if (wantInit) {
  const result = doInit(installs);
  if (!result.success) {
    logError(result.error);
    process.exit(1);
  }
  if (result.alreadyExists) {
    logError(`patches/${result.version}/index.json already exists`);
    process.exit(1);
  }
  log(`\nNext steps:`);
  log(`  node claude-patching.js --check    # verify patches still match`);
  emitJson({ type: 'result', status: 'success', version: result.version, copiedFrom: result.copiedFrom });
  process.exit(0);
}
```

Note: When called from `--init` directly, `skipExisting` is false (default), so it still errors. Only `--port` sets `skipExisting: true`.

### Important: `doInit` depends on module-level helpers

These are already defined at module scope and need no changes: `compareVersions`, `listAvailableVersions`, `PATCHES_DIR`, `log`, `logError`, `emitJson`. The `require('./lib/prompt-baseline')` is done lazily inside the function body (already the case in inline code at line 854).

### Verification
- `node --check claude-patching.js`
- `node claude-patching.js --init` — should say "already exists" for 2.1.63 (same behavior as before)

---

## Phase 3: Structured return from `applyPatches()` (claude-patching.js)

### What to change

Add `options` parameter (4th arg). Change return from `boolean` to structured object. Gate verbose output on `!options.quiet`.

### New signature

```js
function applyPatches(install, dryRun, patchVersionOverride, options = {}) {
```

### Add result collectors (after line 379)

```js
const resultCollector = { passed: [], failed: [], skipped: [] };
```

### Gate output on quiet

Define a local helper at the top of the function:
```js
const quiet = options.quiet ?? false;
const qlog = quiet ? () => {} : log;
const qemit = quiet ? () => {} : emitJson;
```

Then replace `log(` with `qlog(` and `emitJson(` with `qemit(` throughout the function body. **Exception:** keep `logError()` calls ungated — errors should always be visible.

### Populate collectors in the patch loop

In the success branch (line 398):
```js
resultCollector.passed.push({ id: patch.id, output: result.output });
```

In the notFound branch (line 410):
```js
resultCollector.failed.push({ id: patch.id, reason: 'pattern not found', output: result.output || '' });
```

In the failure branch (line 418):
```js
resultCollector.failed.push({ id: patch.id, reason: result.output || result.error, output: result.output || '' });
```

In the already-applied skip (line 383):
```js
resultCollector.skipped.push({ id: patch.id, reason: 'already_applied' });
```

### Convert all 7 return paths

Build a helper to construct the return object:
```js
function makeResult(success, extra = {}) {
  return { success, ...resultCollector, total: patches?.length ?? 0, version: install.version, patchVersion, ...extra };
}
```

Actually, simpler to just inline it at each return. Here are the 7 paths:

**Line 317** (no patch index):
```js
// OLD: return false;
// NEW:
return { success: false, passed: [], failed: [], skipped: [], total: 0, version: install.version, patchVersion, error: `No patches for ${patchVersion}` };
```

**Line 335** (extraction failed):
```js
// OLD: return false;
// NEW:
return { success: false, passed: [], failed: [], skipped: [], total: 0, version: install.version, patchVersion, error: `Extraction failed` };
```

**Line 437** (dry run complete):
```js
// OLD: return failCount === 0;
// NEW:
return { success: failCount === 0, ...resultCollector, total: patches.length, version: install.version, patchVersion };
```

**Line 443** (no patches applied):
```js
// OLD: return notFoundCount === patches.length;
// NEW:
return { success: notFoundCount === patches.length, ...resultCollector, total: patches.length, version: install.version, patchVersion };
```

**Line 489** (syntax check failed):
```js
// OLD: return false;
// NEW:
return { success: false, ...resultCollector, total: patches.length, version: install.version, patchVersion, error: 'Syntax check failed' };
```

**Line 511** (reassembly failed):
```js
// OLD: return false;
// NEW:
return { success: false, ...resultCollector, total: patches.length, version: install.version, patchVersion, error: 'Reassembly failed' };
```

**Line 523** (success):
```js
// OLD: return true;
// NEW:
return { success: true, ...resultCollector, total: patches.length, version: install.version, patchVersion };
```

### Update the caller (line 1068–1069)

```js
// OLD:
const success = applyPatches(target, dryRun, effectivePatchVersion);
process.exit(success ? 0 : 1);

// NEW:
const result = applyPatches(target, dryRun, effectivePatchVersion);
process.exit(result.success ? 0 : 1);
```

### Verification
- `node --check claude-patching.js`
- `node claude-patching.js --native --check` — verify exit code 0 (all patches pass for 2.1.63)
- Output should be identical to before (quiet defaults to false)

---

## Phase 4: Implement `--port` command

### Add CLI flag parsing

In the flag parsing block (around line 740), add:
```js
const wantPort = args.includes('--port');
```

Update actionCount (line 765):
```js
const actionCount = [wantStatus, wantSetup, wantInit, wantCheck, wantApply, wantRestore, wantPort].filter(Boolean).length;
```

### Add `runPort()` function

Place it after `doInit()`, before `// ============ CLI ============`. It composes setup → init → check:

```js
/**
 * Full porting pipeline: setup + init + check
 * @param {{ bare: object|null, native: object|null }} installs - Detected installations
 * @param {object} target - The target installation to check against
 * @returns {{ success: boolean, setup: object, init: object, check: object }}
 */
function runPort(installs, target) {
  const latestPatched = listAvailableVersions().pop() || '(none)';
  const toVersion = target.version;

  log(`Port: ${latestPatched} → ${toVersion} (${target.type})\n`);
  emitJson({ type: 'port_start', from: latestPatched, to: toVersion, target: target.type });

  // Phase 1: Setup (quiet — we format our own summary)
  const { runSetup } = require('./lib/setup');
  const setupStatus = runSetup({ quiet: true });
  formatSetupCondensed(setupStatus, target.type);
  emitJson({ type: 'port_setup', ...setupStatus.toJSON() });

  if (setupStatus.errors.length > 0) {
    log(`\nSetup failed. Fix errors before porting.`);
    return { success: false, setup: setupStatus, init: null, check: null };
  }

  // Phase 2: Init (quiet, skip if already exists)
  const initResult = doInit(installs, { quiet: true, skipExisting: true });
  formatInitCondensed(initResult);
  emitJson({ type: 'port_init', ...initResult });

  if (!initResult.success) {
    log(`\nInit failed: ${initResult.error}`);
    return { success: false, setup: setupStatus, init: initResult, check: null };
  }

  // Phase 3: Check (dry run, quiet — we format condensed output)
  const checkResult = applyPatches(target, true, null, { quiet: true });
  formatCheckCondensed(checkResult);
  emitJson({
    type: 'port_check',
    passed: checkResult.passed.map(p => p.id),
    failed: checkResult.failed.map(f => ({ id: f.id, reason: f.reason })),
    skipped: checkResult.skipped.map(s => s.id),
    total: checkResult.total,
  });

  return { success: checkResult.success, setup: setupStatus, init: initResult, check: checkResult };
}
```

### Add condensed formatters

Place these right before `runPort()`:

```js
/**
 * Format setup results in condensed form (human mode only)
 */
function formatSetupCondensed(status, targetType) {
  log(`Setup: ${status.errors.length === 0 ? '✓' : '✗'}`);
  const b = status.backups[targetType];
  if (b) log(`  ${targetType} backup: ${b.details}`);
  const p = status.prettified[targetType];
  if (p) log(`  ${targetType} pretty: ${p.details}`);
  if (status.tweakcc) log(`  tweakcc: ${status.tweakcc.details}`);
  if (status.promptPatching) log(`  prompt-patching: ${status.promptPatching.details}`);
  if (status.warnings.length > 0) {
    for (const w of status.warnings) log(`  ⚠ ${w}`);
  }
  log('');
}

/**
 * Format init results in condensed form (human mode only)
 */
function formatInitCondensed(result) {
  if (!result.success) {
    log(`Init: ✗ ${result.error}`);
  } else if (result.alreadyExists) {
    log(`Init: ✓ patches/${result.version}/ (already exists)`);
  } else {
    log(`Init: ✓ patches/${result.version}/index.json (from ${result.copiedFrom})`);
    if (result.promptImport) {
      log(`  ${result.promptImport.count} prompt patches imported from ${result.promptImport.source}`);
    }
    if (result.baseline) {
      log(`  ~${result.baseline.charsSaved.toLocaleString()} chars savings across ${result.baseline.patchCount} patches`);
    }
    if (result.upstream) {
      const parts = [];
      if (result.upstream.onlyUpstream.length) parts.push(`${result.upstream.onlyUpstream.length} new upstream`);
      if (result.upstream.changed.length) parts.push(`${result.upstream.changed.length} changed`);
      if (parts.length) {
        log(`  Upstream: ${parts.join(', ')} (see upstream-comparison.txt)`);
      } else {
        log(`  Upstream: in sync`);
      }
    }
  }
  log('');
}

/**
 * Format check results in condensed form (human mode only)
 */
function formatCheckCondensed(result) {
  if (result.error) {
    log(`Check: ✗ ${result.error}`);
    return;
  }

  const passCount = result.passed.length;
  const failCount = result.failed.length;
  const skipCount = result.skipped.length;
  log(`Check: ${passCount}/${result.total} patches passed`);

  if (passCount > 0) {
    log(`  ✓ ${result.passed.map(p => p.id).join(', ')}`);
  }
  if (skipCount > 0) {
    log(`  ⊘ ${result.skipped.map(s => s.id).join(', ')} (already applied)`);
  }

  for (const fail of result.failed) {
    // prompt-slim has structured sub-patch info in its output — parse it
    if (fail.id === 'prompt-slim' && fail.output) {
      const scoreMatch = fail.output.match(/(\d+)\/(\d+) patches/);
      if (scoreMatch) {
        log(`  ✗ prompt-slim — ${scoreMatch[1]}/${scoreMatch[2]} prompt patches`);
        // Extract diagnostic lines for failures
        const diagLines = fail.output.split('\n').filter(l =>
          l.includes('diverged') || l.includes('chained') || l.includes('not found')
        );
        for (const d of diagLines.slice(0, 8)) {
          log(`    ${d.trim()}`);
        }
        continue;
      }
    }
    log(`  ✗ ${fail.id} — ${fail.reason}`);
    // Show first few lines of output for context
    if (fail.output) {
      const lines = fail.output.split('\n').filter(l => l.trim()).slice(0, 3);
      for (const l of lines) {
        log(`    ${l.trim()}`);
      }
    }
  }
  log('');
}
```

### Add `--port` handler in CLI section

Place this **before** the target resolution block (before the `// Determine target` comment, currently around line 1010). It needs its own target resolution since `--port` operates differently from `--check`/`--apply`:

```js
// Handle --port
if (wantPort) {
  let portTarget = null;

  if (wantBare) {
    if (!installs.bare) { console.error('Error: No bare installation detected'); process.exit(1); }
    portTarget = installs.bare;
  } else if (wantNative) {
    if (!installs.native) { console.error('Error: No native installation detected'); process.exit(1); }
    portTarget = installs.native;
  } else {
    const available = [installs.bare, installs.native].filter(Boolean);
    if (available.length === 0) { console.error('Error: No Claude Code installation detected'); process.exit(1); }
    if (available.length > 1) {
      console.error('Error: Multiple installations detected. Specify --bare or --native with --port');
      printStatus(installs);
      process.exit(1);
    }
    portTarget = available[0];
  }

  const result = runPort(installs, portTarget);

  if (result.check) {
    const failCount = result.check.failed.length;
    if (failCount > 0) {
      log(`Next: Fix ${failCount} failing patch(es), then re-run --check`);
    } else {
      log(`All patches passed! Ready to --apply`);
    }
  }

  emitJson({ type: 'result', status: result.success ? 'success' : 'needs_work', ...result });
  process.exit(result.success ? 0 : 1);
}
```

### Update `printHelp()` (line 544–576)

Add `--port` to ACTIONS:
```
ACTIONS
  --status     Show detected installations and workspace artifact versions
  --setup      Prepare patching environment (backups, prettify, repos)
  --init       Create index.json for installed version from latest existing index
  --port       Full porting pipeline: setup + init + check (condensed output)
  --check      Dry run - verify patch patterns match
  --apply      Apply patches
  --restore    Restore from .bak backup (undo patches)
```

Add to EXAMPLES:
```
  node claude-patching.js --native --port      # Full port pipeline for native
```

### Verification
- `node --check claude-patching.js`
- `node claude-patching.js --native --port` — full pipeline test (init will skip since 2.1.63 exists)
- Verify output is condensed: passing patches on one line, failures with diagnostics

---

## Phase 5: Update CLAUDE.md

### Replace "CLI Usage" section

Replace lines 5–15 with expanded version including `--port`:

```markdown
## CLI Usage

```bash
node claude-patching.js --status              # Detect installations, show versions and patch state
node claude-patching.js --setup               # Prepare environment (backups, repos, prettify)
node claude-patching.js --init                # Create index + import prompt patches for installed version
node claude-patching.js --port                # Full porting pipeline: setup + init + check
node claude-patching.js --check               # Dry run — verify patch patterns match
node claude-patching.js --apply               # Apply all patches
node claude-patching.js --native --check      # Target native install explicitly
node claude-patching.js --bare --apply        # Target bare install explicitly
node claude-patching.js --restore             # Restore from .bak backup
```
```

### Add new section after "CLI Usage" (before "Detailed Rules")

```markdown
## Porting to a New CC Version

When a new CC version drops, run `--port` against the updated target:

```bash
node claude-patching.js --native --port
```

This runs **setup** → **init** → **check** in one pass with condensed output. Passing patches are listed by name; failures include diagnostics.

**Typical follow-up:**

1. **Thinking-visibility fails** — This patch is target-specific (bare vs native have different React memo cache structures). Look at the `.pretty` file for the new condition pattern, create a new patch in `patches/<version>/native/` or `bare/`. See `patches/2.1.63/native/patch-thinking-visibility.js` for the current pattern.

2. **Prompt patches diverge** — Use the `upgrade-prompt-patches` skill, which reads the diagnostic output and walks through each failure. The most common causes: unicode escapes in find files (use literal chars), hardcoded variable names (use `__NAME__` placeholders), and restructured array boundaries.

3. **Other patches fail** — Usually a renamed minifier variable. Search the `.pretty` file for the surrounding structure, update the regex.

4. **Re-check iteratively:**
   ```bash
   node claude-patching.js --native --check
   ```

5. **Apply when all pass:**
   ```bash
   node claude-patching.js --native --apply
   ```

6. **Verify with `claude --version`** — The syntax check (built into `--apply`) catches JS errors before the binary is assembled, but always confirm the binary loads.

## What Each Command Does

| Command | Purpose | Idempotent? |
|---------|---------|-------------|
| `--status` | Detects bare/native installs, shows versions, applied patches, workspace artifact freshness | Yes |
| `--setup` | Clones/updates tweakcc + prompt-patching repos, creates `.original` backups from clean sources, generates `.pretty` files via js-beautify. Won't overwrite a clean backup if the source is already patched. | Yes |
| `--init` | Creates `patches/<version>/index.json` from latest existing index, imports prompt patches locally (best-of-both: upstream exact match wins, otherwise newest), generates `upstream-comparison.txt` | No — errors if index already exists |
| `--check` | Dry-runs all patches against target. Auto-falls back to latest patch version if none exists for the target version. | Yes |
| `--apply` | Applies patches, writes metadata comment, runs syntax check, reassembles binary (native). Creates `.bak` before patching. | No |
| `--restore` | Copies `.bak` over the live installation. | No |
```

### Replace "Development Workflow" section (lines 55-64)

```markdown
## Development Workflow

1. `--port` (or `--setup` + `--init` individually) — Prepare the environment
2. Explore cli.js with `rg` / `ast-grep` on `.pretty` files (see `code-exploration.md` rule)
3. Write patch (see `patch-format.md` rule for the contract)
4. `--check` — Dry run to verify (use iteratively as you fix patches)
5. `--apply` — Apply patches (includes syntax check + auto-rollback on failure)

Setup won't overwrite a clean backup if the source is already patched (`__CLAUDE_PATCHES__` marker).
```

---

## Verification Checklist

Run after each phase to catch regressions early:

1. **After Phase 1** (setup refactor):
   - `node --check lib/setup.js`
   - `node --check claude-patching.js`
   - `node claude-patching.js --setup` — should produce the same markdown table as before

2. **After Phase 2** (doInit extraction):
   - `node --check claude-patching.js`
   - `node claude-patching.js --init` — should say "already exists" for 2.1.63

3. **After Phase 3** (applyPatches structured return):
   - `node --check claude-patching.js`
   - `node claude-patching.js --native --check` — verify exit code 0, output unchanged

4. **After Phase 4** (--port implementation):
   - `node --check claude-patching.js`
   - `node claude-patching.js --native --port` — full pipeline
   - Verify: Setup section shows backup/pretty/repo status
   - Verify: Init section shows "already exists"
   - Verify: Check section shows condensed patch results
   - Verify: "Next:" line at the end

5. **After Phase 5** (CLAUDE.md):
   - Read through the file, check formatting renders correctly

**Note on JSON mode testing:** `CLAUDECODE=1` is automatically set in Claude Code's Bash tool, so all Bash-based testing implicitly tests JSON mode. To test human-mode output, read the code and verify the `log()` calls produce the expected formatting. The `qlog`/`qemit` pattern means quiet mode suppresses output while non-quiet (default) preserves it exactly.

---

## Implementation Order

Execute phases sequentially, verifying after each one:

1. Phase 1 → verify → commit checkpoint (optional)
2. Phase 2 → verify
3. Phase 3 → verify
4. Phase 4 → verify
5. Phase 5 → verify → final commit

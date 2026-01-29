# Plan: JSON Output Mode for Patches

## Goal
Refactor patches and orchestrator to output structured JSON (JSONL) when `CLAUDECODE=1` is detected, while maintaining human-readable output as default.

## Files to Modify

### New File
- `lib/output.js` — Shared output module

### Patch Files (target: latest version from 2.1.23/index.json)
1. `patches/2.1.14/patch-ghostty-term.js` (common)
2. `patches/2.1.19/patch-thinking-visibility.js` (bare + native)
3. `patches/2.1.23/bare/patch-thinking-style.js` (bare)
4. `patches/2.1.19/patch-thinking-style.js` (native)
5. `patches/2.1.23/bare/patch-spinner.js` (bare)
6. `patches/2.1.19/patch-spinner.js` (native)
7. `patches/2.1.20/bare/patch-system-reminders.js` (bare only)

### Orchestrator
- `claude-patching.js` — Main entry point

---

## Phase 1: Create Shared Output Module (`lib/output.js`)

### API Specification

```javascript
const output = require('./lib/output');

// Section - groups related output (like "=== Patch 1: Description ===")
output.section(title: string, opts?: { index?: number }): void

// Discovery - found a pattern/variable
output.discovery(label: string, value: string, details?: Record<string, string>): void

// Modification - before/after code change
output.modification(label: string, before: string, after: string): void

// Warning - non-fatal issue (goes to stderr in human mode)
output.warning(message: string, details?: string[]): void

// Error - fatal issue (goes to stderr)
output.error(message: string, details?: string[]): void

// Result - final outcome
output.result(status: 'success' | 'failure' | 'skipped' | 'dry_run', message: string): void

// Info - general informational message
output.info(message: string): void

// Mode query (for conditional logic in patches)
output.isJsonMode: boolean
```

### Human Output Examples

```javascript
output.section('Modify markdown signature', { index: 1 });
// === Patch 1: Modify markdown signature ===

output.discovery('helper function', '$', { 'String var': 'str', 'Array var': 'arr' });
// Found helper function: $
//   String var: str
//   Array var: arr

output.modification('signature', 'function PO(A){', 'function PO(A,dim){');
// Old: function PO(A){
// New: function PO(A,dim){

output.warning('LOOP_MODE enabled but no mirror patterns found');
// Warning: LOOP_MODE enabled but no mirror patterns found

output.result('success', 'Applied 3 patch(es) to /path/cli.js');
// Applied 3 patch(es) to /path/cli.js

output.result('dry_run', 'All patterns matched');
// (Dry run) All patterns matched
```

### JSON Output (JSONL)

Each method emits one JSON line:

```json
{"type":"section","title":"Modify markdown signature","index":1}
{"type":"discovery","label":"helper function","value":"$","details":{"String var":"str","Array var":"arr"}}
{"type":"modification","label":"signature","before":"function PO(A){","after":"function PO(A,dim){"}
{"type":"warning","message":"LOOP_MODE enabled but no mirror patterns found","details":null}
{"type":"result","status":"success","message":"Applied 3 patch(es) to /path/cli.js"}
```

### Design Decisions

- **Consistent emoji usage** — Emojis OK for visual markers (✓, ✗) but not as log-level indicators; `Warning:` and `Error:` prefixes remain text
- **No exit code handling** — `output.error()` does not call `process.exit()`; patches control their own exit
- **Immediate writes** — No buffering; each method writes immediately
- **stderr for warnings/errors** — In human mode only; JSON mode uses stdout only

---

## Phase 2: Refactor Each Patch (Agent Instructions)

Each patch file gets its own agent. The instructions below are comprehensive enough for autonomous work.

### Agent Template

> **Task:** Refactor `{patch_file}` to use the shared output module.
>
> **Import:** At the top of the file, add:
> ```javascript
> const output = require('{relative_path}/lib/output');
> ```
>
> **Rules:**
> 1. Replace all `console.log()` calls with appropriate `output.*` methods
> 2. Keep `console.error()` for truly fatal errors that should always go to stderr
> 3. Preserve exit codes: `process.exit(0)` for success, `process.exit(1)` for failure
> 4. Do NOT change the actual patching logic, only the output mechanism
>
> **Method mapping:**
> - `console.log('Found X: ${name}')` → `output.discovery('X', name)`
> - `console.log('Found X: ${name}') + details` → `output.discovery('X', name, { key: val, ... })`
> - `console.log('Old: ...\nNew: ...')` → `output.modification(label, before, after)`
> - `console.log('=== Patch N: ... ===')` → `output.section(title, { index: N })`
> - `console.log('✓ Patched ...')` → `output.result('success', 'Patched ...')`
> - `console.log('(Dry run - ...)')` → `output.result('dry_run', '...')`
> - `console.log('⚠️ ...')` / warnings → `output.warning(message)`
> - Status messages, notes → `output.info(message)`
> - Blank lines for spacing → `output.info('')`
>
> **Verification:** Run the patch before and after changes (use unique temp file names):
> ```bash
> # Before changes - capture baseline (plaintext output)
> node {patch_file} --check cli.js.bare.original > /tmp/{patch-id}-before.txt
> # After changes - verify JSON output
> node {patch_file} --check cli.js.bare.original > /tmp/{patch-id}-after.jsonl
> # Check it's valid JSONL
> cat /tmp/{patch-id}-after.jsonl | jq -s '.'
> ```

---

### Patch 1: `patches/2.1.14/patch-ghostty-term.js`

**Relative import:** `../../lib/output`

**Current output patterns:**
- `✓ Found N xterm-kitty color check(s)`
- Per-match: variable name, original code, patched code
- `✓ Patched {path}` + usage note
- `❌ Could not find xterm-kitty color detection pattern`
- `(Dry run - no changes made)`

**Mapping:**
```
"✓ Found N xterm-kitty..." → output.discovery('xterm-kitty checks', `${count} found`)
Per-match details → output.modification(`match ${i}`, original, patched)
"✓ Patched ..." → output.result('success', 'Patched ...')
"(Dry run ...)" → output.result('dry_run', 'No changes made')
"❌ Could not find..." → output.error('Could not find xterm-kitty detection pattern')
```

---

### Patch 2: `patches/2.1.19/patch-thinking-visibility.js`

**Relative import:** `../../lib/output`

**Current output patterns:**
- `Found thinking visibility pattern (bare/old format)`
- Variable names (isTranscriptMode, verbose, third condition)
- Original null check code snippet
- Modified isTranscriptMode prop
- Backup confirmation + `✓ Patched {path}`
- `Done! Restart Claude Code to see thinking blocks inline.`
- Multiple error messages for pattern not found
- `(Dry run - no changes made)`

**Mapping:**
```
"Found thinking visibility pattern..." → output.discovery('visibility pattern', 'bare format', { var1: x, var2: y })
"Original null check..." → output.info('Original: ...') or include in discovery details
"Modified prop..." → output.modification('isTranscriptMode prop', before, after)
"Backup confirmed..." → output.info('Backup created: ...')
"✓ Patched ..." → output.result('success', 'Patched ...')
"Done! Restart..." → output.info('Restart Claude Code to see thinking blocks inline.')
"(Dry run)" → output.result('dry_run', '...')
Pattern not found errors → output.error('...')
```

---

### Patch 3: `patches/2.1.23/bare/patch-thinking-style.js`

**Relative import:** `../../../lib/output`

**Current output patterns:**
- `Found helper function: {name}` + variable breakdown
- `Found markdown renderer: {name}` + signature
- `Found chalk variable: {name}`
- `Found thinking {mdFunc} call` + component info
- 3 separate `=== Patch N: Description ===` blocks showing old/new code
- `All patches applied to {path}` + result note
- Multiple failure points with specific error messages
- `(Dry run - no changes made)`

**Mapping:**
```
"Found helper function: X" + details → output.discovery('helper function', name, { 'String var': x, ... })
"Found markdown renderer: X" → output.discovery('markdown renderer', name, { ... })
"Found chalk variable: X" → output.discovery('chalk variable', name)
"Found thinking call" → output.discovery('thinking call', mdFunc, { ... })
"=== Patch N: ... ===" → output.section('...', { index: N })
Old/new code → output.modification(label, old, new)
"All patches applied..." → output.result('success', '...')
"(Dry run)" → output.result('dry_run', '...')
Errors → output.error('...')
```

---

### Patch 4: `patches/2.1.19/patch-thinking-style.js`

**Relative import:** `../../lib/output`

Same structure as Patch 3 but different regex patterns. Apply identical mapping.

---

### Patch 5: `patches/2.1.23/bare/patch-spinner.js`

**Relative import:** `../../../lib/output`

**Current output patterns:**
- `Found spinner function: {name}()` OR `Found already-patched spinner function: {name}()`
- Original/Current code display
- `New: {replacement}`
- `Spinner sequence: {chars}`
- `Animation mode: {loop|mirror}`
- `Found N mirror pattern(s) to patch...` with per-pattern details
- `Found N freeze branch(es) to remove...` with per-pattern details
- Warnings list with `⚠️`
- `✓ Patched {path}` + optional warning note

**Mapping:**
```
"Found spinner function: X()" → output.discovery('spinner function', name, { 'Status': 'original' or 'already patched' })
"Original: ..." → include in discovery details or use output.info()
"New: ..." → output.modification('spinner chars', original, replacement)
Config info → output.info('Spinner sequence: ...') or include in discovery
"Found N mirror patterns..." → output.discovery('mirror patterns', `${n} found`)
Per-pattern details → output.modification(`mirror ${i}`, before, after)
"Found N freeze branches..." → output.discovery('freeze branches', `${n} found`)
Per-branch details → output.modification(`freeze ${i}`, before, after)
"⚠️ ..." → output.warning('...')
"✓ Patched ..." → output.result('success', '...')
"(Dry run)" → output.result('dry_run', '...')
```

---

### Patch 6: `patches/2.1.19/patch-spinner.js`

**Relative import:** `../../lib/output`

Same structure as Patch 5. Apply identical mapping.

---

### Patch 7: `patches/2.1.20/bare/patch-system-reminders.js`

**Relative import:** `../../../lib/output`

**Current output patterns:**
- 3 labeled sections: `=== Patch N: Description ===`
- Per section: variable name, original length, action, new text, new length
- `Applied N patch(es) to {path}` + restart note
- `WARNING: Could not find X pattern` (per patch, non-fatal)
- `(Dry run - N patch(es) would be applied)`
- Configuration-driven output (shows MALWARE_REMINDER, TASK_REMINDER, FILE_MODIFIED_REMINDER settings)

**Mapping:**
```
"=== Patch N: ... ===" → output.section('...', { index: N })
Variable/length info → output.discovery('pattern var', name, { 'Original length': x, ... })
Config settings → output.info('Config: MALWARE_REMINDER = ...')
Old/new text → output.modification('reminder text', old, new)
"Applied N patch(es)..." → output.result('success', '...')
"WARNING: Could not find..." → output.warning('Could not find X pattern')
"(Dry run)" → output.result('dry_run', '...')
Restart note → output.info('Restart Claude Code...')
```

---

## Phase 3: Refactor Orchestrator (`claude-patching.js`)

After patches are updated, refactor the orchestrator:

1. **Add JSON mode detection** at top:
   ```javascript
   const jsonMode = process.env.CLAUDECODE === '1';
   ```

2. **Update `--status` output**:
   - Human mode: keep current format
   - JSON mode: output structured object

3. **Update `--check`/`--apply` output**:
   - Human mode: keep current indented format
   - JSON mode: pass through patch JSONL, add wrapper events

4. **Wrapper events for orchestrator** (JSON mode):
   ```json
   {"type":"start","mode":"check","target":"bare","version":"2.1.23"}
   // ... patch JSONL lines ...
   {"type":"summary","applied":3,"skipped":1,"failed":0,"success":true}
   ```

---

## Execution Order

1. **I write `lib/output.js`** directly
2. **Dispatch 7 agents in parallel** — one per patch file
3. **Review agent work** — verify consistency, fix any issues
4. **Refactor orchestrator** — after patches are done
5. **Test end-to-end**

---

## Verification

### Agent Verification (per-patch)

Agents should test their changes by running the patch script directly against the backup file. Use unique temp file names (e.g., include patch ID) since agents run in parallel:

```bash
# BEFORE making changes - capture current output (plaintext)
node patches/2.1.14/patch-ghostty-term.js --check cli.js.bare.original > /tmp/ghostty-term-before.txt

# AFTER making changes - verify JSON output
node patches/2.1.14/patch-ghostty-term.js --check cli.js.bare.original > /tmp/ghostty-term-after.jsonl

# Verify valid JSONL
cat /tmp/ghostty-term-after.jsonl | jq -s '.'
```

Note: Claude's environment has `CLAUDECODE=1` automatically set, so running patches will produce JSON output. To verify human output, Mark will test manually.

### End-to-End Verification (after all patches done)

```bash
# Full orchestrator check (JSON mode - automatic in Claude's env)
node claude-patching.js --bare --check

# Verify JSONL is parseable
node claude-patching.js --bare --check | jq -s '.'

# Human mode verification (Mark runs manually without CLAUDECODE env)
node claude-patching.js --bare --check
```

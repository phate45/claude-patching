---
name: creating-patches
description: Guide for developing new JS patches against CC's minified cli.js. Use when building a new patch from scratch — covers reconnaissance, pattern matching, injection techniques, cross-scope coordination, and the full verify cycle.
---

# Creating New Patches

## When to Use

When developing a new patch that modifies CC's runtime behavior by transforming the minified `cli.js` source. This covers code patches (regex find/replace against the bundle), not prompt patches (text find/replace against system prompt strings — see `upgrade-prompt-patches` for those).

## Prerequisites

Before writing any code:

```bash
node claude-patching.js --status    # Verify .pretty artifacts exist and match installed version
```

You need the `.pretty` files (js-beautify formatted, ~500K lines) for readable exploration, and the `.original` files (minified) for pattern verification. If missing, run `--setup`.

## Phase 1: Reconnaissance

### Find the Target

Search the pretty-printed source for the behavior you want to modify. The `.pretty` files are your map; the `.original` files are the territory you'll patch.

```bash
# Search pretty files for relevant strings, function names, patterns
rg -n 'someKeyword' cli.js.native.pretty
rg -n 'someKeyword' cli.js.bare.pretty
```

**Read context generously** — minified code is dense. Use the Read tool with ±50 line windows around matches. Trace data flow by following variable names within the pretty-printed scope.

### Map the Variable Names

The minifier assigns different names per build. Always identify the variables in **both** builds:

| What | Native (2.1.81) | Bare (2.1.80) |
|------|-----------------|---------------|
| Target function | `fnA` | `Al1` |
| State parameter | `$` | `q` |
| Item variable | `f` | `z` |

You'll need this mapping to decide: can this be a **common** patch (regex adapts to both), or does it need **separate bare/native** patches?

### Identify the Module Scope

Functions in `cli.js` live inside closure scopes (the bundler's module wrappers). Check indentation in the pretty file — 4-space indent means top-level of a module closure. If your patch needs to access variables from another module, you cannot reference them directly. Options:

- **`globalThis`** — cross-scope coordination via global state (preferred for simple flags/sets)
- **Module exports** — if the target module exports the variable, it may be importable
- **Injecting at the call site** — find where the modules interact and patch there instead

### Verify Pattern Uniqueness

Every regex must match **exactly once** in the minified source. Always verify:

```bash
# Count occurrences of your anchor pattern
rg -c 'your_pattern_here' cli.js.native.original
rg -c 'your_pattern_here' cli.js.bare.original
```

If count > 1, add more context to the pattern until it's unique. If count = 0, your pattern doesn't match the minified form — check for whitespace differences (the pretty file adds spaces/newlines that don't exist in the original).

## Phase 2: Pattern Design

### Regex Rules

| Rule | Why |
|------|-----|
| Match structure, not variable names | Names change every build. Use `([$\\w]+)` to capture identifiers. |
| Use `\b` word boundaries | Prevents partial matches and improves performance |
| Anchor to unique surrounding context | Include enough context that the pattern matches exactly once |
| Test against the `.original` files | The pretty files have different whitespace — patterns must match minified |

### Common Structural Patterns in cli.js

```javascript
// React component creation
X.createElement(ComponentVar, {props...})

// Case statements for message types
case"typename":

// Feature flag check
l$("tengu_flag_name", !1)    // native
A1("tengu_flag_name", !1)    // bare

// Module exports object
V8(exportObj, { funcName: () => funcVar, ... })

// Memoized lazy initializer
varName = _1(async () => { ... })    // bare
varName = _A(async () => { ... })    // native
```

### Injection Techniques

**Comma operator in return statements** — chain side effects before the return value:
```javascript
// Before: return result
// After:  return (sideEffect(), result)
return(globalThis.__myFlag=new Set(arr.map(function(_i){return _i.key})),result)
```

**Extending conditions** — add clauses to existing `if` guards:
```javascript
// Before: if(!state.has(item.path)){
// After:  if(!state.has(item.path)&&!myCheck(item)){
```

**Removing conditions** — strip a gate to always-enable or always-disable:
```javascript
// Before: if(flagCheck&&someCondition){doThing()}
// After:  if(someCondition){doThing()}
// Or:     doThing()
```

**Wrapping a function** — capture the original via regex, replace with a wrapper:
```javascript
// Capture: function foo(a,b){...original...}
// Replace: function foo(a,b){if(earlyReturn)return X;...original...}
```

### Variable Naming in Injected Code

**Never use bare single-letter variable names** in injected code. The minifier owns that namespace — collision causes runtime crashes that `--check` can't detect (variable discovery is correct at patch time, but closures capture the shadowed name at runtime).

Use `_`-prefixed names for all locals in injected callbacks and IIFEs:
```javascript
// BAD:  arr.map(function(e) { return e.content })
// GOOD: arr.map(function(_i) { return _i.content })
```

### Cross-Scope Coordination via globalThis

When two patch sites live in different module closures, use `globalThis` properties to share state:

```javascript
// Site 1 (writer): Store data
(globalThis.__myData = new Set(items.map(function(_i){ return _i.key })))

// Site 2 (reader): Check data — always guard against undefined
!(globalThis.__myData && globalThis.__myData.has(item.key))
```

Naming convention: `__` prefix (double underscore) for all `globalThis` patch properties. Existing examples:
- `globalThis.__taskOutputRead` — Set of task IDs (quiet-notifications)
- `globalThis.__instrContents` — Set of instruction file contents (worktree-dedup)

### String.replace() Gotcha

**Always use function replacers** when the replacement string contains captured variable names. Minified JS uses `$` in identifiers (`A$`, `rV$`), and `$&` in a replacement string means "insert entire match":

```javascript
// BAD:  str.replace(pattern, replacement)     // $-corruption risk
// GOOD: str.replace(pattern, () => replacement)  // literal string, no interpolation
```

## Phase 3: Write the Patch

### Boilerplate

```javascript
#!/usr/bin/env node
/**
 * Patch description — what it does and why.
 *
 * Usage:
 *   node patch-name.js <cli.js path>
 *   node patch-name.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-name.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

let patchCount = 0;
const EXPECTED_PATCHES = 2;  // adjust to actual count

// ── Patch Point 1: Description ──
// Pattern explanation, what we match, what we change

const site1Pattern = /regex_here/;
const site1Match = content.match(site1Pattern);

if (!site1Match) {
  output.error('Could not find <description> (site 1)');
  process.exit(1);
}

output.discovery('site 1 anchor', site1Match[0].slice(0, 80));
// output.discovery for each captured variable

const site1Old = site1Match[0];  // or a substring
const site1New = `replacement using ${capturedVars}`;

content = content.replace(site1Old, site1New);
patchCount++;

output.modification('site 1: description', site1Old, site1New);

// ── Write ──

if (patchCount !== EXPECTED_PATCHES) {
  output.error(`Expected ${EXPECTED_PATCHES} patches, got ${patchCount}`);
  process.exit(1);
}

if (dryRun) {
  output.result('dry_run', `patch-name: ${patchCount}/${EXPECTED_PATCHES} patches verified`);
} else {
  fs.writeFileSync(targetPath, content, 'utf8');
  output.result('success', `patch-name: ${patchCount}/${EXPECTED_PATCHES} patches applied`);
}
```

### output.js API

| Function | When to use |
|----------|-------------|
| `output.discovery(label, value, details?)` | Found a variable name, anchor, pattern match |
| `output.modification(label, before, after)` | Showing the before/after replacement |
| `output.result(status, message)` | Final outcome: `'dry_run'`, `'success'`, `'failure'` |
| `output.error(message, details?)` | Fatal — pattern not found, wrong count |
| `output.warning(message, details?)` | Non-fatal oddity |
| `output.info(message)` | General progress |

## Phase 4: Verify

Run in this exact order:

### 1. Dry run against target build

```bash
node patches/<version>/patch-name.js --check cli.js.native.original
node patches/<version>/patch-name.js --check cli.js.bare.original
```

Both must show the correct match count and sensible replacements.

### 2. Syntax check

Apply to a temp copy and verify JavaScript parses:

```bash
cp cli.js.native.original /tmp/cli-test.js
node patches/<version>/patch-name.js /tmp/cli-test.js
node --check /tmp/cli-test.js && echo "SYNTAX OK"
rm /tmp/cli-test.js
```

`node --check` catches syntax errors that regex can't — mismatched parens, broken string boundaries, etc.

### 3. Add to index.json

Add the patch entry to the appropriate section (`common`, `bare`, or `native`) in `patches/<version>/index.json`.

### 4. Full suite check

```bash
node claude-patching.js --native --check
node claude-patching.js --bare --check
```

Confirms the new patch plays nicely with all existing patches. Watch for interference — patches run sequentially, and an earlier patch may alter text that your patch targets.

## Phase 5: Integration

### Determine Patch Placement

| If the patch... | Place in |
|-----------------|----------|
| Works identically on both builds (regex captures adapt) | `common` |
| Targets structures that differ between builds | Separate `bare/` and `native/` entries |
| Uses hardcoded variable names from one build | Must be build-specific |

Most patches can be common if the regex uses capture groups for variable names.

### Native Size Budget

The native binary has a **hard size constraint**: patched JS must be ≤ original size. Every byte of injected code eats into the budget. All patches combined share the same budget.

- Prefer removing conditions over injecting new logic
- Prefer modifying existing expressions over adding new function bodies
- Check the budget with `--apply` — it reports remaining bytes

### Update README.md

Add the patch to the appropriate table in README.md with a concise description.

## Common Pitfalls

| Pitfall | Prevention |
|---------|------------|
| Pattern matches pretty file but not minified | Always verify against `.original` files |
| Pattern matches >1 location | Add more surrounding context to the regex |
| Bare single-letter vars in injected code | Use `_`-prefixed names: `_i`, `_e`, `_a` |
| `$` in replacement string triggers interpolation | Use function replacer: `.replace(pat, () => str)` |
| Injecting inside a `let a,b,c;` declaration | Match through the terminating `;` first |
| Sync function can't call async memo | Use `globalThis` bridge or find a sync access path |
| Patching the wrong display path | Trace from visible UI back to the code — `renderToolUseMessage` and `getToolUseSummary` are independent |

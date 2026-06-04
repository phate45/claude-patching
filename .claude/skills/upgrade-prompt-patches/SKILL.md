---
name: upgrade-prompt-patches
description: Port system prompt patches to a new Claude Code version. Use when CC has updated and --check shows prompt patch failures.
---

# Upgrading Prompt Patches to a New CC Version

## When to Use

The `patch-prompt-slim.js` patch applies find/replace pairs from `patches/<version>/prompt-patches/` to optimize the system prompt. When a new CC version ships, some patches may fail because Anthropic changed the text. This skill guides you through porting and merging.

## Why Most Patches Port Unchanged

The regex engine uses placeholder-based matching:

| Placeholder | Matches | Example |
|-------------|---------|---------|
| `${varName}` | Template literal vars like `${n3}`, `${XYZ}` | Tool references in prompts |
| `__NAME__` | Plain identifiers like `kY7`, `aBC` | Function names in code |

Variable names change every build, but the regex auto-adapts. **You only fix patches where Anthropic changed the actual text content.**

## Patch Ownership

All prompt patches live in `patches/<version>/prompt-patches/` and are fully self-contained. There is no upstream repo — the local set is authoritative.

## Porting Workflow

### Step 1: Assess the Gap

```bash
node claude-patching.js --status           # What CC version is installed?
node lib/prompt-baseline.js --list         # What versions have local patches?
```

Identify: `NEW_VERSION` (installed CC) and the latest local patch set.

### Step 2: Setup and Init

```bash
node claude-patching.js --setup            # Refresh tweakcc reference + workspace
node claude-patching.js --init             # Create index.json + import prompt patches locally
```

`--init` copies the latest local patch set ≤ `NEW_VERSION` into `patches/<NEW_VERSION>/prompt-patches/`. The result is a fresh local patch set ready for verification.

After import, `--init` outputs the patch count and total savings.

### Step 3: Check

```bash
node claude-patching.js --check            # bare (if single install)
node claude-patching.js --bare --check     # or explicit
node claude-patching.js --native --check   # native
```

If all patches pass, the text didn't change — move to **Step 5** (apply).

**Surface the per-patch divergence warnings.** The orchestrator's top-level `--check` summarizes prompt-slim as a single `M/N patches` line and the divergence diagnostics get swallowed in the noise. To get the structured warnings directly, invoke the patch script and filter with `jq`:

```bash
# native
node patches/<NEW_VERSION>/patch-prompt-slim.js --check cli.js.native.original \
  | jq -c 'select(.type=="warning" or .type=="result")'
# bare
node patches/<NEW_VERSION>/patch-prompt-slim.js --check cli.js.bare.original \
  | jq -c 'select(.type=="warning" or .type=="result")'
```

The `result` line shows the running tally (e.g. `prompt-slim (v2.1.162): 65/67 patches, ~34,684 chars saved`); the `warning` entry carries a `details` array with one diverged/chained/not-found diagnostic per failed patch. Use this same invocation iteratively as you fix `.find.txt`/`.replace.txt` pairs — it's the only view that shows the *next* failure after you fix the current one.

### Step 4: Fix Failures

`patch-prompt-slim.js` has **built-in diagnostics** for failures. The `--check` output classifies each skipped patch:

- **`chained (consumed by <patch>)`** — an earlier patch already removed this text. Remove the entry from `patches.json`. No investigation needed.
- **`diverged (N% match, line X/Y)`** — text content changed at a specific point. The output shows both the patch context and bundle context at the divergence. Update `.find.txt` and `.replace.txt`.
- **`not found`** — no meaningful match from line 1. The section may be removed or heavily rewritten. **This requires judgment**: search the bundle for distinctive phrases from the `.find.txt` to determine if the text was relocated/reworded or truly deleted.

Example output:
```
parallel-calls-duplicate: chained (consumed by task-usage-notes)
doing-tasks-intro: diverged (16% match, line 1/1)
    patch: er will primarily request you perform software engineering tasks. This
    bundle: er will primarily request you to perform software engineering tasks. T
professional-objectivity: not found — Section may be removed or heavily rewritten
```

**Fix the patch files** in `patches/<NEW_VERSION>/prompt-patches/`:

- **Reworded**: Update `.find.txt` to match the new bundle text. Update `.replace.txt` only if it references the changed portion. Preserve all `${varName}` and `__NAME__` placeholders.
- **Removed by Anthropic**: Delete both `.find.txt` and `.replace.txt`, and remove the entry from the `patches` array in `patches.json`.
- **Chained casualty**: Just remove the entry from `patches.json`. Optionally delete the patch files.

**Write all fixes in a single Node script** rather than editing files one at a time. Use `fs.writeFileSync` for updates and `fs.unlinkSync` for deletions. Avoid template literals for patch content that contains backticks — use string concatenation or `Array.join('\n')` instead.

Recheck and iterate until all patches apply:
```bash
node claude-patching.js --check   # should show more patches passing now
```

### Step 5: Apply

```bash
node claude-patching.js --apply
```

## Gotchas

### Empty Replacements Break /context

Never leave a `.replace.txt` completely empty. The API requires non-whitespace in text blocks. Use:
```
# .
```
This renders as a harmless orphan heading.

### Function-Based Patches

Patches using `__NAME__` for function replacement have a critical rule: **the `.replace.txt` must define the function using whatever name the regex captures from the NEW bundle.** Since `__NAME__` becomes a backreference (`$1`), the replacement automatically gets the right name — but if you hardcode an old function name, you get:
```
SyntaxError: Identifier 'oldName' has already been declared
```

### Chained Patches Can Mask Failures

Patches run in order. If an early patch removes a large block (e.g., `task-usage-notes` strips the entire Task tool usage section), later patches targeting text within that block will report "pattern not found" even though nothing is wrong — the text was already removed.

The built-in diagnostics detect this automatically as `chained (consumed by <patch>)`.

### Native Unicode Escaping

Native (Bun) builds store unicode characters as escape sequences (`\u2014` instead of `—`). The `toNativeEscapes()` function handles this automatically.

**However**: if a `.find.txt` was written specifically for native (already contains literal `\u2019` etc.), then `toNativeEscapes()` is a no-op because there are no unicode characters to convert. This is expected — don't waste time debugging why the "native path" isn't triggering.

### Backticks in Fix Scripts

Patch text often contains JS template literal backticks. If you write a Node fix script using template literals, those backticks cause syntax errors. Use `Array.join('\n')`, string concatenation, or `fs.readFileSync` + `.replace()` on the existing file instead.

### Cross-Delimiter String Merges

Some patches merge adjacent array elements by removing the boundary between them (e.g., removing `",'` that separates two strings). **This is dangerous when the elements use different quote delimiters.** If the first string uses `"` and the second uses `'`, merging them produces a `"`-delimited string containing unescaped `"` characters from the second string's content:

```js
// Original: two separate elements, different delimiters
"When referencing code locations.",'Do not use "Let me read"...'
//                                 ^^^ safe — inside single quotes

// BAD replacement: removes boundary, merges into double-quoted string
"Do not use "Let me read"...'
//           ^ JS parser sees this as end of string → SyntaxError

// GOOD replacement: close first string, preserve second string's delimiter
",'Do not use "Let me read"...'
// Creates empty "" element, keeps inner " safe in single quotes
```

**Detection:** Bun reports `TypeError: Expected CommonJS module to have a function wrapper` — misleading, but always means a JS syntax error. Run `node --check <extracted-js>` to find the actual error location.

**Prevention:** When a patch spans a `",'` or `','` boundary, verify the replacement preserves or correctly transitions between delimiters. An empty string element (`""`) in an array is harmless when the array is joined.

## Debugging Runtime Crashes

If patches apply but Claude crashes or shows `[object Object]`:

1. The replacement text has a stale variable reference
2. Use bisect: comment out patches in `patches.json`, binary search for the culprit
3. Check for `[object Object]` — means a variable resolved to the wrong type
4. Check for empty text blocks — means a replacement produced whitespace-only content

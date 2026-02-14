---
paths:
  - "lib/**"
  - "patches/**/*.js"
---

# Library API Reference

## lib/output.js

Structured output — emits JSON when `CLAUDECODE=1`, human-readable text otherwise.

**Functions:**

| Function | Signature | Purpose |
|----------|-----------|---------|
| `section` | `(title, { index? })` | Group header: `=== Patch 1: Title ===` |
| `discovery` | `(label, value, details?)` | Found something: `Found label: value` |
| `modification` | `(label, before, after)` | Show a change |
| `warning` | `(message, details?)` | Non-fatal issue (stderr). `details` is `string[]` |
| `error` | `(message, details?)` | Fatal issue (stderr). `details` is `string[]` |
| `result` | `(status, message)` | Final outcome. Status: `'success'`\|`'failure'`\|`'skipped'`\|`'dry_run'` |
| `info` | `(message)` | Informational line |

**Common mistakes:**
- There is NO `output.success()` — use `output.result('success', msg)`
- There is NO `output.warn()` — the function is `output.warning()`
- `result()` takes exactly 2 args `(status, message)` — no details array

## lib/shared.js

Core detection and utility functions.

**Exports:**
- `PATCH_MARKER` — `'__CLAUDE_PATCHES__'` string used to detect patched files
- `detectBareInstall()` → `{ type: 'bare', path, version }` or `null`
- `detectNativeInstall()` → `{ type: 'native', path, version }` or `null`
- `detectInstalls()` → `{ bare, native }` (both nullable)
- `readPatchMetadata(content)` → parsed metadata object or `null`
- `writePatchMetadata(content, meta)` → content with metadata embedded
- `isPatched(content)` → `boolean` (checks for PATCH_MARKER)
- `extractVersion(content)` → `string` or `null` (matches `VERSION:"X.Y.Z"`)
- `formatBytes(n)` → human-readable string
- `safeStats(path)` → `{ exists, size?, mtime? }`

**Version detection:** Use `extractVersion(content)`, not a custom regex.
The pattern is `VERSION:"X.Y.Z"` — NOT `CLI_VERSION`.

## lib/prompt-baseline.js

Prompt patching baseline and diff tool.

**Exports:**
- `generateBaseline(version)` → `{ findText, replaceText, patches, outputDir, totalFindChars, totalReplaceChars }`
- `generateDiff(oldVersion, newVersion)` → `{ diffPath, diffText, added, removed, logicChanged, oldHash, newHash }`
- `listVersions()` → sorted `string[]` of versions in the prompt-patching repo
- `previousVersion(version)` → `string` or `null`
- `parsePatchList(version)` → `[{ name, file }]` ordered array from patch-cli.js
- `hashPatchLogic(version)` → `string` MD5 hash of non-config logic
- `PROMPT_REPO` — `/tmp/prompt-patching/system-prompt`
- `PATCHES_DIR` — `<project>/patches/`

**CLI usage:**
```bash
node lib/prompt-baseline.js --list
node lib/prompt-baseline.js <version>
node lib/prompt-baseline.js <version> --diff
node lib/prompt-baseline.js <version> --diff=X.Y.Z
```

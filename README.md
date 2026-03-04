# Claude Code Patches

Minimal patches for Claude Code, supporting both installation methods:
- **bare** — pnpm/npm install (standalone `cli.js`)
- **native** — Bun-compiled binary (`~/.local/bin/claude`)

Inspired by [tweakcc](https://github.com/Piebald-AI/tweakcc), but lighter — just the adjustments I want. Use at your own peril.

For supported CC versions, see the [patches](./patches/) folder.

**Runtime:** Node.js 22+ (or [Bun](https://bun.sh)). Node < 25 may need `--experimental-strip-types`.

## Quick Start

```bash
git clone https://github.com/phaete/claude-patching.git
cd claude-patching
npm install                            # node-lief dependency (needed for native binary patching)

node claude-patching.js --status       # detect installations, show versions
node claude-patching.js --check        # dry run — verify all patches match
node claude-patching.js --apply        # apply patches
```

If both bare and native installs exist, specify the target:

```bash
node claude-patching.js --native --check
node claude-patching.js --bare --apply
```

## Patches

### Token & Context Savings

| Patch | Effect |
|-------|--------|
| **prompt-slim** | Condenses ~38KB of verbose system prompt text (tool descriptions, examples, instructions) via 60 find/replace patches. Adapted from [claude-code-tips](https://github.com/ykdojo/claude-code-tips) with custom additions. |
| **system-reminders** | Removes the malware warning injected after every file read (~70 tokens each) and condenses the task/file-modification reminders. Configurable per-reminder: `remove`, `concise`, or `keep`. |
| **quiet-notifications** | Suppresses duplicate background agent notifications when `TaskOutput` has already read the output. Prevents redundant content accumulating in long sessions with heavy agent use. |

### Display & UX

| Patch | Effect |
|-------|--------|
| **thinking-visibility** | Shows thinking/reasoning blocks inline in the TUI. Normally only visible in transcript mode (Ctrl+O). |
| **no-collapse-reads** | Prevents consecutive Read/Grep/Glob calls from collapsing into a single summary line. Each tool call displays individually. |
| **read-summary** | Shows offset/limit info in the compact Read display: `Read(file.js · lines 200-229)` instead of just `Read(file.js)`. |
| **spinner** | Custom spinner animation. Configurable character sequence and animation mode at the top of the patch file. |
| **ghostty-term** | Adds truecolor support for [Ghostty](https://ghostty.org/) terminal (CC only recognizes `xterm-kitty` by default). |

### Behavioral

| Patch | Effect |
|-------|--------|
| **feature-flag-toggles** | Enables richer memory management prompt and structured session memory compaction (maintains a living `summary.md` per session instead of throwaway summaries). Kill switch: `DISABLE_CLAUDE_CODE_SM_COMPACT=1`. |
| **expressive-tone** | *(prompt patch)* Replaces the blunt "short and concise" brevity directive with natural expression guidance. |
| **natural-emojis** | *(prompt patch)* Replaces the blanket emoji ban with "Use emojis naturally to enhance communication." |

### Retired / Dormant

| Patch | Status |
|-------|--------|
| **thinking-style** | Redundant — CC's default style already matches what this patched for. |
| **auto-memory** | Retired — evolved into feature-flag-toggles after `tengu_oboe` graduated to always-on in 2.1.59. |

## After CC Updates

CC updates replace the installation, removing patches and metadata.

```bash
node claude-patching.js --check     # verify patches still match
node claude-patching.js --apply     # re-apply
```

If patches no longer match (new CC version), check for an updated patch set in this repo or see [DEVELOPMENT.md](./DEVELOPMENT.md) for the porting workflow.

## Restoring

`--apply` creates a `.bak` backup before patching. To restore:

```bash
node claude-patching.js --restore              # auto-detects install type
node claude-patching.js --native --restore     # or specify explicitly
```

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for patch development, porting to new CC versions, and troubleshooting.

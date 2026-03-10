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
| **system-reminders** | Removes the malware warning injected after every file read (~70 tokens each) and condenses the task/file-modification reminders (~500+ → ~25 tokens per event). Configurable per-reminder: `remove`, `concise`, or `keep`. |
| **quiet-notifications** | Suppresses duplicate background agent notifications when `TaskOutput` has already read the output. Prevents redundant content accumulating in long sessions with heavy agent use. |

### Display & UX

| Patch | Effect |
|-------|--------|
| **thinking-visibility** | Shows thinking/reasoning blocks inline in the TUI. Normally only visible in transcript mode (Ctrl+O). |
| **no-collapse-reads** | Prevents consecutive Read/Grep/Glob calls from collapsing into a single summary line. Each tool call displays individually. |
| **read-summary** | Shows offset/limit info in the compact Read display: `Read(file.js · lines 200-229)` instead of just `Read(file.js)`. |
| **spinner** | Custom spinner animation. Configurable character sequence and animation mode at the top of the patch file. |
| **toolsearch-visibility** | Makes ToolSearch tool calls visible in the TUI. CC 2.1.71 suppressed all rendering — this restores it: `ToolSearch(select:WebFetch)` / `Loaded 1 tool`. Useful for spotting which deferred tools are being loaded across sessions. |
| **cron-visibility** | Makes cron/loop-fired prompts visible in the TUI with a bold **⏰ CronJob:** prefix. Without this, scheduled tasks fire silently — the assistant responds but you see no trigger. The prefix also flows through to the API message, giving the model context that the prompt is cron-fired. |
| **ghostty-term** | Adds truecolor support for [Ghostty](https://ghostty.org/) terminal (CC only recognizes `xterm-kitty` by default). |
| **keyword-highlights** | Adds keyword based highlighting built on the `ultrathink` shimmer implementation. Purely visual goodness.

### Behavioral

| Patch | Effect |
|-------|--------|
| **feature-flag-toggles** | Enables structured session memory compaction (maintains a living `summary.md` per session instead of throwaway summaries). Also disables `tengu_defer_all_bn4` (new in 2.1.70), which otherwise defers ALL built-in tools behind ToolSearch — restoring immediate access to Read, Edit, Bash, etc. Kill switch: `DISABLE_CLAUDE_CODE_SM_COMPACT=1`. |
| **flag-env-override** | Patches the GrowthBook feature flag system to read overrides from `CLAUDE_CODE_FLAG_OVERRIDES` env var. Any flag in the JSON map bypasses server-side evaluation entirely. Example: `CLAUDE_CODE_FLAG_OVERRIDES='{"tengu_kairos_cron":true}' claude` enables the hidden `/loop` scheduling command. |
| **expressive-tone** | *(prompt patch)* Replaces the blunt "short and concise" brevity directive with natural expression guidance. |
| **natural-emojis** | *(prompt patch)* Replaces the blanket emoji ban with "Use emojis naturally to enhance communication." |
| **doing-tasks-intro** | *(prompt patch)* Fixes upstream's garbled "For software engineering tasks: software engineering tasks and the current working directory" by extending the find to consume the full sentence. |
| **task-usage-notes** | *(prompt patch)* Strips ~2KB of Agent tool usage notes and examples, keeping the tool focused on agent type descriptions and the "When NOT to use" summary. |

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

# Claude Code Patches

Minimal patches for Claude Code, supporting both installation methods:
- **bare** — pnpm/npm install. Since 2.1.117 this ships a wrapper package that downloads a platform-specific Bun ELF via optional dependencies; postinstall hardlinks it to `bin/claude.exe`. Pre-2.1.117 bare installs (standalone `cli.js`) are still supported.
- **native** — Bun-compiled binary (`~/.local/bin/claude`).

Both install types now share the same patching pipeline: extract the JS payload from the Bun overlay, apply patches, repack the binary.

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
| **prompt-slim** | Condenses verbose system prompt text (tool descriptions, examples, instructions) via 67 find/replace patches. Includes a Karpathy-style restructure (`work-principles`, `section-rename`, `null-executing-actions`) that replaces the scattered `# Doing tasks` bullet-soup plus the 2.8KB `# Executing actions with care` monologue with a unified `# How you work` section organized around four principles: *Think before coding*, *Simplicity first*, *Surgical changes*, *Verify before declaring done*. Subsumes the prior ant-* custom patches. Since 2.1.154 also includes six `lean-*` pairs targeting opus-4-8's separate lean system prompt code path (`oXz` Harness block, `mXz` action_caution, `Y0_` TodoWrite, lean Read/Write/Edit descriptions) — same engine, different target strings. |
| **system-reminders** | Removes the malware warning injected after every file read (~70 tokens each) and condenses the task/file-modification reminders (~500+ → ~25 tokens per event). Configurable per-reminder: `remove`, `concise`, or `keep`. |
| **quiet-notifications** | Suppresses duplicate background agent notifications when `TaskOutput` has already read the output. Prevents redundant content accumulating in long sessions with heavy agent use. |
| **trim-context-bloat** | Removes three noisy fields from the system-prompt assembly: `userEmail` (rarely load-bearing; gitStatus already carries the user's name), `currentDate` (redundant when a `UserPromptSubmit` hook supplies live temporal grounding and goes stale across midnight), and the Claude model-family marketing paragraph (only relevant when building Claude apps inside a session). Nulls the paragraph into the existing `.filter((M) => M !== null)`, strips the two user-context fields from their return object. |
| **hook-envelope-strip** | Rewrites the `hook_success` attachment template from `` `${hookName} hook success: ${content}` `` to just `` `${content}` ``. Scope is naturally narrow — the renderer is already gated to fire only for `SessionStart`, `UserPromptSubmit`, and `UserPromptExpansion`, so tool-phase and permission hooks are untouched. Hook payloads tend to be self-labeled (`Temporal grounding: ...`), and the envelope only adds harness plumbing that blurs into the surrounding system-reminder noise. |
| **env-block-trim** | Drops three lines from the `# Environment` preamble across all builder sites. `Platform: ${...}` is a strict subset of the adjacent `OS Version` line. The `Shell: $SHELL` line is actively misleading — the Bash tool's persistent-shell selector (`ab5()`) only ever resolves bash/zsh, falling back to a PATH scan when `$SHELL` is exotic, so a fish/nu login shell reported e.g. `Shell: /usr/bin/fish` while the executor ran bash, making the model write fish syntax the tool rejected. The Bash tool is Bash. The `Claude Code is available as a CLI ... IDE extensions (VS Code, JetBrains)` line is static filler. Empty-string replacements preserve the element-separator commas. |

### Display & UX

| Patch | Effect |
|-------|--------|
| **thinking-visibility** | Shows thinking/reasoning blocks inline in the TUI. Normally only visible in transcript mode (Ctrl+O). |
| **thinking-display-summarized** | Opts back into summarized thinking text on Opus 4.7. Starting with 4.7, the Anthropic API omits `thinking` block content by default — blocks arrive empty unless the caller sends `thinking.display: "summarized"`. CC doesn't wire that field up anywhere, so this patch injects it as the request-builder default. No-op on 4.6 and older (already summarized by default). Without this, the `thinking-visibility` patch renders empty blocks on 4.7. |
| **thinking-no-fold** | Stops the transcript grouper from folding thinking blocks into the adjacent `collapsed_read_search` tool group. 2.1.153 added that fold unconditionally on every render, which caused thinking to display as a "Thought for Ns · ctrl+o to expand" pill instead of the full inline reasoning — the live-streamed thinking would flash in for a moment and then collapse as the static transcript snapshot took over. The patch flushes the in-progress group and pushes the thinking message as its own top-level entry, so the normal `case "thinking"` render path takes over (and `thinking-visibility` keeps it expanded). |
| **no-collapse-reads** | Prevents consecutive Read/Grep/Glob calls from collapsing into a single summary line. Each tool call displays individually. |
| **read-summary** | Shows offset/limit info in the compact Read display: `Read(file.js · lines 200-229)` instead of just `Read(file.js)`. |
| **spinner** | Custom spinner animation. Configurable character sequence and animation mode at the top of the patch file. |
| **toolsearch-visibility** | Makes ToolSearch tool calls visible in the TUI. CC 2.1.71 suppressed all rendering — this restores it: `ToolSearch(select:WebFetch)` / `Loaded 1 tool`. Useful for spotting which deferred tools are being loaded across sessions. |
| **cron-visibility** | Makes cron/loop-fired prompts visible in the TUI with a bold **⏰ CronJob:** prefix. Without this, scheduled tasks fire silently — the assistant responds but you see no trigger. The prefix also flows through to the API message, giving the model context that the prompt is cron-fired. |
| **ghostty-term** | Adds truecolor support for [Ghostty](https://ghostty.org/) terminal (CC only recognizes `xterm-kitty` by default). |
| **keyword-highlights** | Adds keyword-based highlighting built on the `ultrathink` shimmer implementation, plus inline `` `code` `` spans and markdown formatting (`**bold**`, `*italic*` / `_italic_`, `~~strikethrough~~`). Code spans get a distinct color; markdown gets native text effects. All styles coexist with keywords (keywords take priority, formatting clips around them). Uses alnum-only word boundaries so `snake_case` identifiers don't trigger. |
| **code-blocks** | Renders fenced code blocks in user messages with hljs syntax highlighting. Explicit language tags (`` ```js ``) use the specified language; untagged blocks get auto-detection. Dim ``` fences frame the highlighted content. |

### Behavioral

| Patch | Effect |
|-------|--------|
| **feature-flag-toggles** | Enables minimal Edit anchors (1-3 lines) by toggling `tengu_edit_minimalanchor_jrn` to `true`. Previously also toggled `tengu_session_memory` (retired 2.1.133), `tengu_sm_compact` (gate removed 2.1.92), `tengu_maple_forge_w8k` (removed 2.1.97). See `patches/2.1.133/js-patches/patch-feature-flag-toggles.js` for the full retired-flags history. |
| **disable-bundled-skills** | Disables *bundled* skills at registration time so they never reach the command registry — gone from both the model's `skill_listing` context and the `/slash` surface. Injects a name-blocklist guard at the top of the bundled-skill registrar `Mz()`, before the registry push. Config via `CLAUDE_CODE_DISABLED_BUNDLED_SKILLS` (comma-separated bundled skill names), parsed once per session; sentinel `*` disables **all** bundled skills. Example: `CLAUDE_CODE_DISABLED_BUNDLED_SKILLS='claude-api,design-sync,debug' claude`. Bundled-only and permanent (per invocation) — the heavy lever for built-in clutter you never want. Supersedes the old `disable-claude-api-skill` (just list `claude-api`). |
| **disable-skills** | Session/profile skill filter — hides **any** skill (bundled, project, user, or plugin) by name for the current session *without* unregistering it. Filters the merged, deduped command list in the memoized loader `RC8` (`Y=ll([...])`), the single root both the `skill_listing` attachment and `/slash` resolution read from. Config via `CLAUDE_CODE_DISABLED_SKILLS` (comma-separated), parsed once per session. The "Claude Code Profiles" lever — flip per project/session: an implementation session can drop `code-review` from context while a review session keeps it. Example: `CLAUDE_CODE_DISABLED_SKILLS='code-review,security-review,deep-research' claude`. Filters by command name, so it can also hide built-in slash commands; an unknown name silently no-ops. |
| **flag-env-override** | Patches the GrowthBook feature flag system to read overrides from `CLAUDE_CODE_FLAG_OVERRIDES` env var. Any flag in the JSON map bypasses server-side evaluation entirely. Example: `CLAUDE_CODE_FLAG_OVERRIDES='{"tengu_kairos_cron":true}' claude` enables the hidden `/loop` scheduling command. |
| **tool-defer-whitelist** | Injects a whitelist check at the top of `isDeferredTool()`, ahead of all built-in logic including the MCP gate. Tools named in `CLAUDE_CODE_IMMEDIATE_TOOLS` (comma-separated) become immediately available instead of deferred behind ToolSearch. Example: `CLAUDE_CODE_IMMEDIATE_TOOLS='AskUserQuestion,WebFetch' claude`. |
| **abbreviations** | Fish-style abbreviation expansion for the input line. Two modes: **exact match** splits on the first separator (space, `.`, `,`, `;`) and preserves trailing args (`gs .` → `git status .`); **regex match** uses keys starting with `/` as patterns with `$1` capture group interpolation, appending any text after the match (`rw 22 check auth` → `Review MR 22. check auth`). Config via `CLAUDE_CODE_ABBREVIATIONS` env var (JSON object), parsed once per session. Example: `CLAUDE_CODE_ABBREVIATIONS='{"gs":"git status","/^rw (\\d+)":"Review MR $1."}' claude`. |
| **worktree-dedup** | Content-based nearest-wins deduplication for auto-injected instruction files (`CLAUDE.md`, `.claude/rules/*.md`). When a file is `Read` inside a nested directory tree — git worktrees, monorepos, vendored configs — Claude walks every ancestor's `.claude/rules/` and injects each match. Without this patch, identical rule files at multiple levels all land in context (the built-in path-based dedup misses them because their absolute paths differ). The patch applies a post-pass at two sites: `qW` (session-start memory load) and `uD4` (Read-time injection), walking the assembled file array in reverse and dropping duplicate `.content` strings. Reverse order means the *last* push — the copy closest to the Read target / cwd — wins, so worktree-local edits aren't shadowed by outer copies. Covers both unconditional (no-glob) and conditional (scoped) rules, which CC loads via separate code paths. |
| **expressive-tone** | *(prompt patch)* Replaces the blunt "short and concise" brevity directive with natural expression guidance. |
| **natural-emojis** | *(prompt patch)* Replaces the blanket emoji ban with "Use emojis naturally to enhance communication." |
| **doing-tasks-intro** | *(prompt patch)* Rewrites the verbose "For software engineering tasks..." intro into a single tight sentence. |
| **task-usage-notes** | *(prompt patch)* Compresses the Agent tool's "When NOT to use" block, usage notes, and examples (~4KB → ~0.5KB). Keeps a condensed when-not summary, essential usage guidance, and the SendMessage resume note. Includes explicit guidance against reading background agent output files directly. |
| **ant-comment-discipline** | *(prompt patch)* Injects Anthropic's internal comment-writing rules: default to no comments, only annotate non-obvious "why", don't explain what code does, don't remove existing comments unless removing the code. |
| **ant-misconception-callout** | *(prompt patch)* Injects the ant-only misconception/adjacent-bug callout: "If you notice the user's request is based on a misconception, or spot a bug adjacent to what they asked about, say so." |
| **ant-faithful-outcomes** | *(prompt patch)* Injects ant-only faithful outcome reporting: never claim tests pass when output shows failures, never suppress failing checks, don't hedge confirmed results. |
| **communicating-with-user** | *(prompt patch)* Replaces the generic "Output efficiency" section with Anthropic's internal "Communicating with the user" guidance — flowing prose, no semantic backtracking, inverted pyramid structure, match depth to reader expertise. |
| **help-guide-agent** | *(prompt patch)* Appends guidance to dispatch a `claude-code-guide` agent for questions about Claude Code features, capabilities, or configuration. |

### Retired / Dormant

| Patch | Status |
|-------|--------|
| **thinking-style** | Redundant — CC's default style already matches what this patched for. |
| **auto-memory** | Retired — evolved into feature-flag-toggles after `tengu_oboe` graduated to always-on in 2.1.59. |
| **resume-cache-fix** | Retired in 2.1.90 — Anthropic fixed natively (added `deferred_tools_delta`, `mcp_instructions_delta`, `agent_listing_delta`, and `companion_intro` to the `isLoggableMessage` allow-list). |
| **buddy-salt** | Retired in 2.1.97 — companion system rewritten with crypto-based random name generator for session files, hardcoded salt removed. |

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

## Feature Flag Inventory

`scan-feature-flags.js` extracts all GrowthBook feature flags from a prettified bundle, detecting the gate function name dynamically (it changes every build). Run it standalone or let `--port` handle it automatically.

```bash
# Scan the current native build
node scan-feature-flags.js cli.js.native.pretty --save patches/<version>/flags.json

# Diff against a prior version's inventory
node scan-feature-flags.js cli.js.native.pretty --diff patches/<prev>/flags.json
```

`--port` generates `patches/<version>/flags.json` automatically and, when a previous version's inventory exists, writes `patches/<version>/diff-<prevVersion>.json` alongside a summary in the port output. The saved inventory includes the gate function name, per-flag defaults and line numbers, and a `defaultShapes` index grouping non-obvious default values by class.

See `feature-flags-2.1.143.md` in the vault for the current flag map.

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for patch development, porting to new CC versions, and troubleshooting.

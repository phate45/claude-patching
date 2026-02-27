# Plan: Feature Flag Toggles + Expressive Tone Patch

## Context

Three feature flags discovered during 2.1.62 research control useful behavior locked behind server-side gates with no env var bypass: `tengu_mulberry_fog` (richer memory management prompt), and `tengu_session_memory` + `tengu_sm_compact` (structured session memory compaction). The retired `tengu_oboe` auto-memory patch (`patch-auto-memory.js`) uses the exact same pattern — replace `IL("flag",!1)` with `!0`. Rather than creating three separate patches, we repurpose the auto-memory slot into a general "feature flag toggles" patch.

Separately, the system prompt's "# Tone and style" section contains two expression constraints that limit Claude's authentic communication: a blanket emoji ban ("Only use emojis if the user explicitly requests it") and a blunt brevity directive ("Your responses should be short and concise"). These are corporate safety blanket instructions — they don't protect the harness or tool mechanics, they just flatten Claude's voice. New prompt patches replace both with more permissive language that lets Claude communicate naturally. These patches stand on their own — no CLAUDE.local.md required.

## Phase 1: Feature Flag Toggles Patch

### File: `patches/2.1.62/patch-feature-flag-toggles.js` (new)

Multi-point patch following the `patch-quiet-notifications.js` pattern (multiple coordinated replacements, counted).

**Patch points:**

| # | Flag | Occurrences | Pattern (minified) | Replacement |
|---|------|-------------|---------------------|-------------|
| 1 | `tengu_mulberry_fog` | 2 (native), 2 (bare) | `([$\w]+)\("tengu_mulberry_fog",!1\)` | `!0` |
| 2 | `tengu_session_memory` | 2 (native), 2 (bare) | `([$\w]+)\("tengu_session_memory",!1\)` | `!0` |
| 3 | `tengu_sm_compact` | 1 (native), 1 (bare) | `([$\w]+)\("tengu_sm_compact",!1\)` | `!0` |

Each point uses `replaceAll` with a regex to catch all call sites. The replacement is `!0` — a truthy value that the surrounding conditionals consume as-is.

**Structure:**
```javascript
const flags = [
  { name: 'tengu_mulberry_fog',   label: 'rich memory prompt',          expected: 2 },
  { name: 'tengu_session_memory', label: 'session memory',              expected: 2 },
  { name: 'tengu_sm_compact',     label: 'session memory compaction',   expected: 1 },
];

for (const flag of flags) {
  const pattern = new RegExp(`([$\\w]+)\\("${flag.name}",!1\\)`, 'g');
  const matches = [...content.matchAll(pattern)];
  // verify count, report via output.discovery(), replace all
  content = content.replace(pattern, '!0');
}
```

Expected counts are advisory — warn if mismatch, don't fail (future versions may add/remove call sites).

**Kill switches preserved:**
- `tengu_mulberry_fog`: No env var — controlled entirely by the flag. Our patch makes it always-on.
- Session memory: `DISABLE_CLAUDE_CODE_SM_COMPACT=1` env var still works — the `X2$()` gate checks it before the flags.

### File: `patches/2.1.62/index.json` (modify)

Add `feature-flag-toggles` to common patches. Keep the auto-memory note explaining the evolution:

```json
{
  "id": "feature-flag-toggles",
  "file": "2.1.62/patch-feature-flag-toggles.js"
}
```

Update notes:
```json
"auto-memory": "tengu_oboe removed in 2.1.59. Replaced by feature-flag-toggles patch.",
"feature-flag-toggles": "Enables: mulberry_fog (rich memory), session_memory + sm_compact (structured compaction)"
```

## Phase 2: Expressive Tone Prompt Patches

### Current state in `vw1()` (line 186357):

```javascript
let H = [
  "Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.",
  IL("tengu_bergotte_lantern", !1)
    ? "<bergotte text — suppresses inner monologue>"  // patched by cli-format-instruction
    : "Your responses should be short and concise.",   // ← DEFAULT, what users actually see
  "When referencing specific functions...",             // removed by code-references patch
  "Do not use a colon before tool calls..."            // kept — harness mechanic, not expression
];
```

Two new prompt patches targeting the expression constraints. The tool-call colon rule stays (it's about rendering, not voice).

### Patch A: `expressive-tone.{find,replace}.txt`

**find:**
```
Your responses should be short and concise.
```

**replace:**
```
Express yourself naturally and match depth to complexity. Be thorough when the task warrants it, concise when it doesn't.
```

- Removes blanket brevity pressure
- Gives latitude on complex topics while still signaling conciseness isn't forbidden
- Doesn't conflict with bergotte_lantern's branch (separately patched by cli-format-instruction, and won't fire since we're NOT enabling that flag)

### Patch B: `natural-emojis.{find,replace}.txt`

**find:**
```
Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
```

**replace:**
```
Use emojis naturally to enhance communication.
```

- Removes the blanket ban
- Permits emojis as a natural expressive tool without mandating or restricting them
- No "sparingly" qualifier — that's just another form of restriction

### File: `patches/2.1.62/prompt-patches/patches.json` (modify)

Add both `expressive-tone` and `natural-emojis` to the ordered patch list.

## Files Modified

| File | Action |
|------|--------|
| `patches/2.1.62/patch-feature-flag-toggles.js` | **Create** — multi-point flag toggle patch |
| `patches/2.1.62/index.json` | **Edit** — add feature-flag-toggles, update notes |
| `patches/2.1.62/prompt-patches/expressive-tone.find.txt` | **Create** |
| `patches/2.1.62/prompt-patches/expressive-tone.replace.txt` | **Create** |
| `patches/2.1.62/prompt-patches/natural-emojis.find.txt` | **Create** |
| `patches/2.1.62/prompt-patches/natural-emojis.replace.txt` | **Create** |
| `patches/2.1.62/prompt-patches/patches.json` | **Edit** — add expressive-tone + natural-emojis |

## Verification

1. `node claude-patching.js --check --native` — all patches pass including new feature-flag-toggles (expect 5 replacements) and 60/60 prompt patches (58 existing + 2 new)
2. `node claude-patching.js --check --bare` — same (occurrence counts may differ between bare/native)
3. `node claude-patching.js --apply --native` — apply and verify binary runs: `~/.local/bin/claude --version`
4. `node --check` on patched cli.js — no syntax errors

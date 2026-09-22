---
name: porting-patches
description: Port the patch set to a new Claude Code version. Use when a new CC version has dropped and patches need re-fitting to the changed bundle — drives the --port pipeline, reads its broken-patch work order, and walks each JS-patch fix. For prompt-patch (prompt-slim) failures specifically, use the upgrade-prompt-patches skill instead.
argument-hint: "[--native|--bare]"
allowed-tools: Bash(node *) Bash(rg *) Bash(grep *) Bash(jq *) Read Edit Write
---

# Porting Patches to a New CC Version

## Current state

!`node claude-patching.js --status 2>/dev/null | tail -1 | jq -r '.installs | to_entries[] | "\(.key): v\(.value.version) — \((.value.patches // []) | length) patches applied"' 2>/dev/null || echo "run: node claude-patching.js --status"`

## The one command

```bash
node claude-patching.js --port                 # or --native / --bare if both installs exist
```

`--port` runs **setup → init → flag scan → env scan → check → changelog scan → work order** in one pass and is idempotent. It regenerates `.pretty`/`.original` workspace files, creates `patches/<newVersion>/` (copying the latest index + prompt patches), and — crucially — ends with a **broken-patch work order**: everything you need to start fixing, per patch, in one place. No cross-referencing artifacts by hand.

## Reading the work order (NDJSON `type:"port_broken"`)

Each broken patch is one record:

| Field | What it gives you |
|-------|-------------------|
| `id` | patch id |
| `file` | source path — your **jump target** (already the fork if one exists) |
| `reason` | `pattern not found` / hard failure |
| `found` | discovery lines the patch emitted **before** it died — how far it got. This localises the break (e.g. code-blocks *found* the hljs getter + ANSI comp, *died* on the wrapper) |
| `expected` | the patch's own `Expected: …` hints — the shape it was hunting |
| `changelog` | top 1–2 changelog matches (BM25) — **triage**, not verdict |

Pull it precisely with jq:

```bash
node claude-patching.js --native --port 2>&1 | grep '"type":"port_broken"' | jq -r '.orders[] | "\(.id)  →  \(.file)\n  found: \(.found | join(" · "))\n  hint:  \(.expected[0] // "")\n  cl:    \(.changelog[0].bullet // "no match")"'
```

## prompt-slim: any drift fails the check

`prompt-slim` applies the version's prompt find/replace pairs. On `--check` it **fails on any drift** — less than the full count (N/N) exits non-zero, so prompt-slim lands in `failed` / the work order like any broken patch and `success` stays false:

```
✗ prompt-slim: 58/67 prompt patches (9 diverged) — port not complete
```

(`--apply` stays lenient: it applies the pairs that match and warns on the rest, so a partial set is still usable — but the port is not *done* until N/N.)

Fixing prompt-slim is a different job from the JS regex fixes — it's diverged prompt *text*, driven by its own skill. Handle it in the **prompt-patch-fixing phase** below, after the JS patches are green.

## Changelog triage: signal vs. noise

The changelog match is a **triage aid, not a verdict** (see `.claude/rules/reference-repos.md` and the CLAUDE.md "Changelog Impact" section). Every patch matches *something* — read the relative ranking and expect a noise floor.

Three real categories (from experience):

- **Signal** — the top match names the actual cause. These are *feature reworks* visible in the changelog: e.g. "upgrading to highlight.js 11" (broke code-blocks + keyword-highlights), "background agent notifications" (broke quiet-notifications). Read the bullet; it tells you what to look for.
- **Semi** — related theme, wrong specifics (a nearby env-var/flag change).
- **Noise** — the real cause was a **silent** minifier/refactor change with no changelog footprint (brace-wrapped return, `let`→`const`, a gate gaining a condition). The tool *cannot* surface a cause that isn't written down. Most breaks are these.

The committed `patches/<version>/changelog-impact.json` has a **`reasoning` block** — fill it in with per-patch signal/noise verdicts as you go. That accumulated judgement is the real "less noisy next time" mechanism.

```bash
jq -r '.patchImpacts[] | select(.broken) | "\(.id): \(.matches[0].bullet // "no match")"' patches/<version>/changelog-impact.json
jq '.reasoning' patches/<version>/changelog-impact.json     # prior verdicts, if any
```

## Fixing one broken JS patch — the loop

1. **Read the patch file** (`file` from the work order). Find its find-pattern(s) and the anchor string(s) it keys on.
2. **Find the new form in the bundle.** Anchor on a stable literal (a quoted string, a prop name), not minified vars:
   ```bash
   grep -oP 'anchorString.{0,300}' cli.js.native.original | head        # minified — what the regex matches
   # for template literals with real newlines, extract with node + JSON.stringify:
   node -e 'const c=require("fs").readFileSync("cli.js.native.original","utf8");const i=c.indexOf("ANCHOR");process.stdout.write(JSON.stringify(c.slice(i-40,i+400)))'
   ```
   Use `.pretty` (js-beautify) for reading structure, `.original` for byte-exact pattern verification.
3. **Diff old vs new** — the break is usually one of these shapes (all seen in real ports):
   - brace-wrapped return: `if(x)return y;` → `if(x){return y}` (JSX / hljs render reworks)
   - `let`→`const` on a scalar-props line; a var declaration relocating
   - ternary → direct return, or call-form → template literal (`Fn(Fn())` → `` `…${Fn()}.` ``)
   - a gate gaining a condition: `if(!X())` → `if(!X()||Y())`
   - a feature going **native-but-gated**: CC now does what your patch did, behind `USER_TYPE==="ant"` or a `notified` flag that DCEs to a dead early-return in public builds. Work *with* it — un-gate / populate — don't duplicate.
4. **Fork, never edit legacy.** Copy the patch to `patches/<newVersion>/js-patches/patch-<name>.js`, fix the regex there, and repoint only that entry in `patches/<newVersion>/index.json`. Older version dirs stay verbatim (they support older CC). See `.claude/rules/patch-format.md`.
5. **Capture minified names, never hardcode them** in replacements — a structurally-identical site in a *renamed* scope passes `--check` but binds the wrong variable at runtime. See `.claude/rules/patch-format.md` (the `thinking-no-fold` cautionary tale).
6. **Verify:**
   ```bash
   node --check patches/<newVersion>/js-patches/patch-<name>.js                          # syntax
   CLAUDECODE=1 node patches/<newVersion>/js-patches/patch-<name>.js --check cli.js.native.original   # one patch
   node claude-patching.js --native --check                                              # whole set
   ```
   Repeat until every JS patch passes. (`--check` also fails on prompt-slim drift; that's fixed separately in the prompt-patch-fixing phase below, not with a regex tweak.)

## Prompt-patch-fixing phase (after the JS patches are green)

Do this **after** every JS patch passes — prompt patches are text, not minified structure, and interleaving them with the JS regex work just adds noise. When prompt-slim shows drift (< N/N):

1. **Invoke the `upgrade-prompt-patches` skill.** It's built for exactly this: it reads prompt-slim's `diverged` / `chained` / `not found` diagnostics and walks each failing find/replace pair (placeholder engine `${var}`/`__NAME__`, whitespace/backtick gotchas, restructured array boundaries).
2. Re-run `--check` until prompt-slim reads N/N.

## The completion gate — run `--check` before reporting done

`--port` does **not** run the chunk-scope stage (it roughly doubles the runtime, and a cross-chunk reference is only actionable once the patterns match). So a green `--port` is not a finished port. Run the standalone check as the last act, every time:

```bash
node claude-patching.js --native --check
```

The port is done when that one command reports `success:true`, which means all three of:

- every JS patch pattern matched,
- prompt-slim at full count (N/N — any drift fails),
- **no cross-chunk references** — no identifier injected into a Bun chunk that has no binding for it.

That third one is the whole reason this gate exists. It is invisible to everything else: the pattern matched (in the wrong scope), the file parses, the binary assembles and loads, and then it throws `ReferenceError` the first time that expression is evaluated — which may be a tool description built mid-session, killing the session from that point on. See the cross-chunk rule in `.claude/rules/patch-format.md` for the `globalThis` bridge that fixes it.

Findings arrive as `type:"chunk_scope"` and also land in the summary's `failed`:

```bash
node claude-patching.js --native --check 2>&1 | grep '"type":"chunk_scope"' | jq -c '.findings[]'
```

The scan needs an **unpatched** binary for chunk boundaries (patching shifts them). It uses `install.path` when clean, else `install.path + '.bak'`. With neither it emits `chunk_scope_skipped` — treat that as *not verified*, not as a pass, and re-run after `--restore`.

## New knobs / new patches

If the port also adds a new patch (a knob for a new upstream feature, etc.): write it under `patches/<newVersion>/js-patches/`, push an entry into `index.json` **and** add a one-line `notes[<id>]` there (the changelog scanner reads notes), then document it in `README.md` under the right section.

## The leaked source caveat

`src/` (gitignored) is a **~2.1.120 snapshot — ~90 versions stale**. Use it for *shape* only: file layout, function intent, which subsystem owns what. Every exact detail — gate conditions, env-var names, ternary shapes, minified structure — must be verified against `cli.js.native.pretty`/`.original`. The leaked ternary tells the story; the current bytes tell the truth.

## Apply and finish

Clear the completion gate above first — `--apply` does not run the chunk-scope scan, so applying on an unverified set ships the failure into the binary.

```bash
node claude-patching.js --native --apply       # syntax-checked + auto-rollback on failure
```

`--apply` fails with `ETXTBSY` if a running Claude instance holds the binary — close sessions first (or run from outside an active session). Iterating on an already-applied patch? Use `--restore --apply` to reset from `.bak` first (the metadata gate skips already-listed ids otherwise). Then confirm the binary loads: suggest the user run `! claude --version`.

Finally: fill the `changelog-impact.json` reasoning block, update `README.md`, and consider a work log (`writing-work-logs` skill) + memory note for anything non-obvious.

## Deep-dive references

- **Prompt-patch failures** (`prompt-slim`) → the `upgrade-prompt-patches` skill (placeholder engine, whitespace/backtick gotchas).
- **Writing a brand-new patch** → the `creating-patches` skill.
- **Patch contract, index.json, fork convention** → `.claude/rules/patch-format.md`.
- **cli.js exploration, TUI render paths** → `.claude/rules/code-exploration.md`.
- **Native binary format / size budget** → `.claude/rules/native-binary.md`.
- **Full porting narrative + troubleshooting** → `DEVELOPMENT.md` and the "Porting to a New CC Version" section of `CLAUDE.md`.

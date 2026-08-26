#!/usr/bin/env node
/**
 * patch-disable-bundled-skills.js  (2.1.246 re-port)
 *
 * Lets you disable *bundled* skills at runtime via an env var, so they never
 * register — meaning they vanish from both the model's skill_listing context
 * AND the user-facing /slash command surface. Built-in clutter, gone.
 *
 * This is the registration-time, bundled-only lever. For session/profile
 * filtering of ANY skill (bundled, project, user, plugin) by name without
 * unregistering, see patch-disable-skills.js (CLAUDE_CODE_DISABLED_SKILLS).
 *
 * ── Why this file is a 2.1.246 fork ─────────────────────────────────────────
 * The 2.1.162 patch anchored on the registrar's `let{files:$}=H,` head. In
 * 2.1.246 the skill module was restructured and that idiom now belongs to a
 * DIFFERENT function — `qs(r)` (exported `wireSkillFilesExtraction`), a prompt/
 * files builder that RETURNS `{skillRoot,getPromptForCommand}` and is consumed
 * by the registrar via `let{skillRoot:a,getPromptForCommand:u}=qs(r)`. Injecting
 * a bare `return;` there makes `qs` yield `undefined`, so the destructure throws
 * (`Cannot destructure property 'skillRoot' of undefined`) during startup
 * command-building — crashing the whole session (empty --print) the moment any
 * bundled skill is disabled. `--check` passed only because the stale pattern
 * still MATCHED (the wrong function); the break is purely at runtime.
 *
 * ── Correct 2.1.246 mechanism ───────────────────────────────────────────────
 * The real registrar is `Zo(r)` (exported `registerBundledSkill`): it builds the
 * skill object (`source:"bundled"`, `loadedFrom:"bundled"`) and pushes it onto
 * the `bundledSkills` registry array — `H().bundledSkills.push(h)`. It is a VOID
 * funnel: every per-skill `registerXSkill()` calls it as a bare statement and its
 * return value is never consumed, so a top-of-function `return;` cleanly aborts
 * before the push. Only bundled skills flow through `Zo`; user/project/plugin
 * skills use other registrars tagged `source:"skills"|"plugin"|"builtin"|…`, so
 * they are untouched. A name skipped here never enters `H().bundledSkills` and is
 * invisible to every consumer — exactly the old behavior.
 *
 * Usage:
 *   # disable a specific set (comma-separated, whitespace-tolerant)
 *   CLAUDE_CODE_DISABLED_BUNDLED_SKILLS='claude-api,design-sync,debug' claude
 *
 *   # sentinel: disable ALL bundled skills at once
 *   CLAUDE_CODE_DISABLED_BUNDLED_SKILLS='*' claude
 *
 * When the env var is unset, behavior is unchanged.
 *
 * Patch invocation:
 *   node patch-disable-bundled-skills.js <cli.js path>
 *   node patch-disable-bundled-skills.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-disable-bundled-skills.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Match the bundled-skill registrar `Zo(r)` by its unique head: it destructures
// `{skillRoot,getPromptForCommand}` off a builder call on the param, then opens
// the skill object with `{type:"prompt",name:PARAM.name,`. Captures:
//   $1 = registrar name (Zo)
//   $2 = parameter name (r)  — the skill definition, carrying `.name`
const pattern = /function ([\w$]+)\(([\w$]+)\)\{let\{skillRoot:[\w$]+,getPromptForCommand:[\w$]+\}=[\w$]+\(\2\),[\w$]+=\{type:"prompt",name:\2\.name,/;

const match = content.match(pattern);

if (!match) {
  output.error('Could not find bundled-skill registrar (Zo)', [
    'Expected: function X(r){let{skillRoot:a,getPromptForCommand:u}=qs(r),h={type:"prompt",name:r.name,...',
    'The bundled-skill registration structure may have changed',
    'NOTE: do NOT match the `let{files:$}=param` head — in 2.1.246 that is qs(), the files builder, not the registrar',
  ]);
  process.exit(1);
}

const [original, fnName, param] = match;

// Already-patched marker
if (content.includes('globalThis.__disabledBundledSkills')) {
  output.result('dry_run', 'bundled-skill registrar already patched with disable list');
  process.exit(0);
}

output.discovery('bundled-skill registrar', fnName, {
  parameter: param,
  'env var': 'CLAUDE_CODE_DISABLED_BUNDLED_SKILLS',
  sentinel: '* disables all bundled skills',
});

// Lazy-init the disable set once into globalThis. The sentinel "*" stores
// boolean true (disable everything); otherwise a Set of trimmed names. Unset
// env yields an empty Set, so the guard never fires.
const injection =
  `if(globalThis.__disabledBundledSkills===void 0){` +
    `let _e=process.env.CLAUDE_CODE_DISABLED_BUNDLED_SKILLS;` +
    `globalThis.__disabledBundledSkills=_e?(_e.trim()==="*"?!0:new Set(_e.split(",").map((s)=>s.trim()))):new Set` +
  `}` +
  `if(globalThis.__disabledBundledSkills===!0||globalThis.__disabledBundledSkills.has(${param}.name))return;`;

// Re-emit the matched head with the guard inserted right after `){`.
const headEnd = `function ${fnName}(${param}){`;
const replacement = headEnd + injection + original.slice(headEnd.length);

output.modification('skill registrar', original, replacement);

if (dryRun) {
  output.result('dry_run', `Bundled-skill registrar found (${fnName}) — ready to patch`);
  process.exit(0);
}

// Function replacer: minified identifiers contain `$`, which would otherwise be
// read as replacement patterns.
content = content.replace(original, () => replacement);

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Patched bundled-skill registrar (${fnName}) in ${targetPath}`);
  output.info("Set CLAUDE_CODE_DISABLED_BUNDLED_SKILLS to a comma-separated list of bundled skill names");
  output.info("Use '*' to disable all bundled skills at once");
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * patch-disable-bundled-skills.js
 *
 * Lets you disable *bundled* skills at runtime via an env var, so they never
 * register — meaning they vanish from both the model's skill_listing context
 * AND the user-facing /slash command surface. Built-in clutter, gone.
 *
 * This is the registration-time, bundled-only lever. For session/profile
 * filtering of ANY skill (bundled, project, user, plugin) by name without
 * unregistering, see patch-disable-skills.js (CLAUDE_CODE_DISABLED_SKILLS).
 *
 * Supersedes patch-disable-claude-api-skill.js (which nop'd one wrapper). To
 * drop claude-api, just include it in the CSV below.
 *
 * Mechanism: every bundled skill funnels through the single registrar Mz(H),
 * which builds the skill object and pushes it onto the registry array
 * (Y69.push(_)). We inject a guard at the very top of Mz that aborts before
 * the push when H.name is blocked. Mz hardcodes source:"bundled", so this
 * only ever affects bundled skills — user/project skills use a different
 * registrar and are untouched.
 *
 * No code in the bundle hard-references a bundled skill by name
 * (e.g. .name==="simplify"), and several skills are already conditionally
 * skipped via isEnabled/flags/env gates, so "not registered" is a fully
 * supported state — aborting registration is equivalent to the skill never
 * existing.
 *
 * Usage:
 *   # disable a specific set (comma-separated, whitespace-tolerant)
 *   CLAUDE_CODE_DISABLED_BUNDLED_SKILLS='claude-api,design-sync,debug,run-skill-generator' claude
 *
 *   # sentinel: disable ALL bundled skills at once
 *   CLAUDE_CODE_DISABLED_BUNDLED_SKILLS='*' claude
 *
 * When the env var is unset, behavior is unchanged.
 *
 * Known literal skill names (others register under computed names — block
 * those by their resolved name as shown in the skill listing):
 *   batch, claude-api, claude-in-chrome, debug, design-sync,
 *   fewer-permission-prompts, keybindings-help, loop, run,
 *   run-skill-generator, schedule, simplify, update-config
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

// Match the bundled-skill registrar by its unique head: a function whose
// first statement destructures `files` off the parameter
//   function Mz(H){let{files:$}=H,...
// Captures:
//   $1 = function name (Mz)
//   $2 = parameter name (H)
const pattern = /function ([\w$]+)\(([\w$]+)\)\{let\{files:[\w$]+\}=\2,/;

const match = content.match(pattern);

if (!match) {
  output.error('Could not find bundled-skill registrar (Mz)', [
    'Expected: function X(H){let{files:$}=H,...',
    'The skill registration structure may have changed',
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

// Function replacer: minified identifiers and the `{files:$}` destructure
// contain `$`, which would otherwise be read as replacement patterns.
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

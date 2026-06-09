#!/usr/bin/env node
/**
 * patch-disable-skills.js
 *
 * Session-scoped, source-agnostic skill filtering — the "Claude Code Profiles"
 * lever. Disable ANY skill by name (bundled, project, user, or plugin) for the
 * current session via an env var, so it drops out of both the model's
 * skill_listing context AND the /slash surface, WITHOUT unregistering it.
 *
 * Use case: per-project, per-session profiles. In an implementation session you
 * might not want `code-review` sitting in context; in a review session you do.
 * Flip the env var per profile — no rebuild, no permanent change.
 *
 *   CLAUDE_CODE_DISABLED_SKILLS='code-review,security-review,deep-research' claude
 *
 * Difference from patch-disable-bundled-skills.js:
 *   - bundled patch blocks at REGISTRATION (Mz) — bundled-only, permanent removal
 *     from the command registry. Heavier lever for built-in clutter you never want.
 *   - THIS patch filters the already-assembled, deduped command list — any source,
 *     keeps the skill registered, just hides it for this session. The profile lever.
 *
 * Mechanism: all skill/command sources (skillDirCommands, pluginSkills,
 * bundledSkills, builtinPluginSkills + dynamic) are merged once in the memoized
 * loader RC8 into a single list:
 *
 *   let Y=Ei([...q,...z,...A,...K,..._,...f,...Tm$()]);return ...
 *
 * The flatten helper is renamed each version (ll -> Ei in 2.1.170); the
 * pattern captures it instead of hardcoding the name.
 *
 * Both the skill_listing attachment (RC8 -> PP -> wP -> iT8) and /slash
 * resolution read from this list, so filtering Y here is the single chokepoint
 * that covers every downstream consumer. We splice a name-based filter in
 * between the `;` and the `return` (never inside the comma-let above it).
 *
 * Patch invocation:
 *   node patch-disable-skills.js <cli.js path>
 *   node patch-disable-skills.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-disable-skills.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Match the merged-command-list assignment inside RC8, anchored on the
// distinctive `<helper>([...spread,...spread,...,...call()])` flatten followed
// immediately by `);return `. Only one site in the bundle matches.
// Captures:
//   $1 = list variable name (Y)
//   $2 = flatten helper name (ll, Ei, ... — renamed per version)
//   $3 = the full array literal, re-emitted verbatim
const pattern = /([\w$]+)=([\w$]+)\((\[(?:\.\.\.[\w$]+(?:\(\))?,)+\.\.\.[\w$]+(?:\(\))?\])\);return /;

const match = content.match(pattern);

if (!match) {
  output.error('Could not find merged command/skill list (RC8 flatten)', [
    'Expected: Y=ll([...a,...b,...,...z()]);return ...',
    'The command-loader merge structure may have changed',
  ]);
  process.exit(1);
}

const [original, listVar, helper, arrLiteral] = match;

// Already-patched marker
if (content.includes('globalThis.__disabledSkills')) {
  output.result('dry_run', 'command list already patched with session skill filter');
  process.exit(0);
}

output.discovery('merged command/skill list', listVar, {
  helper: `${helper}(...)`,
  'env var': 'CLAUDE_CODE_DISABLED_SKILLS',
});

// Lazy-init the disable Set once into globalThis (trimmed, empties dropped).
// Filter the merged list by command name. Unset/empty env => empty Set =>
// the size check short-circuits and the list is untouched.
const filter =
  `if(globalThis.__disabledSkills===void 0){` +
    `let _e=process.env.CLAUDE_CODE_DISABLED_SKILLS;` +
    `globalThis.__disabledSkills=_e?new Set(_e.split(",").map((s)=>s.trim()).filter(Boolean)):new Set` +
  `}` +
  `if(globalThis.__disabledSkills.size)${listVar}=${listVar}.filter((c)=>!globalThis.__disabledSkills.has(c.name));`;

// Re-emit `Y=<helper>([...]);` + filter + `return ` (splice between ; and
// return, keeping the preceding comma-let declaration intact).
const replacement = `${listVar}=${helper}(${arrLiteral});${filter}return `;

output.modification('command list filter', original, replacement);

if (dryRun) {
  output.result('dry_run', `Merged command list found (${listVar}) — ready to patch`);
  process.exit(0);
}

// Function replacer: minified identifiers contain `$`, which would otherwise
// be read as replacement patterns ($&, $1, ...).
content = content.replace(original, () => replacement);

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Patched merged command list (${listVar}) in ${targetPath}`);
  output.info('Set CLAUDE_CODE_DISABLED_SKILLS to a comma-separated list of skill names to hide this session');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

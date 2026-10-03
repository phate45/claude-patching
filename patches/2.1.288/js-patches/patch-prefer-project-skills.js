#!/usr/bin/env node
/**
 * prefer-project-skills — let a project skill beat a same-named personal skill,
 * per name, via an env var.
 *
 *   CLAUDE_CODE_PREFER_PROJECT_SKILLS='deploy,review' claude
 *   CLAUDE_CODE_PREFER_PROJECT_SKILLS='*' claude       (every collision)
 *
 * Native precedence is pure list order, not a rule. The skill-dir loader
 * (F1o @459861 in 2.1.284) builds
 *     ve=[...policy,...user,...synced,...project.flat(),...addDir.flat(),...legacy]
 * and only dedupes by file identity (same realpath). Both same-named skills
 * survive; every consumer then resolves first-match — slash lookup Js() takes
 * the first exact name, the skill_listing merge dedupes by name keeping the
 * first — so user wins only because it is spread first.
 *
 * The patch filters the user spread: a user skill is dropped when its name is
 * in the env set (or the set holds `*`) AND a project or --add-dir skill with
 * the same name was loaded. Dropping (rather than reordering) leaves exactly
 * one skill of that name for every consumer, including ones that walk the
 * full list. Policy skills stay first and untouched; synced and legacy
 * commands are out of scope. Each drop is logged through the loader's own
 * debug logger (captured from the `Loading skills from:` line) so --debug
 * shows why a personal skill went missing.
 *
 * Reads process.env, not the minified env mirror: the mirror only exposes
 * getters for names CC knows about. All captures live in the same function,
 * so the injection is chunk-local.
 *
 * Usage:
 *   node patch-prefer-project-skills.js <cli.js path>
 *   node patch-prefer-project-skills.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-prefer-project-skills.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// ── Discovery: the loader's debug logger ──
const logMatches = [...content.matchAll(/([\w$]+)\(`Loading skills from:/g)];
if (logMatches.length !== 1) {
  output.error(`Skill loader log line: expected 1 match, found ${logMatches.length}`, [
    'Expected: t(`Loading skills from: managed=${s}, user=${r}, project=[…]`) in the skill-dir loader',
  ]);
  process.exit(1);
}
const log = logMatches[0][1];
output.discovery('loader logger', log);

// ── Patch Point: filter the user spread in the merged skill list ──
// Match the head `be=[...POLICY,...USER,...SYNCED,...PROJECT.flat(),...ADDDIR.flat(),`.
// The sources after add-dir (legacy commands, and since 2.1.288 plugin
// commands) are left untouched, so a newly appended source does not break the anchor.
const pattern =
  /([\w$]+)=\[\.\.\.([\w$]+),\.\.\.([\w$]+),\.\.\.([\w$]+),\.\.\.([\w$]+)\.flat\(\),\.\.\.([\w$]+)\.flat\(\),/g;
const matches = [...content.matchAll(pattern)];

if (matches.length !== 1) {
  output.error(`Merged skill list: expected 1 match, found ${matches.length}`, [
    'Expected: be=[...B,...H,...K,...V.flat(),...he.flat(),… in the skill-dir loader',
    'The loader may have reordered or added a source',
  ]);
  process.exit(1);
}

const [full, list, policy, user, synced, project, addDir] = matches[0];
output.discovery('merged skill list', full, { user, project, 'add-dir': addDir });

// Sanity: the logger and the list must sit in the same function — the list
// follows the log line within a few KB.
const gap = matches[0].index - logMatches[0].index;
if (gap < 0 || gap > 4000) {
  output.error(`Log line and merged list are ${gap} chars apart — not the same loader`);
  process.exit(1);
}

const filtered =
  `((_f,_p)=>{if(!_p)return _f;` +
  `let _s=new Set(_p.split(",").map(_n=>_n.trim())),` +
  `_j=new Set([...${project}.flat(),...${addDir}.flat()].map(_o=>_o.skill.name));` +
  `return _f.filter(_o=>{let _n=_o.skill.name;` +
  `return!((_s.has("*")||_s.has(_n))&&_j.has(_n)&&(${log}(\`[skills] preferring project skill '\${_n}' over user skill\`),1))})})` +
  `(${user},process.env.CLAUDE_CODE_PREFER_PROJECT_SKILLS)`;
const replacement =
  `${list}=[...${policy},...${filtered},...${synced},...${project}.flat(),...${addDir}.flat(),`;

content = content.replace(full, () => replacement);
output.modification('user skills yield to same-named project skills (env-gated)', full, replacement);

if (dryRun) {
  output.result('dry_run', 'prefer-project-skills: 1/1 patches verified');
} else {
  fs.writeFileSync(targetPath, content, 'utf8');
  output.result('success', 'prefer-project-skills: 1/1 patches applied');
}

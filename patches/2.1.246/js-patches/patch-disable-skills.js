#!/usr/bin/env node
/**
 * patch-disable-skills.js (2.1.246)
 *
 * Session-scoped, source-agnostic skill filtering — the "Claude Code Profiles"
 * lever. Disable ANY skill by name (bundled, project, user, or plugin) for the
 * current session via an env var, so it drops out of both the model's
 * skill_listing context AND the /slash surface, WITHOUT unregistering it.
 *
 *   CLAUDE_CODE_DISABLED_SKILLS='code-review,security-review,deep-research' claude
 *
 * ── 2.1.246 restructure ──────────────────────────────────────────────────
 * The old single RC8 merge chokepoint `l=NM_(M7([...spread]));return` is gone.
 * The merge is now a dedupe-by-name ternary `fwe(N>0?II(lg([...],"name")):
 * lg([...],"name"))` that appears at TWO sites — no longer one shared list:
 *   1. skill_listing attachment builder (Axt): `l=fwe(…);if(e.agentId===void 0)
 *      l=SE(l,bE());let c=UUr(i,e.agentId,l)` — feeds the model's context.
 *   2. command/slash builder: `a=fwe(…),l=t===void 0?SE(a,bE()):a;
 *      return{merged:a,included:l}` — feeds the /slash surface.
 * To keep the documented dual-surface behavior we filter BOTH, keyed off one
 * shared `globalThis.__disabledSkills` Set (global → cross-chunk-safe). Merged-
 * list var names are captured, never hardcoded. Filters splice AFTER each
 * comma-let statement, never inside it.
 *
 * Difference from patch-disable-bundled-skills.js: that blocks at REGISTRATION
 * (bundled-only, permanent); THIS filters the assembled list (any source,
 * session-scoped, keeps registration).
 *
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

if (content.includes('globalThis.__disabledSkills')) {
  output.result('dry_run', 'command list already patched with session skill filter');
  process.exit(0);
}

// Lazy-init the disable Set once (trimmed, empties dropped). Idempotent via the
// void-0 guard, so it is safe to emit at both sites.
const initSet =
  `if(globalThis.__disabledSkills===void 0){` +
    `let _e=process.env.CLAUDE_CODE_DISABLED_SKILLS;` +
    `globalThis.__disabledSkills=_e?new Set(_e.split(",").map((s)=>s.trim()).filter(Boolean)):new Set` +
  `}`;
const filterExpr = (v) => `${v}=${v}.filter((c)=>!globalThis.__disabledSkills.has(c.name))`;

// ── Site 1: skill_listing builder ─────────────────────────────────────────
//   l=fwe(N>0?II(lg([...],"name")):lg([...],"name"));if(e.agentId===void 0)l=SE(l,bE());
const site1 = /([\w$]+)=([\w$]+)\([\w$]+\.length>0\?[\w$]+\([\w$]+\(\[[^\]]+\],"name"\)\):[\w$]+\(\[[^\]]+\],"name"\)\);if\([\w$]+\.agentId===void 0\)\1=[\w$]+\(\1,[\w$]+\(\)\);/;
const m1 = content.match(site1);

if (!m1) {
  output.error('Could not find skill_listing merged list (site 1)', [
    'Expected: l=fwe(N>0?II(lg([...],"name")):lg([...],"name"));if(e.agentId===void 0)l=SE(l,bE());',
    'The skill_listing merge structure may have changed',
  ]);
  process.exit(1);
}

const listVar1 = m1[1];
output.discovery('skill_listing merged list (site 1)', listVar1, {
  helper: `${m1[2]}(...)`,
  'env var': 'CLAUDE_CODE_DISABLED_SKILLS',
});

const repl1 = `${m1[0]}${initSet}if(globalThis.__disabledSkills.size)${filterExpr(listVar1)};`;

// ── Site 2: /slash command builder ────────────────────────────────────────
//   a=fwe(N>0?II(lg([...],"name")):lg([...],"name")),l=t===void 0?SE(a,bE()):a;return{merged:a,included:l}
const site2 = /(([\w$]+)=([\w$]+)\([\w$]+\.length>0\?[\w$]+\([\w$]+\(\[[^\]]+\],"name"\)\):[\w$]+\(\[[^\]]+\],"name"\)\),([\w$]+)=[\w$]+===void 0\?[\w$]+\(\2,[\w$]+\(\)\):\2;)(return\{merged:\2,included:\4\})/;
const m2 = content.match(site2);

if (!m2) {
  output.error('Could not find /slash merged list (site 2)', [
    'Expected: a=fwe(...),l=t===void 0?SE(a,bE()):a;return{merged:a,included:l}',
    'The command-list merge structure may have changed',
  ]);
  process.exit(1);
}

const letTail2 = m2[1];   // ...a=fwe(...),l=...;
const mergedVar = m2[2];  // a
const includedVar = m2[4]; // l
const returnStmt = m2[5]; // return{merged:a,included:l}

output.discovery('/slash merged list (site 2)', mergedVar, {
  'included var': includedVar,
  helper: `${m2[3]}(...)`,
});

const repl2 =
  `${letTail2}${initSet}` +
  `if(globalThis.__disabledSkills.size){${filterExpr(mergedVar)};${filterExpr(includedVar)}}` +
  `${returnStmt}`;

output.modification('skill filter (site 1)', m1[0].slice(0, 60) + '…', repl1.slice(0, 60) + '…');
output.modification('skill filter (site 2)', m2[0].slice(0, 60) + '…', repl2.slice(0, 60) + '…');

if (dryRun) {
  output.result('dry_run', `Both merged-list sites found (${listVar1}, ${mergedVar}) — ready to patch`);
  process.exit(0);
}

content = content.replace(m1[0], () => repl1);
content = content.replace(m2[0], () => repl2);

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Patched both skill-list merge sites in ${targetPath}`);
  output.info('Set CLAUDE_CODE_DISABLED_SKILLS to a comma-separated list of skill names to hide this session');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

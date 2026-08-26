#!/usr/bin/env node
/**
 * Patch: strip noise fields from the system prompt.
 *
 * Three surgical cuts, all in the context-assembly path:
 *
 *   1. userEmail — the user's email is never load-bearing for work; gitStatus
 *      already carries the user's name. Removed from user_context.
 *
 *   2. currentDate — redundant with the UserPromptSubmit hook which fires
 *      on every turn with full Thursday, 2026-04-23 22:07:43 grounding.
 *      The static date goes stale across midnight. Removed from user_context.
 *
 *   3. Model family marketing paragraph ("The most recent Claude models are
 *      the Claude 5 family ... default to the latest and most capable Claude
 *      models.") — relevant only when building Claude apps inside a session,
 *      pure noise for everyone else. The paragraph now lives as the return
 *      value of a memoized helper, called in two environment arrays that are
 *      filtered with .filter((M) => M !== null). Nulling the returned template
 *      makes the helper return null at both sites.
 *
 * 2.1.246 change (patch 1a): the userEmail template literal gained a long
 * privacy addendum — `The user's email address is ${a}. Use it only to identify
 * the user … unless the user explicitly asks.` — so the old regex, which
 * expected the literal to close right after `${a}.`, no longer matched. The
 * pattern now steps over the addendum with a non-greedy `.*?` up to the real
 * closing backtick+brace. currentDate (1b) and the model paragraph (2) are
 * unchanged in shape.
 *
 * Usage:
 *   node patch-trim-context-bloat.js <cli.js path>
 *   node patch-trim-context-bloat.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-trim-context-bloat.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

let patchCount = 0;
const EXPECTED = 3;

// ── Patch 1a: strip the userEmail spread from user_context ──
// Form (2.1.246):
//   ,...a&&{userEmail:`The user's email address is ${a}. Use it only to
//   identify the user … unless the user explicitly asks.`}
// The addendum after `${a}.` is consumed by `.*?` up to the closing backtick.
// The following ,..._&&{attachedProject:_} and preceding ...q&&{claudeMd:q}
// are left untouched.

const siteEmail = /,\.\.\.[$\w]+&&\{userEmail:`The user's email address is \$\{[$\w]+\}\..*?`\}/;
const mEmail = content.match(siteEmail);

if (!mEmail) {
  output.error('Could not find userEmail spread in user_context');
  process.exit(1);
}

output.discovery('userEmail spread', mEmail[0].slice(0, 80) + '...');
content = content.replace(siteEmail, () => '');
patchCount++;
output.modification('strip userEmail', mEmail[0].slice(0, 80) + '...', '<removed>');

// ── Patch 1b: strip the currentDate field (tail of the user_context object) ──
//   ,currentDate:`Today's date is ${V5()}.`
// currentDate is the last field before the object's closing brace, so removing
// the comma-prefixed entry leaves a well-formed object.

const siteDate = /,currentDate:`Today's date is \$\{[$\w]+\(\)\}\.`/;
const mDate = content.match(siteDate);

if (!mDate) {
  output.error('Could not find currentDate field in user_context');
  process.exit(1);
}

output.discovery('currentDate field', mDate[0]);
content = content.replace(siteDate, () => '');
patchCount++;
output.modification('strip currentDate', mDate[0], '<removed>');

// ── Patch 2: null out the model-family paragraph ──
// The paragraph is an array element wrapped in backticks. The array is
// filtered with .filter((M) => M !== null), so replacing the template
// literal with the identifier `(null)` drops it from the output cleanly.

const site2 = /`The most recent Claude models are.*?default to the latest and most capable Claude models\.`/;
const m2 = content.match(site2);

if (!m2) {
  output.error('Could not find model family marketing paragraph');
  process.exit(1);
}

output.discovery('model family paragraph', m2[0].slice(0, 80) + '...');
// Use (null) not bare null: the paragraph sits at `return`...`` (a memoized
// helper), so a bare `null` would weld onto the keyword as `returnnull`.
content = content.replace(site2, () => '(null)');
patchCount++;
output.modification('null out model family paragraph', m2[0].slice(0, 80) + '...', '(null)');

// ── Write ──

if (patchCount !== EXPECTED) {
  output.error(`Expected ${EXPECTED} patches, got ${patchCount}`);
  process.exit(1);
}

if (dryRun) {
  output.result('dry_run', `trim-context-bloat: ${patchCount}/${EXPECTED} patches verified`);
} else {
  fs.writeFileSync(targetPath, content, 'utf8');
  output.result('success', `trim-context-bloat: ${patchCount}/${EXPECTED} patches applied`);
}

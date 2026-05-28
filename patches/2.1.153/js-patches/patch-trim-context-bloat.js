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
 *   3. Model family marketing paragraph ("The most recent Claude model
 *      family is Claude 4.X. ... default to the latest and most capable
 *      Claude models.") — relevant only when building Claude apps inside a
 *      session, pure noise for everyone else. Nulled in the environment
 *      array; the existing .filter((M) => M !== null) drops it cleanly.
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
const EXPECTED = 2;

// ── Patch 1: strip userEmail + currentDate from user_context return ──
// Minified form (2.1.153 added an inert `,...!1` spread between the userEmail
// block and currentDate; we absorb any number of `,...<expr>` spreads):
//   ,...K&&{userEmail:`The user's email address is ${K}.`},...!1,currentDate:S17(OwH())
// We remove the entire comma-prefixed tail; the preceding ...q&&{claudeMd:q}
// becomes the only entry in the returned object.

const site1 = /,\.\.\.[$\w]+&&\{userEmail:`The user's email address is \$\{[$\w]+\}\.`\}(?:,\.\.\.[^,}]+)*,currentDate:[$\w]+\([$\w]+\(\)\)/;
const m1 = content.match(site1);

if (!m1) {
  output.error('Could not find userEmail/currentDate injection in user_context');
  process.exit(1);
}

output.discovery('user_context fields', m1[0].slice(0, 80) + '...');

content = content.replace(site1, () => '');
patchCount++;

output.modification('strip userEmail + currentDate', m1[0], '<removed>');

// ── Patch 2: null out the model-family paragraph ──
// The paragraph is an array element wrapped in backticks. The array is
// filtered with .filter((M) => M !== null), so replacing the template
// literal with the identifier `null` drops it from the output cleanly.

const site2 = /`The most recent Claude model family is Claude 4\.X\. Model IDs[^`]*default to the latest and most capable Claude models\.`/;
const m2 = content.match(site2);

if (!m2) {
  output.error('Could not find model family marketing paragraph');
  process.exit(1);
}

output.discovery('model family paragraph', m2[0].slice(0, 80) + '...');

content = content.replace(site2, () => 'null');
patchCount++;

output.modification('null out model family paragraph', m2[0].slice(0, 80) + '...', 'null');

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

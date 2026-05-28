#!/usr/bin/env node
/**
 * Patch: stop folding thinking blocks into collapsed tool groups.
 *
 * 2.1.153 introduced (or surfaced) a transcript-grouping helper (`XP4`) that
 * runs unconditionally on every render — not just in brief mode. Inside its
 * per-message loop, when a thinking-first assistant message is encountered:
 *
 *   else if (f !== void 0) {
 *     K.latestThinkingSummary = f.text.trim().replace(/\s+/g, " ");
 *     if (z !== void 0) {
 *       let M = Date.parse(Y.timestamp) - Date.parse(z);
 *       if (Number.isFinite(M) && M > 0) K.thoughtForMs += Math.min(M, mU6)
 *     }
 *     K.messages.push(f.message)
 *   }
 *
 * the helper absorbs the thinking message into the currently-accumulating
 * `collapsed_read_search` group (`K`) and bumps `thoughtForMs` / records a
 * one-line summary. The downstream `i54` renderer (~line 373786) then treats
 * the thinking as part of a tool-group pill — rendering "Thought for Ns" with
 * a ctrl+o-to-expand hint instead of the full inline thinking block via
 * `PeH`. The full text only re-appears when verbose/transcript mode is on.
 *
 * Fix: flush the current group and push the thinking message as its own
 * top-level entry. The downstream renderer then dispatches it through the
 * normal `case "thinking"` arm of the message switch, which (with the
 * thinking-visibility patch in place) renders the full reasoning inline.
 *
 * Replacement is byte-equivalent or smaller (we drop the timestamp math and
 * counter bookkeeping, since the pill it fed is no longer rendered for
 * thinking).
 *
 * Usage:
 *   node patch-thinking-no-fold.js <cli.js path>
 *   node patch-thinking-no-fold.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-thinking-no-fold.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Pattern: the entire `else if(f!==void 0){...}` clause inside XP4.
// Captures: 1=fVar, 2=groupVar (K), 3=lastTsVar (z), 4=msgVar (Y), 5=mVar,
//           6=budgetConst (mU6).
const pattern = new RegExp(
  'else if\\(([$\\w]+)!==void 0\\)\\{' +
  'if\\(([$\\w]+)\\.latestThinkingSummary=\\1\\.text\\.trim\\(\\)\\.replace\\(\\/\\\\s\\+\\/g," "\\),' +
  '([$\\w]+)!==void 0\\)\\{' +
  'let ([$\\w]+)=Date\\.parse\\(([$\\w]+)\\.timestamp\\)-Date\\.parse\\(\\3\\);' +
  'if\\(Number\\.isFinite\\(\\4\\)&&\\4>0\\)\\2\\.thoughtForMs\\+=Math\\.min\\(\\4,([$\\w]+)\\)' +
  '\\}\\2\\.messages\\.push\\(\\1\\.message\\)\\}'
);

const match = content.match(pattern);

if (!match) {
  output.error('Could not find XP4 thinking-fold clause', [
    'Expected: else if(f!==void 0){if(K.latestThinkingSummary=f.text...){...}K.messages.push(f.message)}',
    'The transcript grouper may have been restructured',
  ]);
  process.exit(1);
}

const [original, fVar, , , , msgVar] = match;

// `A` is the in-scope helper that flushes K to q (defined just above the loop
// in XP4 as `function A() { ... }`). `q` is the output array.
// The replacement: flush the group, then push the thinking message standalone.
const replacement = `else if(${fVar}!==void 0){A();q.push(${msgVar})}`;

output.discovery('XP4 thinking-fold clause', original.slice(0, 80) + '...', {
  'thinking var': fVar,
  'message var': msgVar,
});

output.modification('replace fold with standalone push',
  original.slice(0, 80) + '...',
  replacement,
);

const patched = content.replace(original, replacement);

if (patched === content) {
  output.error('Patch had no effect');
  process.exit(1);
}

if (dryRun) {
  output.result('dry_run', 'thinking-no-fold patch ready');
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, patched);
  output.result('success', `thinking-no-fold applied to ${targetPath}`);
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

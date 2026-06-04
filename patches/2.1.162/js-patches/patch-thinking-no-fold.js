#!/usr/bin/env node
/**
 * Patch: stop folding thinking blocks into collapsed tool groups. (2.1.162)
 *
 * The transcript-grouping helper that absorbs a thinking-first assistant
 * message into the currently-accumulating `collapsed_read_search` group runs
 * unconditionally on every render. Inside its per-message loop:
 *
 *   else if (O !== void 0) {
 *     K.latestThinkingSummary = O.text.trim().replace(/\s+/g, " ");
 *     if (A !== void 0) {
 *       let M = Date.parse(f.timestamp) - Date.parse(A);
 *       if (Number.isFinite(M) && M > 0) K.thoughtForMs += Math.min(M, Yn6)
 *     }
 *     K.messages.push(O.message)
 *   }
 *
 * the helper bumps `thoughtForMs` / records a one-line summary and the
 * downstream renderer treats the thinking as part of a tool-group pill —
 * rendering "Thought for Ns" with a ctrl+o-to-expand hint instead of the full
 * inline thinking block. The full text only re-appears in verbose/transcript
 * mode.
 *
 * Fix: flush the current group and push the thinking message as its own
 * top-level entry, mirroring the loop's own standalone-flush idiom. The
 * downstream renderer then dispatches it through the normal `case "thinking"`
 * arm (which, with the thinking-visibility patch, renders inline).
 *
 * ── Why this is a fresh copy (vs 2.1.153) ────────────────────────────────
 * The 2.1.153 patch hardcoded the flush helper as `A()` and the output array
 * as `q`, which were the minified names in that version's grouper (`XP4`). In
 * 2.1.162 the grouper was renamed/restructured into `lk4`, where:
 *   - the flush helper is `z()`, not `A()`
 *   - `A` is the *timestamp string* variable (`A = f.timestamp`)
 * so the old hardcoded replacement produced `A()` → calling a date string as
 * a function ("A is not a function ... 'A' is \"2026-...Z\"").
 *
 * This version captures the flush helper and output array from the loop's
 * preceding `else if(pred(loopVar))flush(),out.push(loopVar);` idiom, so the
 * replacement adapts to minifier renames instead of assuming names.
 *
 * Replacement is smaller than the original (drops the timestamp math and
 * counter bookkeeping, since the pill it fed is no longer rendered).
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

// Pattern: the loop's standalone-flush idiom immediately preceding the
// thinking-fold clause, followed by the clause itself. Anchoring on the
// preceding `else if(pred(loopVar))flush(),out.push(loopVar);` lets us capture
// the flush helper + output array by name rather than hardcoding them.
//
// Captures:
//   1 predFn      preceding-branch predicate fn  (e.g. nk4)
//   2 loopVar     per-message loop var           (e.g. f)
//   3 flushFn     group-flush helper             (e.g. z)
//   4 outArr      output array                   (e.g. q)
//   5 fVar        thinking-extract result var    (e.g. O)
//   6 groupVar    accumulating group            (e.g. K)
//   7 lastTsVar   previous-timestamp var         (e.g. A)
//   8 mVar        delta-ms temp                  (e.g. M)
//   9 budgetConst Math.min cap                   (e.g. Yn6)
const pattern = new RegExp(
  'else if\\(([$\\w]+)\\(([$\\w]+)\\)\\)([$\\w]+)\\(\\),([$\\w]+)\\.push\\(\\2\\);' +
  'else if\\(([$\\w]+)!==void 0\\)\\{' +
  'if\\(([$\\w]+)\\.latestThinkingSummary=\\5\\.text\\.trim\\(\\)\\.replace\\(\\/\\\\s\\+\\/g," "\\),' +
  '([$\\w]+)!==void 0\\)\\{' +
  'let ([$\\w]+)=Date\\.parse\\(\\2\\.timestamp\\)-Date\\.parse\\(\\7\\);' +
  'if\\(Number\\.isFinite\\(\\8\\)&&\\8>0\\)\\6\\.thoughtForMs\\+=Math\\.min\\(\\8,([$\\w]+)\\)' +
  '\\}\\6\\.messages\\.push\\(\\5\\.message\\)\\}'
);

const match = content.match(pattern);

if (!match) {
  output.error('Could not find thinking-fold clause', [
    'Expected: else if(pred(f))flush(),q.push(f);else if(O!==void 0){if(K.latestThinkingSummary=O.text...){...}K.messages.push(O.message)}',
    'The transcript grouper may have been restructured',
  ]);
  process.exit(1);
}

const [original, predFn, loopVar, flushFn, outArr, fVar] = match;

// Reproduce the preceding flush idiom verbatim, then replace the thinking
// clause with the same flush-then-standalone-push pattern the loop already
// uses for non-grouped messages.
const replacement =
  `else if(${predFn}(${loopVar}))${flushFn}(),${outArr}.push(${loopVar});` +
  `else if(${fVar}!==void 0){${flushFn}(),${outArr}.push(${loopVar})}`;

output.discovery('thinking-fold clause', original.slice(0, 80) + '...', {
  'flush helper': `${flushFn}()`,
  'output array': outArr,
  'thinking var': fVar,
  'loop var': loopVar,
});

output.modification('replace fold with flush + standalone push',
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

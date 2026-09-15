#!/usr/bin/env node
/**
 * Patch: stop folding thinking blocks into collapsed tool groups. (2.1.246)
 *
 * The transcript-grouping helper absorbs a thinking-first assistant message
 * into the currently-accumulating group. Inside its per-message loop, the
 * thinking clause bumps `thoughtForMs` / records a one-line summary and the
 * downstream renderer treats the thinking as a "Thought for Ns" pill with a
 * ctrl+o-to-expand hint instead of the full inline thinking block.
 *
 * Fix: flush the current group and push the thinking message as its own
 * top-level entry, mirroring the loop's own standalone-flush idiom
 * (`flush(),out.push(loopVar)`). The downstream renderer then dispatches it
 * through the normal `case "thinking"` arm (which, with thinking-visibility,
 * renders inline).
 *
 * ── 2.1.246 changes (vs 2.1.162) ─────────────────────────────────────────
 * 1. The preceding standalone-flush branch's predicate is now COMPOUND
 *    (`else if(Uvt(c)||d!==void 0&&xje(d.message))l(),r.push(c);`) instead of
 *    a single `pred(loopVar)`. We no longer match the predicate at all — we
 *    anchor on the `flush(),out.push(loopVar);` tail that immediately precedes
 *    the thinking clause, capturing flush/out/loopVar there.
 * 2. `latestThinkingSummary` is now assigned via a helper pair
 *    (`let p=lI(am(d.text));if(p)o.latestThinkingSummary=p;`) — the 2.1.234
 *    markdown-aware summary extractor — instead of the old inline
 *    `.text.trim().replace(/\s+/g," ")`. The body pattern matches the new shape.
 *
 * ── 2.1.272 change ────────────────────────────────────────────────────────
 * 3. The summary line now reads/caches off `thinkVar.memo` and uses a `??=`
 *    memo-cache assignment:
 *      let Oe=Re.memo.summary??=Or(gt(Re.memo.thinking));if(Oe)F.latestThinkingSummary=Oe;
 *    (was `let p=lI(am(d.text));if(p)…`). The `.text` read became `.memo.thinking`
 *    behind a `.memo.summary??=` cache. Body pattern updated to match; the
 *    preceding flush tail + thinking-var anchor + replacement are unchanged.
 *
 * Flush helper, output array, loop var and thinking var are all captured (never
 * hardcoded), so the replacement adapts to minifier renames. Same-chunk:
 * everything reused is local to this grouper function.
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

// Anchor on the preceding branch's `flush(),out.push(loopVar);` tail, then the
// full thinking-fold clause (unique: latestThinkingSummary + thoughtForMs).
// Captures:
//   1 flushFn   group-flush helper           (e.g. l)
//   2 outArr    output array                 (e.g. r)
//   3 loopVar   per-message loop var         (e.g. c)
//   4 thinkVar  thinking-extract result var  (e.g. d)
const pattern = new RegExp(
  '([$\\w]+)\\(\\),([$\\w]+)\\.push\\(([$\\w]+)\\);' +
  'else if\\(([$\\w]+)!==void 0\\)\\{' +
  'let [$\\w]+=\\4\\.memo\\.summary\\?\\?=[$\\w]+\\([$\\w]+\\(\\4\\.memo\\.thinking\\)\\);' +
  'if\\([$\\w]+\\)[$\\w]+\\.latestThinkingSummary=[$\\w]+;' +
  'if\\([$\\w]+!==void 0\\)\\{' +
  'let [$\\w]+=Date\\.parse\\(\\3\\.timestamp\\)-Date\\.parse\\([$\\w]+\\);' +
  'if\\(Number\\.isFinite\\([$\\w]+\\)&&[$\\w]+>0\\)[$\\w]+\\.thoughtForMs\\+=Math\\.min\\([$\\w]+,[$\\w]+\\)' +
  '\\}[$\\w]+\\.messages\\.push\\(\\4\\.message\\)\\}'
);

const match = content.match(pattern);

if (!match) {
  output.error('Could not find thinking-fold clause', [
    'Expected: FLUSH(),OUT.push(loopVar);else if(THINK!==void 0){let p=THINK.memo.summary??=Or(gt(THINK.memo.thinking));if(p)K.latestThinkingSummary=p;…K.messages.push(THINK.message)}',
    'The transcript grouper may have been restructured',
  ]);
  process.exit(1);
}

const [original, flushFn, outArr, loopVar, thinkVar] = match;

// Reproduce the preceding flush tail verbatim, then replace the thinking clause
// with the same flush-then-standalone-push the loop already uses.
const replacement =
  `${flushFn}(),${outArr}.push(${loopVar});` +
  `else if(${thinkVar}!==void 0){${flushFn}(),${outArr}.push(${loopVar})}`;

output.discovery('thinking-fold clause', original.slice(0, 80) + '...', {
  'flush helper': `${flushFn}()`,
  'output array': outArr,
  'thinking var': thinkVar,
  'loop var': loopVar,
});

output.modification('replace fold with flush + standalone push',
  original.slice(0, 80) + '...',
  replacement,
);

const patched = content.replace(original, () => replacement);

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

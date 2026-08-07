#!/usr/bin/env node
/**
 * Patch for the sticky previous-prompt header above the transcript viewport.
 *
 * The fullscreen TUI renders a one-line header showing the nearest user
 * prompt that has scrolled off the top of the viewport (click jumps to it).
 * Stock behavior has three problems:
 *
 *   1. It only renders while the viewport is scrolled up (not following the
 *      bottom) — the moment you'd most want it, watching a long response
 *      stream past, it's hidden.
 *   2. The first-visible-item scan has a fallback bug: when the bottom-most
 *      mounted item straddles the viewport top edge (one tall streaming
 *      block filling the screen), the scan breaks on its first iteration and
 *      leaves the first-visible index at the mounted-range start — so the
 *      walk-back either finds nothing (range starts at 0) or an older prompt
 *      than the newest off-screen one. Visible in stock too, when scrolled
 *      up inside a tall block.
 *   3. It renders color:"subtle" text on the userMessageBackground bar —
 *      grey on grey, barely legible in both light and dark themes.
 *
 * Three changes (as of 2.1.220, tracker JVb / renderer QHa):
 *
 *   1. Always-on: drop the !isSticky() guard on the walk-back, so the header
 *      shows whenever the previous prompt is off-screen, including while
 *      following live output. It still hides when the prompt itself is
 *      visible, and click-to-jump is unchanged.
 *   2. Straddle fix: when the bottom-up scan finds nothing fully below the
 *      viewport top edge, treat everything as scrolled off (d = range end)
 *      so the walk-back finds the true newest off-screen prompt.
 *   3. Contrast: pointer in "subtle", prompt text in HEADER_TEXT_COLOR on
 *      the same background — mirroring how transcript user messages render,
 *      one step quieter. "inactive" is the theme's true intermediate between
 *      "text" and "subtle" in both light and dark themes. (Don't reach for
 *      dimColor here: SGR faint rendering is terminal-dependent and can come
 *      out MORE prominent.) Set to "text" for full prompt-strength contrast.
 *
 * Usage:
 *   node patch-sticky-prompt-header.js <cli.js path>
 *   node patch-sticky-prompt-header.js --check <cli.js path>  (dry run)
 */

// Theme color for the header's prompt text. "inactive" sits between "text"
// (what a real prompt uses) and "subtle" (stock grey-on-grey).
const HEADER_TEXT_COLOR = 'inactive';

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-sticky-prompt-header.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

let failed = false;

function applyOne(label, pattern, buildReplacement) {
  const matches = [...content.matchAll(pattern)];
  if (matches.length !== 1) {
    output.error(`${label}: found ${matches.length} matches, expected exactly 1`, [
      'This might be an unsupported Claude Code version'
    ]);
    failed = true;
    return;
  }
  const match = matches[0];
  const replacement = buildReplacement(...match);
  output.discovery(label, match[0].slice(0, 100) + (match[0].length > 100 ? '...' : ''), null);
  output.modification(label, match[0].slice(0, 60) + '...', replacement.slice(0, 60) + '...');
  if (!dryRun) content = content.replace(match[0], replacement);
}

// ── Step 1+2: the sticky tracker (JVb) ──
//
// Bottom-up scan over the mounted range [t,r) computes d = first item fully
// below the viewport top edge (u), then walks back from d-1 to find the
// newest prompt scrolled off the top — but only while not following the
// bottom (!c):
//
//   for(let b=r-1;b>=t;b--){let C=o(b);if(C>=0){if(C<u)break;p=C}d=b}
//   let f=-1,m=null;if(d>0&&!c)for(...)
//
// One replacement covering both (the guard's d binds it to the loop, so the
// generic loop shape can't false-positive elsewhere in the bundle):
//   - break on the first iteration (bottom-most item straddles the top edge)
//     now sets d = r ("everything is scrolled off") instead of leaving d = t
//   - the &&!c is dropped so the walk-back also runs at the bottom
applyOne(
  'sticky tracker (scan fallback + always-visible guard)',
  /for\(let ([$\w]+)=([$\w]+)-1;\1>=([$\w]+);\1--\)\{let ([$\w]+)=([$\w]+)\(\1\);if\(\4>=0\)\{if\(\4<([$\w]+)\)break;([$\w]+)=\4\}([$\w]+)=\1\}let ([$\w]+)=-1,([$\w]+)=null;if\(\8>0&&!([$\w]+)\)for/g,
  (whole, b, r, t, C, o, u, p, d, f, m) =>
    `for(let ${b}=${r}-1;${b}>=${t};${b}--){let ${C}=${o}(${b});if(${C}>=0){if(${C}<${u}){if(${b}===${r}-1)${d}=${r};break}${p}=${C}}${d}=${b}}let ${f}=-1,${m}=null;if(${d}>0)for`
);

// ── Step 3: the header renderer (QHa) ──
//
// Stock renders the whole line in "subtle" on userMessageBackground:
//   jsxs(h,{color:"subtle",wrap:"truncate-end",children:[qe.pointer," ",text]})
// Restyle to match a transcript user message, one step quieter: pointer span
// in "subtle", text span in HEADER_TEXT_COLOR.
applyOne(
  'header renderer contrast',
  /([$\w]+)\.jsxs\(([$\w]+),\{color:"subtle",wrap:"truncate-end",children:\[([$\w]+)\.pointer," ",([$\w]+)\]\}\)/g,
  (whole, runtime, text, symbols, promptVar) =>
    `${runtime}.jsxs(${text},{wrap:"truncate-end",children:[${runtime}.jsx(${text},{color:"subtle",children:${symbols}.pointer})," ",${runtime}.jsx(${text},{color:${JSON.stringify(HEADER_TEXT_COLOR)},children:${promptVar}})]})`
);

if (failed) process.exit(1);

if (dryRun) {
  output.result('dry_run', 'Both patch points found');
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Patched ${targetPath} (2 changes)`);
  output.info('Sticky prompt header now shows whenever the prompt is off-screen, styled legibly.');
  output.info('Restart Claude Code to apply the change.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

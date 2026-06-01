#!/usr/bin/env node
/**
 * Patch worktree-dedup v2 — content-based, nearest-wins dedup of injected
 * instruction files (CLAUDE.md, .claude/rules/*.md).
 *
 * Background
 * ──────────
 * CC injects rule/memory files into context from two phases:
 *
 *   1. Session start (`qW` / `getMemoryFiles`) — walks ancestors of cwd,
 *      loading `.claude/rules/*.md` via `KDH({conditionalRule:false})`.
 *      KDH's filter is `_ ? W.globs : !W.globs` — so this phase pulls only
 *      *unconditional* rules (no `globs:` frontmatter).
 *
 *   2. Read-time (`uD4`) — when a Read tool runs, for each ancestor dir of
 *      the read target it calls `KDH({conditionalRule:true})`, picking up
 *      *conditional* (scoped, glob-bearing) rules and injecting them via
 *      `Y08` into the response.
 *
 * The two phases load mutually-exclusive subsets (no-glob vs glob), so v1
 * of this patch — which seeded a session-start content Set and checked it
 * inside Y08 — never had anything in the Set for scoped rules. Users with
 * `.claude/rules/*.md` mirrored at multiple ancestor levels (worktrees,
 * monorepos, vendored configs) saw every copy injected on every Read.
 *
 * v2 approach
 * ───────────
 * Apply nearest-wins, content-keyed dedup *as a post-pass* at both phases.
 * Both phases push items in farthest-first order, so the *last* occurrence
 * of any given content string is the copy closest to the read target / cwd
 * — exactly the one that should win when worktree-local edits exist.
 *
 * Site 1 — qW return: dedup the assembled memory-file array by content,
 *   keeping the last occurrence. Also populate `globalThis.__instrContents`
 *   with the surviving content strings (consumed by site 2).
 *
 * Site 2 — uD4 return: dedup the K accumulator by `K[i].content.content`
 *   (Y08 nests the full file object under `.content`), seeding the seen-set
 *   from `globalThis.__instrContents` so Read-time finds are also dropped
 *   when their content already landed at session start.
 *
 * Walking the array in reverse and `unshift`ing preserves the original
 * push order of the kept items — outer rules still appear earlier in the
 * prompt than inner ones, so rule-precedence semantics are unchanged.
 *
 * Usage:
 *   node patch-worktree-dedup.js <cli.js path>
 *   node patch-worktree-dedup.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-worktree-dedup.js [--check] <cli.js path>');
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

// ── Site 1: qW return — content-dedup memory files, last-wins ────────────
//
// Anchor: end of memoized getMemoryFiles, `}}return q})});function next()`.
// The q array items have `.content` as a string (set directly when each
// file is pushed in qW), so we compare against the string directly.

const site1Pattern = /(\}\}return ([$\w]+)\}\)\}\);)(function [$\w]+\(\))/;
const site1Match = content.match(site1Pattern);

if (!site1Match) {
  output.error('Could not find session-start return pattern (site 1)');
  process.exit(1);
}

const qVar = site1Match[2];
const nextFn = site1Match[3];

output.discovery('site 1 anchor', site1Match[0].slice(0, 80) + '...');
output.discovery('memory-files variable', qVar);

const site1Dedup =
  `(function(_arr){` +
    `let _s=new Set(),_o=[];` +
    `for(let _i=_arr.length-1;_i>=0;_i--){` +
      `let _c=_arr[_i].content;` +
      `if(typeof _c==="string"){if(_s.has(_c))continue;_s.add(_c)}` +
      `_o.unshift(_arr[_i])` +
    `}` +
    `globalThis.__instrContents=_s;` +
    `return _o` +
  `})(${qVar})`;

const site1Old = site1Match[1];
const site1New = `}}return ${site1Dedup}})});`;

content = content.replace(site1Old, site1New);
patchCount++;

output.modification('site 1: qW post-pass content dedup (nearest-wins)', site1Old, site1New);

// ── Site 2: uD4 return — content-dedup K, seeded by session-start Set ────
//
// Anchor: the cwdLevelDirs for-loop body + catch + return at the end of
// uD4. Bundle shape (deminified-ish):
//
//   for(let M of O){
//     let j=(await b06(M,H,_)).filter((w)=>!f||w.type!=="Project"&&w.type!=="Local");
//     K.push(...Y08(j,$,H))
//   }}catch(_){SH(_)}return K}
//
// `b06` is the cwdLevelDirs helper — unique to this site. Variables are
// captured so the pattern adapts to minifier renames across versions.
//
// K items come from Y08 with shape `{type:"nested_memory", path, content:z, displayPath}`
// where `z` is the file object and `z.content` is the actual content string.
// The dedup is injected right before `return K`, after the catch handler.

const site2Pattern = /for\(let ([$\w]+) of ([$\w]+)\)\{let ([$\w]+)=\(await b06\(\1,[^)]+\)\)\.filter\([^}]+\);([$\w]+)\.push\(\.\.\.Y08\(\3,[^)]+\)\)\}\}catch\(([$\w]+)\)\{SH\(\5\)\}return \4\}/;
const site2Match = content.match(site2Pattern);

if (!site2Match) {
  output.error('Could not find uD4 cwdLevelDirs loop + return pattern (site 2)', [
    'Expected: for(let M of O){let j=(await b06(M,...)).filter(...);K.push(...Y08(j,...))}}catch(_){SH(_)}return K}',
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

const mVar = site2Match[1];
const oVar = site2Match[2];
const jVar = site2Match[3];
const kVar = site2Match[4];
const errVar = site2Match[5];

output.discovery('site 2 anchor', site2Match[0].slice(0, 100) + '...');
output.discovery('K accumulator', kVar);

const site2Dedup =
  `let _seen=new Set(globalThis.__instrContents||[]),_out=[];` +
  `for(let _i=${kVar}.length-1;_i>=0;_i--){` +
    `let _c=${kVar}[_i].content&&${kVar}[_i].content.content;` +
    `if(typeof _c==="string"){if(_seen.has(_c))continue;_seen.add(_c)}` +
    `_out.unshift(${kVar}[_i])` +
  `}` +
  `${kVar}=_out;`;

const site2Old = site2Match[0];
const returnTail = `}return ${kVar}}`;
if (!site2Old.endsWith(returnTail)) {
  output.error('site 2 match did not end with expected return tail', [returnTail]);
  process.exit(1);
}
const site2New = site2Old.slice(0, -returnTail.length) + `}${site2Dedup}return ${kVar}}`;

content = content.replace(site2Old, site2New);
patchCount++;

output.modification(
  'site 2: uD4 post-pass content dedup (nearest-wins)',
  site2Old.slice(0, 120) + '...',
  site2New.slice(0, 200) + '...'
);

// ── Write ────────────────────────────────────────────────────────────────

if (patchCount !== 2) {
  output.error(`Expected 2 patches, got ${patchCount}`);
  process.exit(1);
}

if (dryRun) {
  output.result('dry_run', `worktree-dedup: ${patchCount}/2 patches verified`);
} else {
  fs.writeFileSync(targetPath, content, 'utf8');
  output.result('success', `worktree-dedup: ${patchCount}/2 patches applied`);
}

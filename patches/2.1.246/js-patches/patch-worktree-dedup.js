#!/usr/bin/env node
/**
 * Patch worktree-dedup v3 — content-based, nearest-wins dedup of injected
 * instruction files (CLAUDE.md, .claude/rules/*.md). (2.1.246)
 *
 * CC injects rule/memory files from two phases; users with the same rule file
 * mirrored at multiple ancestor levels (worktrees, monorepos, vendored configs)
 * see every copy injected. This applies nearest-wins, content-keyed dedup as a
 * post-pass at both phases. Both push farthest-first, so the LAST occurrence of
 * any content string is the copy closest to the target — the one that should
 * win. Walking in reverse + unshift preserves outer-before-inner ordering.
 *
 * ── 2.1.246 restructure (vs 2.1.162) ─────────────────────────────────────
 * Both phases were rewritten, so the old loop/memoization anchors are dead —
 * but each phase now has a single accumulator with one return, which is a
 * cleaner splice point:
 *
 *  Site 1 (session start, `wYo`): the memoized getMemoryFiles closure became a
 *    Map cache (`mge`/`wYo`); `wYo` builds accumulator `a` and ends `return a}`
 *    (followed by `function o4n(e){return e==="User"||…}`). Item `.content` is a
 *    string. Dedup `a` before the return; publish surviving strings to
 *    `globalThis.__instrContents`.
 *  Site 2 (read time, `$Ur`): the single cwdLevelDirs loop split into TWO loops
 *    (nestedDirs + cwdLevelDirs), both pushing into accumulator `r` via `oHt`
 *    (was Y08). Items are `{type:"nested_memory",content:s,…}` so the key is
 *    `.content.content`. Dedup `r` after the catch, before `return r`, seeding
 *    the seen-set from `globalThis.__instrContents`.
 *
 * The two sites communicate only via `globalThis.__instrContents` (global →
 * cross-chunk-safe) and otherwise touch only local accumulators. Accumulator
 * vars are captured, never hardcoded.
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

// ── Site 1: wYo return — content-dedup memory files, last-wins ────────────
// Anchor: `return <acc>}function <o4n>(e){return e==="User"…` (unique).
const site1Pattern = /return ([$\w]+)\}(function [$\w]+\([$\w]+\)\{return [$\w]+==="User")/;
const site1Match = content.match(site1Pattern);

if (!site1Match) {
  output.error('Could not find session-start memory-file return (site 1)', [
    'Expected: return ACC}function X(e){return e==="User"||…',
    'The getMemoryFiles builder may have been restructured',
  ]);
  process.exit(1);
}

const accVar1 = site1Match[1];
const followFn = site1Match[2];

output.discovery('site 1: memory-files accumulator', accVar1);

const site1Dedup =
  `${accVar1}=(function(_arr){` +
    `let _s=new Set(),_o=[];` +
    `for(let _i=_arr.length-1;_i>=0;_i--){` +
      `let _c=_arr[_i].content;` +
      `if(typeof _c==="string"){if(_s.has(_c))continue;_s.add(_c)}` +
      `_o.unshift(_arr[_i])` +
    `}` +
    `globalThis.__instrContents=_s;` +
    `return _o` +
  `})(${accVar1});`;

const site1New = `${site1Dedup}return ${accVar1}}${followFn}`;
content = content.replace(site1Match[0], () => site1New);
patchCount++;

output.modification('site 1: session-start content dedup (nearest-wins)',
  site1Match[0].slice(0, 60) + '...', site1New.slice(0, 80) + '...');

// ── Site 2: $Ur two-loop return — content-dedup, seeded from site 1 ───────
// Anchor: the nestedDirs+cwdLevelDirs two-loop block through catch + return.
const site2Pattern = /let\{nestedDirs:[$\w]+,cwdLevelDirs:[$\w]+\}=[$\w]+\([$\w]+,[$\w]+\),[$\w]+=[^;]+;for\(let [$\w]+ of [$\w]+\)\{[^}]+\}for\(let [$\w]+ of [$\w]+\)\{[^}]+\}\}catch\(([$\w]+)\)\{[$\w]+\(\1\)\}return ([$\w]+)\}/;
const site2Match = content.match(site2Pattern);

if (!site2Match) {
  output.error('Could not find cwdLevelDirs two-loop return (site 2)', [
    'Expected: let{nestedDirs:a,cwdLevelDirs:l}=…;for(let u of a){…r.push(...oHt(…))}for(let u of l){…}}catch(o){fe(o)}return r}',
    'The read-time memory-file builder may have changed',
  ]);
  process.exit(1);
}

const kVar = site2Match[2];

output.discovery('site 2: read-time accumulator', kVar);

const site2Dedup =
  `let _seen=new Set(globalThis.__instrContents||[]),_out=[];` +
  `for(let _i=${kVar}.length-1;_i>=0;_i--){` +
    `let _c=${kVar}[_i].content&&${kVar}[_i].content.content;` +
    `if(typeof _c==="string"){if(_seen.has(_c))continue;_seen.add(_c)}` +
    `_out.unshift(${kVar}[_i])` +
  `}` +
  `${kVar}=_out;`;

const returnTail = `return ${kVar}}`;
if (!site2Match[0].endsWith(returnTail)) {
  output.error('site 2 match did not end with expected return tail', [returnTail]);
  process.exit(1);
}
const site2New = site2Match[0].slice(0, -returnTail.length) + site2Dedup + returnTail;
content = content.replace(site2Match[0], () => site2New);
patchCount++;

output.modification('site 2: read-time content dedup (nearest-wins)',
  site2Match[0].slice(0, 80) + '...', site2New.slice(0, 120) + '...');

// ── Write ──────────────────────────────────────────────────────────────
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

#!/usr/bin/env node
/**
 * Patch to prevent duplicate instruction file injection from git worktrees
 *
 * When Claude reads a file inside a git worktree that's nested under the
 * project root, the nested traversal logic (jwq/d$f) walks up the directory
 * tree and discovers .claude/rules/, CLAUDE.md, etc. in the worktree. Since
 * these are different absolute paths from the root's copies, the path-based
 * dedup doesn't catch them — identical instructions get injected twice.
 *
 * The initial session-start load (a5/hO) already has worktree awareness via
 * findCanonicalGitRoot, but the nested traversal path does not.
 *
 * This patch uses content-based dedup via globalThis:
 *
 * 1. Session start (a5/hO): After collecting all instruction files, stores
 *    their content strings in a globalThis Set.
 * 2. Nested traversal (fnA/Al1): Before adding a discovered file to context,
 *    checks if its content is already in the Set. Skips exact matches.
 *
 * No extra disk I/O — file content is already loaded on the object at both
 * injection points.
 *
 * Usage:
 *   node patch-worktree-dedup.js <cli.js path>
 *   node patch-worktree-dedup.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../lib/output');

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

// ── Patch Point 1: Session start — store instruction content set ──
//
// Pattern: At the end of the memoized getMemoryFiles function (a5/hO),
// just before `return <VAR>});` followed by the next memo assignment.
//
// We use the comma operator to inject the Set creation before the return:
//   return (globalThis.__instrContents=new Set(VAR.map(_i=>_i.content)),VAR)
//
// The anchor: `}}return <VAR>});<NEXT>=<MEMO>(` — unique end-of-function
// pattern where the hook-firing block closes (two `}`), then return,
// then the closure closes, then the next memoized function starts.

const site1Pattern = /(\}\}return ([$\w]+)\}\);)([$\w]+)=[$\w]+\(\(\)=>\{let [$\w]+=[$\w]+\("ExperimentalUltraClaudeMd"\)/;
const site1Match = content.match(site1Pattern);

if (!site1Match) {
  output.error('Could not find session-start return pattern (site 1)');
  process.exit(1);
}

output.discovery('site 1 anchor', site1Match[0].slice(0, 80) + '...');
output.discovery('return variable', site1Match[2]);
output.discovery('next memo variable', site1Match[3]);

const returnVar = site1Match[2];
const site1Old = site1Match[1]; // `}}return A});`
const site1New = `}}return(globalThis.__instrContents=new Set(${returnVar}.map(function(_i){return _i.content})),${returnVar})});`;

content = content.replace(site1Old, site1New);
patchCount++;

output.modification('site 1: inject content set at session-start return', site1Old, site1New);

// ── Patch Point 2: Nested traversal — skip content-matched files ──
//
// Pattern: The nested_memory collector function (fnA/Al1) iterates
// discovered files and checks `!STATE.readFileState.has(ITEM.path)`.
//
// We extend the condition to also check against the content set:
//   if(!STATE.readFileState.has(ITEM.path) &&
//      !(globalThis.__instrContents && globalThis.__instrContents.has(ITEM.content)))
//
// Anchor: `function <NAME>(<ARGS>){let <VAR>=[],<VAR2>=<hasHook>();for(let <ITEM> of <ARG>)if(!<STATE>.readFileState.has(<ITEM>.path)){`
// This is the only function with this exact structure.

const site2Pattern = /for\(let ([$\w]+) of [$\w]+\)if\(!([$\w]+)\.readFileState\.has\(\1\.path\)\)\{/;
const site2Match = content.match(site2Pattern);

if (!site2Match) {
  output.error('Could not find nested traversal readFileState check (site 2)');
  process.exit(1);
}

output.discovery('site 2 anchor', site2Match[0]);
output.discovery('item variable', site2Match[1]);
output.discovery('state variable', site2Match[2]);

const itemVar = site2Match[1];
const site2Old = site2Match[0];
// Original: ...has(ITEM.path)){
// New:      ...has(ITEM.path)&&!(globalThis.__instrContents&&globalThis.__instrContents.has(ITEM.content))){
const site2New = site2Old.replace(
  `${itemVar}.path)){`,
  `${itemVar}.path)&&!(globalThis.__instrContents&&globalThis.__instrContents.has(${itemVar}.content))){`
);

content = content.replace(site2Old, site2New);
patchCount++;

output.modification('site 2: add content dedup to traversal collector', site2Old, site2New);

// ── Write ──

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

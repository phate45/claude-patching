#!/usr/bin/env node
/**
 * Patch to suppress duplicate background agent notifications (2.1.47+)
 *
 * When a background agent completes, its notification is enqueued
 * before TaskOutput can read the output (due to polling delay).
 * If the model calls TaskOutput during its turn, the notification
 * is still queued and fires after the turn — duplicating context.
 *
 * This patch uses a globalThis Set to coordinate between TaskOutput
 * and the notification consumers:
 *
 * 1. TaskOutput flags task IDs whose output was successfully read
 * 2. SfB dispatch function checks the flag before executing queued input
 * 3. Main loop consumer checks the flag before creating system message
 *
 * If the model never calls TaskOutput, notifications fire normally.
 *
 * Changes from 2.1.45:
 * - Patch Point 2 moved: the per-item hD1 useEffect dequeue was replaced
 *   by a bulk queue filter (a6H) + SfB dispatch function. We now inject
 *   the suppression check inside SfB after the null guard, before the
 *   item is processed and passed to executeInput.
 * - Points 1 and 3 unchanged.
 *
 * Usage:
 *   node patch-quiet-notifications.js <cli.js path>
 *   node patch-quiet-notifications.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-quiet-notifications.js [--check] <cli.js path>');
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

// ── Patch Point 1: TaskOutput — flag task IDs whose output was read ──
//
// Pattern (2.1.47): tM(D,$.setAppState,(U)=>({...U,notified:!0})),{data:{retrieval_status:"success",task:await xz$(M)}}
// Occurs twice: non-blocking and blocking success paths in TaskOutput.call()
//
// We chain a globalThis Set add after the tM() call:
//   tM(...),(globalThis.__taskOutputRead=globalThis.__taskOutputRead||new Set).add(taskId),{data:...}

const taskOutputPattern = /([$\w]+)\(([$\w]+),([$\w]+)\.setAppState,\(([$\w]+)\)=>\(\{\.\.\.\4,notified:!0\}\)\),(\{data:\{retrieval_status:"success",task:await ([$\w]+)\([$\w]+\)\}\})/g;

const taskOutputMatches = content.match(taskOutputPattern);

if (!taskOutputMatches || taskOutputMatches.length < 2) {
  output.error('Could not find TaskOutput success return patterns', [
    'Expected 2 matches for notified:!0 + retrieval_status:"success" (with await)',
    `Found: ${taskOutputMatches?.length ?? 0}`,
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

output.discovery('TaskOutput success paths', `${taskOutputMatches.length} matches`, {
  'first': taskOutputMatches[0].slice(0, 60) + '...',
  'second': taskOutputMatches[1].slice(0, 60) + '...'
});

content = content.replace(taskOutputPattern, (match, fn, taskId, state, inner, dataBlock, taskFn) => {
  patchCount++;
  const patched = `${fn}(${taskId},${state}.setAppState,(${inner})=>({...${inner},notified:!0})),(globalThis.__taskOutputRead=globalThis.__taskOutputRead||new Set).add(${taskId}),${dataBlock}`;
  output.modification(`TaskOutput success #${patchCount}`, match.slice(0, 50) + '...', patched.slice(0, 50) + '...');
  return patched;
});

// ── Patch Point 2: SfB dispatch — suppress if output already read ──
//
// In 2.1.47 the React notification consumer was refactored:
// - Old (2.1.45): useEffect dequeued items one at a time from hD1 array
// - New (2.1.47): useEffect calls a6H() to bulk-remove task-started items,
//   then dispatches via SfB() which dequeues ONE item via TP$()
//
// SfB structure:
//   function SfB({executeInput:H}){let $=TP$();if(!$)return{processed:!1};
//     let A,L={};if(typeof $.value==="string")A=$.value;else{...}
//     return H(A,L,$.mode,$.uuid),{processed:!0}}
//
// We inject after the null guard (if(!ITEM)return{processed:!1};) to check
// whether the dequeued item is a task-notification for an already-read task.
// If so, drop it silently by returning {processed:!1}.

const sfbPattern = /(function [$\w]+\(\{executeInput:([$\w]+)\}\)\{let ([$\w]+)=([$\w]+)\(\);if\(!\3\)return\{processed:!1\};)/;

const sfbMatch = content.match(sfbPattern);

if (!sfbMatch) {
  output.error('Could not find SfB dispatch function pattern', [
    'Expected: function FN({executeInput:VAR}){let ITEM=DEQUEUE();if(!ITEM)return{processed:!1};',
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

output.discovery('SfB dispatch function', sfbMatch[0].slice(0, 80) + '...');

const sfbItemVar = sfbMatch[3]; // The dequeued item variable

const sfbOriginal = sfbMatch[0];
const sfbSuppression = `if(${sfbItemVar}.mode==="task-notification"&&typeof ${sfbItemVar}.value==="string"){let _tid=${sfbItemVar}.value.match(/<task-id>([^<]+)<\\/task-id>/);if(_tid&&globalThis.__taskOutputRead?.has(_tid[1])){globalThis.__taskOutputRead.delete(_tid[1]);return{processed:!1}}}`;
const sfbPatched = sfbOriginal + sfbSuppression;

output.modification('SfB dispatch', sfbOriginal.slice(0, 60) + '...', sfbPatched.slice(0, 60) + '...');

// Use function replacer to avoid $ interpretation in replacement strings
// (minified variable names like A$, rV$ contain $ which collides with
// String.replace specials like $& = "insert match")
content = content.replace(sfbOriginal, () => sfbPatched);
patchCount++;

// ── Patch Point 3: Main loop consumer — suppress if output already read ──
//
// The task-notification block uses a single `let` with comma-separated declarations:
//   let TEXT=...,TASKID=TEXT.match(/<task-id>.../),OUTPUT=TEXT.match(/<output-file>.../),...;
//   ENQUEUE({...});continue}
//
// IMPORTANT: We must NOT inject inside the let block (that breaks the comma chain).
// Instead, match through the entire let block's terminating semicolon, then inject
// the suppression check between the semicolon and the enqueue call.

const mainLoopPattern = /(if\([$\w]+\.mode==="task-notification"\)\{let [$\w]+=typeof [$\w]+\.value==="string"\?[$\w]+\.value:"",([$\w]+)=[$\w]+\.match\(\/<task-id>\(\[\^<\]\+\)<\\\/task-id>\/\),[^;]+;)/;

const mainLoopMatch = content.match(mainLoopPattern);

if (!mainLoopMatch) {
  output.error('Could not find main loop task-notification consumer pattern', [
    'Expected: if(VAR.mode==="task-notification"){let VAR=...;ENQUEUE({...})',
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

output.discovery('main loop consumer', mainLoopMatch[0].slice(0, 80) + '...');

const taskIdVar = mainLoopMatch[2]; // The variable holding the task-id match result

const mainLoopOriginal = mainLoopMatch[0];
// Inject after the let block's semicolon, before the enqueue call
const mainLoopSuppression = `if(${taskIdVar}&&globalThis.__taskOutputRead?.has(${taskIdVar}[1])){globalThis.__taskOutputRead.delete(${taskIdVar}[1]);continue}`;
const mainLoopPatched = mainLoopOriginal + mainLoopSuppression;

output.modification('main loop consumer', mainLoopOriginal.slice(0, 60) + '...', mainLoopPatched.slice(0, 60) + '...');

content = content.replace(mainLoopOriginal, () => mainLoopPatched);
patchCount++;

// ── Write result ──

if (dryRun) {
  output.result('dry_run', `All ${patchCount} patch points found`);
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Applied ${patchCount} modifications to ${targetPath}`);
  output.info('Background agent notifications will be suppressed when TaskOutput has already read the output.');
  output.info('Restart Claude Code to apply the change.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Patch to suppress duplicate background agent notifications
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
 * 2. hD1 consumer (React useEffect) checks the flag before processing
 * 3. Main loop consumer checks the flag before creating system message
 *
 * If the model never calls TaskOutput, notifications fire normally.
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
// Pattern: Q5(w,q.setAppState,(X)=>({...X,notified:!0})),{data:{retrieval_status:"success",task:nj6(VAR)}}
// Occurs twice: non-blocking and blocking success paths in TaskOutput.call()
//
// We chain a globalThis Set add after the Q5() call:
//   Q5(...),(globalThis.__taskOutputRead=globalThis.__taskOutputRead||new Set).add(taskId),{data:...}

const taskOutputPattern = /([$\w]+)\(([$\w]+),([$\w]+)\.setAppState,\(([$\w]+)\)=>\(\{\.\.\.\4,notified:!0\}\)\),(\{data:\{retrieval_status:"success",task:([$\w]+)\([$\w]+\)\}\})/g;

const taskOutputMatches = content.match(taskOutputPattern);

if (!taskOutputMatches || taskOutputMatches.length < 2) {
  output.error('Could not find TaskOutput success return patterns', [
    'Expected 2 matches for notified:!0 + retrieval_status:"success"',
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

// ── Patch Point 2: hD1 consumer — suppress if output already read ──
//
// In 2.1.41 the React useEffect dequeues notification objects (not raw strings):
//   if(!FN1())return;if(VAR)return;let ITEM=FN2();if(!ITEM)return;SET_LOADING(!0);...
//
// The dequeued item has a .value property containing the notification XML string.
// We insert a check after the dequeue/null-guard and BEFORE setIsLoading(!0),
// so suppressed notifications don't trigger a loading state.

const hd1ConsumerPattern = /(if\(![$\w]+\(\)\)return;if\([$\w]+\)return;let ([$\w]+)=([$\w]+)\(\);if\(!\2\)return;)([$\w]+\(!0\))/;

const hd1Match = content.match(hd1ConsumerPattern);

if (!hd1Match) {
  output.error('Could not find hD1 notification consumer pattern', [
    'Expected: if(!FN())return;if(VAR)return;let ITEM=FN();if(!ITEM)return;SET(!0)',
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

output.discovery('hD1 consumer', hd1Match[0].slice(0, 80) + '...');

const hd1ItemVar = hd1Match[2]; // The dequeued item variable (_)

const hd1Original = hd1Match[0];
const hd1Suppression = `if(typeof ${hd1ItemVar}.value==="string"){let _tid=${hd1ItemVar}.value.match(/<task-id>([^<]+)<\\/task-id>/);if(_tid&&globalThis.__taskOutputRead?.has(_tid[1])){globalThis.__taskOutputRead.delete(_tid[1]);return}}`;
const hd1Patched = hd1Match[1] + hd1Suppression + hd1Match[4];

output.modification('hD1 consumer', hd1Original.slice(0, 60) + '...', hd1Patched.slice(0, 60) + '...');

content = content.replace(hd1Original, hd1Patched);
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

content = content.replace(mainLoopOriginal, mainLoopPatched);
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

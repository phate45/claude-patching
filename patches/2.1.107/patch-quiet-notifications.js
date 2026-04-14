#!/usr/bin/env node
/**
 * Patch to suppress duplicate background agent notifications (2.1.107+)
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
 * 2. im7 dispatch function filters flagged items from bulk-dequeued array
 * 3. Main loop consumer checks the flag before creating system message
 *
 * If the model never calls TaskOutput, notifications fire normally.
 *
 * Changes from 2.1.89:
 * - Patch Point 1 rewritten: TaskOutput now uses $.taskRegistry.update(taskId, cb)
 *   instead of FN(taskId, STATE.setAppState, cb). Pattern updated to match new API.
 * - Points 2 and 3 unchanged.
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
// Pattern (2.1.107): $.taskRegistry.update(TASKID,(D)=>({...D,notified:!0})),{data:{retrieval_status:"success",task:await TASKFN(VAR)}}
// Occurs twice: non-blocking and blocking success paths in TaskOutput.call()
//
// We chain a globalThis Set add after the taskRegistry.update() call:
//   $.taskRegistry.update(taskId,cb),(globalThis.__taskOutputRead=globalThis.__taskOutputRead||new Set).add(taskId),{data:...}

const taskOutputPattern = /([$\w]+)\.taskRegistry\.update\(([$\w]+),\(([$\w]+)\)=>\(\{\.\.\.\3,notified:!0\}\)\),(\{data:\{retrieval_status:"success",task:await ([$\w]+)\([$\w]+\)\}\})/g;

const taskOutputMatches = content.match(taskOutputPattern);

if (!taskOutputMatches || taskOutputMatches.length < 2) {
  output.error('Could not find TaskOutput success return patterns', [
    'Expected 2 matches for taskRegistry.update + retrieval_status:"success"',
    `Found: ${taskOutputMatches?.length ?? 0}`,
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

output.discovery('TaskOutput success paths', `${taskOutputMatches.length} matches`, {
  'first': taskOutputMatches[0].slice(0, 60) + '...',
  'second': taskOutputMatches[1].slice(0, 60) + '...'
});

content = content.replace(taskOutputPattern, (match, stateVar, taskId, inner, dataBlock, taskFn) => {
  patchCount++;
  const patched = `${stateVar}.taskRegistry.update(${taskId},(${inner})=>({...${inner},notified:!0})),(globalThis.__taskOutputRead=globalThis.__taskOutputRead||new Set).add(${taskId}),${dataBlock}`;
  output.modification(`TaskOutput success #${patchCount}`, match.slice(0, 50) + '...', patched.slice(0, 50) + '...');
  return patched;
});

// ── Patch Point 2: im7 dispatch — filter suppressed items from bulk dequeue ──
//
// In 2.1.89+ the dispatch function uses bulk dequeue:
//   function ko7({executeInput:H}){
//     let $=(A)=>A.agentId===void 0, q=j0H($);  // peek with filter
//     if(!q)return{processed:!1};
//     if(nm7(q)||q.mode==="bash"){let A=hiH($);return H([A]),{processed:!0}}
//     let K=q.mode, _=P0H((A)=>$(A)&&!nm7(A)&&A.mode===K);  // bulk dequeue
//     if(_.length===0)return{processed:!1};
//     return H(_),{processed:!0}
//   }
//
// We match the tail — from the bulk-dequeue length check through the closing
// brace — anchored by the `var` that follows the function.
// We inject filtering of the array when mode==="task-notification" before dispatch.

const im7TailPattern = /(if\(([$\w]+)\.length===0\)return\{processed:!1\};return ([$\w]+)\(\2\),\{processed:!0\}\})(var [$\w]+=)/;

const im7TailMatch = content.match(im7TailPattern);

if (!im7TailMatch) {
  output.error('Could not find im7 dispatch tail pattern', [
    'Expected: if(ARRAY.length===0)return{processed:!1};return FN(ARRAY),{processed:!0}}var ...',
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

output.discovery('im7 dispatch tail', im7TailMatch[0].slice(0, 100) + '...');

const arrayVar = im7TailMatch[2]; // The bulk-dequeued array
const execVar = im7TailMatch[3];  // The executeInput function

// Verify this is inside the executeInput function by checking what precedes it
const im7IdPattern = /function [$\w]+\(\{executeInput:[$\w]+\}\)\{let [$\w]+=\([$\w]+\)=>[$\w]+\.agentId===void 0/;
const im7IdMatch = content.match(im7IdPattern);

if (!im7IdMatch) {
  output.error('Could not find im7 function signature (executeInput + agentId filter)', [
    'The dispatch function structure has changed',
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

output.discovery('im7 function signature', im7IdMatch[0].slice(0, 80) + '...');

// Find the mode variable name — it's the `let K=q.mode` right before the P0H call
const modeVarPattern = new RegExp(`let ([$\\w]+)=[$\\w]+\\.mode,([$\\w]+)=[$\\w]+\\(`);
const modeContext = content.slice(im7IdMatch.index, im7IdMatch.index + 500);
const modeVarMatch = modeContext.match(modeVarPattern);

if (!modeVarMatch) {
  output.error('Could not find mode variable in im7');
  process.exit(1);
}

const modeVar = modeVarMatch[1];

output.discovery('im7 mode variable', modeVar);

// Build the injection: when mode is "task-notification", filter out already-read task IDs
const im7Original = im7TailMatch[1]; // The tail up to (but not including) the trailing var
const im7FilterBlock = [
  `if(${modeVar}==="task-notification"&&globalThis.__taskOutputRead?.size){`,
    `${arrayVar}=${arrayVar}.filter(function(_q){`,
      `var _t=typeof _q.value==="string"&&_q.value.match(/<task-id>([^<]+)<\\/task-id>/);`,
      `if(_t&&globalThis.__taskOutputRead.has(_t[1])){globalThis.__taskOutputRead.delete(_t[1]);return!1}`,
      `return!0`,
    `});`,
    `if(${arrayVar}.length===0)return{processed:!1}`,
  `}`,
].join('');

const im7Patched = im7FilterBlock + `return ${execVar}(${arrayVar}),{processed:!0}}`;

output.modification('im7 dispatch tail',
  im7Original.slice(0, 60) + '...',
  (im7FilterBlock + 'return...').slice(0, 60) + '...'
);

content = content.replace(im7Original, () => im7Patched);
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

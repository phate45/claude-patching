#!/usr/bin/env node
/**
 * Patch to make the periodic task_reminder nag conditional on a non-empty
 * task list.
 *
 * Stock CC injects "The task tools haven't been used recently. If you're
 * working on tasks..." system reminders on a timer, regardless of whether the
 * session uses task tracking at all. In a session that never touches the task
 * tools this fires over and over (easily 5-10 times in a long session), each
 * one costing tokens and attention mid-work.
 *
 * The reminder payload's .content is the current task list — the dispatch
 * case already branches on it to append the list when non-empty. This patch
 * extends the existing gate with an empty-list bail, so the reminder only
 * appears in the one case where it's useful: tasks exist but have gone
 * unattended.
 *
 * Target (task_reminder dispatch case):
 *   case"task_reminder":{if(!eP()||Ete())return[];let r=e.content.map(...
 * After:
 *   case"task_reminder":{if(!eP()||Ete()||e.content.length===0)return[];...
 *
 * Usage:
 *   node patch-task-reminder-conditional.js <cli.js path>
 *   node patch-task-reminder-conditional.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-task-reminder-conditional.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Structure: case"task_reminder":{if(!ENABLED()||SUPPRESSED())return[];let R=PAYLOAD.content.map(
const pattern = /case"task_reminder":\{if\(!([$\w]+)\(\)\|\|([$\w]+)\(\)\)return\[\];let ([$\w]+)=([$\w]+)\.content\.map\(/g;

const matches = [...content.matchAll(pattern)];

if (matches.length !== 1) {
  output.error(`Found ${matches.length} task_reminder dispatch gates, expected exactly 1`, [
    'Expected: case"task_reminder":{if(!ENABLED()||SUPPRESSED())return[];let R=PAYLOAD.content.map(',
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

const [original, enabledFn, suppressFn, mapVar, payloadVar] = matches[0];

output.discovery('task_reminder dispatch gate', original, {
  enabledFn, suppressFn, payloadVar
});

const replacement = `case"task_reminder":{if(!${enabledFn}()||${suppressFn}()||${payloadVar}.content.length===0)return[];let ${mapVar}=${payloadVar}.content.map(`;

output.modification('task_reminder gate',
  `if(!${enabledFn}()||${suppressFn}())return[]`,
  `if(!${enabledFn}()||${suppressFn}()||${payloadVar}.content.length===0)return[]`
);

if (dryRun) {
  output.result('dry_run', 'Patch point found');
  process.exit(0);
}

content = content.replace(original, replacement);

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Patched ${targetPath}`);
  output.info('task_reminder now fires only when the session task list is non-empty.');
  output.info('Restart Claude Code to apply the change.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

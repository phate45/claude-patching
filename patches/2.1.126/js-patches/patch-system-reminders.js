#!/usr/bin/env node
/**
 * Patch to reduce system reminder token overhead (2.1.126)
 *
 * Two high-frequency reminders remain in 2.1.126:
 *
 * 1. Task reminder: Periodic nag about task tools (~100 tokens)
 *
 * 2. File modification reminder: When files change outside of edits.
 *    Now a ternary on `H.snippet===""` — empty branch (snippet was budget-truncated)
 *    vs the with-snippet branch that dumps the diff. We collapse both.
 *
 * Ported from 2.1.111:
 *   - Malware reminder: REMOVED upstream. The "Whenever you read a file..."
 *     template literal no longer exists in the bundle, so the malware sub-patch
 *     is now a no-op (reports as already-applied / skipped, not a failure).
 *   - File-modified: rewrote regex to match the new
 *     `content:H.snippet===""?<empty>:<with-snippet>`,isMeta:!0` ternary form.
 */

const fs = require('fs');
const output = require('../../../lib/output');

// ============================================================
// CONFIGURATION
// ============================================================

const TASK_REMINDER = 'remove';
const CONCISE_TASK_REMINDER = 'Use $1/$2 for task tracking where applicable.';

const FILE_MODIFIED_REMINDER = 'concise';
const CONCISE_FILE_MODIFIED = 'Note: $1 was changed outside of your edits. Read the file before making further changes.';

// ============================================================
// PATCH IMPLEMENTATION
// ============================================================

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  console.error('Usage: node patch-system-reminders.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  console.error(`Failed to read ${targetPath}:`, err.message);
  process.exit(1);
}

let patchedContent = content;
let patchCount = 0;
const missed = [];

// ============================================================
// PATCH 1: Malware reminder on file reads (REMOVED UPSTREAM in 2.1.126)
// ============================================================

output.section('Malware reminder', { index: 1 });
{
  // The original "Whenever you read a file..." template literal was dropped
  // upstream. If a future version reintroduces something similar, this probe
  // will surface it; otherwise we record skipped and move on.
  const malwarePresent = /<system-reminder>\\nWhenever you read a file/.test(patchedContent)
    || /Whenever you read a file[^`]+code behavior/.test(patchedContent);

  if (malwarePresent) {
    output.warning('Malware reminder reappeared upstream', [
      'Pattern matched — patch logic needs an update'
    ]);
    missed.push('malware');
  } else {
    output.info('Malware reminder absent upstream — nothing to do');
  }
}

// ============================================================
// PATCH 2: Task reminder
// ============================================================

if (TASK_REMINDER !== 'keep') {
  output.section('Task reminder', { index: 2 });

  if (TASK_REMINDER === 'remove') {
    const taskCasePattern = /case"task_reminder":\{if\(!([$\w]+)\(\)\)return\[\];let ([$\w]+)=[$\w]+\.content\.map\(\([$\w]+\)=>`[^`]*`\)\.join\(`\n`\),([$\w]+)=`The task tools haven't been used recently\.[^`]+NEVER mention this reminder to the user\n`;if\(\2\.length>0\)\3\+=`[^`]+`;return ([$\w]+)\(\[([$\w]+)\(\{content:\3,isMeta:!0\}\)\]\)\}/;

    const taskMatch = patchedContent.match(taskCasePattern);

    if (taskMatch) {
      output.discovery('task reminder case', 'task_reminder', {
        'Gate fn': taskMatch[1],
        'List var': taskMatch[2],
        'Text var': taskMatch[3],
        'Original length': taskMatch[0].length + ' chars'
      });
      output.info('Config: TASK_REMINDER = remove (full case body replaced)');

      const replacement = `case"task_reminder":return [];`;
      output.info(`New length: ${replacement.length} chars`);

      patchedContent = patchedContent.replace(taskMatch[0], replacement);
      patchCount++;
    } else {
      output.warning('Could not find task reminder case pattern', [
        'May already be patched or pattern changed'
      ]);
      missed.push('task');
    }
  } else {
    const taskReminderPattern = /([$\w]+)=`The task tools haven't been used recently\.[^`]*\$\{([$\w]+)\}[^`]*\$\{([$\w]+)\}[^`]*NEVER mention this reminder to the user\n`/;

    const taskMatch = patchedContent.match(taskReminderPattern);

    if (taskMatch) {
      const assignVar = taskMatch[1];
      const tool1Var = taskMatch[2];
      const tool2Var = taskMatch[3];

      output.discovery('task reminder variable', assignVar, {
        'Tool placeholders': `\${${tool1Var}}, \${${tool2Var}}`,
        'Original length': taskMatch[0].length + ' chars'
      });

      const conciseText = CONCISE_TASK_REMINDER
        .replace('$1', '${' + tool1Var + '}')
        .replace('$2', '${' + tool2Var + '}');
      const replacement = `${assignVar}=\`${conciseText}\n\``;

      output.info('Config: TASK_REMINDER = concise');
      output.modification('task reminder text', 'The task tools haven\'t been used recently...', conciseText);
      output.info(`New length: ${replacement.length} chars`);

      patchedContent = patchedContent.replace(taskMatch[0], replacement);
      patchCount++;
    } else {
      output.warning('Could not find task reminder pattern', [
        'May already be patched or pattern changed'
      ]);
      missed.push('task');
    }
  }
}

// ============================================================
// PATCH 3: File modification reminder (2.1.126 ternary form)
// ============================================================

if (FILE_MODIFIED_REMINDER !== 'keep') {
  output.section('File modification reminder', { index: 3 });

  // 2.1.126 structure:
  //   edited_text_file:(H)=>WRAPPER([HELPER({content:H.snippet===""?
  //     `Note: ${H.filename} was modified, ...The diff was omitted because...`
  //     :`Note: ${H.filename} was modified, ...${H.snippet}`,isMeta:!0})]),
  // We backreference the arg name across both branches to ensure cohesion.
  const fileModifiedPattern = /edited_text_file:\(([$\w]+)\)=>([$\w]+)\(\[([$\w]+)\(\{content:\1\.snippet===""\?`Note: \$\{\1\.filename\} was modified[^`]+`:`Note: \$\{\1\.filename\} was modified[^`]+\$\{\1\.snippet\}`,isMeta:!0\}\)\]\),/;

  const fileModMatch = patchedContent.match(fileModifiedPattern);

  if (fileModMatch) {
    const argVar = fileModMatch[1];
    const wrapperFn = fileModMatch[2];
    const helperFn = fileModMatch[3];

    output.discovery('file modification dispatch', 'edited_text_file', {
      'Argument variable': argVar,
      'Wrapper function': wrapperFn,
      'Helper function': helperFn,
      'Original length': fileModMatch[0].length + ' chars'
    });

    let replacement;
    if (FILE_MODIFIED_REMINDER === 'remove') {
      replacement = `edited_text_file:()=>[],`;
      output.info('Config: FILE_MODIFIED_REMINDER = remove');
    } else {
      const conciseText = CONCISE_FILE_MODIFIED.replace('$1', '${' + argVar + '.filename}');
      replacement = `edited_text_file:(${argVar})=>${wrapperFn}([${helperFn}({content:\`${conciseText}\`,isMeta:!0})]),`;
      output.info('Config: FILE_MODIFIED_REMINDER = concise');
      output.modification('file modification reminder', 'Note: ${filename} was modified... (ternary)', conciseText);
    }

    output.info(`New length: ${replacement.length} chars`);

    patchedContent = patchedContent.replace(fileModMatch[0], replacement);
    patchCount++;
  } else {
    output.warning('Could not find file modification reminder pattern', [
      'May already be patched or pattern changed'
    ]);
    missed.push('file-modified');
  }
}

// ============================================================
// Apply changes
// ============================================================

if (missed.length > 0) {
  output.result('failure', `Could not find pattern(s) for: ${missed.join(', ')}`);
  process.exit(1);
}

if (patchCount === 0) {
  output.result('failure', 'No patches applied - all sub-patches configured as keep');
  process.exit(1);
}

if (dryRun) {
  output.result('dry_run', `${patchCount} patch(es) would be applied`);
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, patchedContent);
  output.result('success', `Applied ${patchCount} patch(es) to ${targetPath}`);
  output.info('Restart Claude Code to apply changes.');
} catch (err) {
  output.error(`Failed to write patched file: ${err.message}`);
  process.exit(1);
}

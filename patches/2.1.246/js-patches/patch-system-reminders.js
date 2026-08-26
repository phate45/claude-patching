#!/usr/bin/env node
/**
 * Patch to reduce system reminder token overhead (2.1.246)
 *
 * Sub-patches:
 * 1. Malware reminder — REMOVED upstream (no-op probe; reports absent).
 * 2. Task reminder — periodic task-tool nag; removed (case returns []).
 * 3. File modification reminder — collapsed to one concise line.
 *
 * ── 2.1.246 changes (vs 2.1.209) ─────────────────────────────────────────
 * - Task reminder gate collapsed from the 2.1.209 compound `if(!FR()||vJ())return[]`
 *   back to a single `if(!FR())return[]`. The task pattern makes the `||fn()`
 *   second clause OPTIONAL so it matches either shape.
 * - File-modified handler became a BLOCK-bodied arrow:
 *     edited_text_file:(e)=>{let t=`Note: ${bv(e.filename)} changed on disk…`;
 *       return Yo([dt({content:e.snippet===""?`${t} …`:`${t} …\n${e.snippet}`,isMeta:!0})])}
 *   (was a single-expression arrow with two independent literals). The copy was
 *   also reworded. The pattern matches the block body; the concise replacement
 *   rewrites it back to a single-expression arrow, reusing the captured
 *   wrapper/helper (same chunk — runtime-safe).
 *
 * Both sites live in the reminder-dispatch machinery; captures are local.
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
// PATCH 1: Malware reminder on file reads (REMOVED UPSTREAM)
// ============================================================

output.section('Malware reminder', { index: 1 });
{
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
    // 2.1.246: single-condition gate `if(!FR())return[]` (the 2.1.209 `||vJ()`
    // second clause is gone). `(?:\|\|[$\w]+\(\))?` tolerates both shapes.
    const taskCasePattern = /case"task_reminder":\{if\(!([$\w]+)\(\)(?:\|\|[$\w]+\(\))?\)return\[\];let ([$\w]+)=[$\w]+\.content\.map\(\([$\w]+\)=>`[^`]*`\)\.join\(`\n`\),([$\w]+)=`The task tools haven't been used recently\.[^`]+ignore if not applicable\.\n`;if\(\2\.length>0\)\3\+=`[^`]+`;return ([$\w]+)\(\[([$\w]+)\(\{content:\3,isMeta:!0\}\)\]\)\}/;

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

      patchedContent = patchedContent.replace(taskMatch[0], () => replacement);
      patchCount++;
    } else {
      output.warning('Could not find task reminder case pattern', [
        'May already be patched or pattern changed'
      ]);
      missed.push('task');
    }
  } else {
    const taskReminderPattern = /([$\w]+)=`The task tools haven't been used recently\.[^`]*\$\{([$\w]+)\}[^`]*\$\{([$\w]+)\}[^`]*ignore if not applicable\.\n`/;

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

      patchedContent = patchedContent.replace(taskMatch[0], () => replacement);
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
// PATCH 3: File modification reminder (2.1.246 block-bodied arrow)
// ============================================================

if (FILE_MODIFIED_REMINDER !== 'keep') {
  output.section('File modification reminder', { index: 3 });

  // 2.1.246 structure (block body):
  //   edited_text_file:(e)=>{let t=`Note: ${bv(e.filename)} changed on disk…`;
  //     return Yo([dt({content:e.snippet===""?`${t} …`:`${t} …${e.snippet}`,isMeta:!0})])},
  // Captures: 1=arg, 2=prefix var, 3=wrapper fn, 4=helper fn.
  const fileModifiedPattern = /edited_text_file:\(([$\w]+)\)=>\{let ([$\w]+)=`[^`]+`;return ([$\w]+)\(\[([$\w]+)\(\{content:\1\.snippet===""\?`[^`]+`:`[^`]+\$\{\1\.snippet\}`,isMeta:!0\}\)\]\)\},/;

  const fileModMatch = patchedContent.match(fileModifiedPattern);

  if (fileModMatch) {
    const argVar = fileModMatch[1];
    const wrapperFn = fileModMatch[3];
    const helperFn = fileModMatch[4];

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
      output.modification('file modification reminder', 'Note: ${filename} changed on disk... (block body)', conciseText);
    }

    output.info(`New length: ${replacement.length} chars`);

    patchedContent = patchedContent.replace(fileModMatch[0], () => replacement);
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

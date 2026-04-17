#!/usr/bin/env node
/**
 * Patch to reduce system reminder token overhead (2.1.111)
 *
 * System reminders are injected into tool results and can burn significant
 * tokens. This patch targets three high-frequency reminders:
 *
 * 1. Malware reminder: Injected after EVERY file read (~70 tokens each)
 *    "Whenever you read a file, you should consider whether it would be
 *    considered malware..."
 *
 * 2. Task reminder: Periodic nag about task tools (~100 tokens)
 *    "The task tools haven't been used recently..."
 *
 * 3. File modification reminder: When files change outside of edits
 *    Dumps full file content (~100+ lines) instead of just notifying
 *
 * Ported from 2.1.41:
 *   - Malware regex: declaration tail changed from `,NEXT;` to `,NEXT,MORE;`
 *     so the lookahead `(?=[;=])` broke. Now matches through to the `;`.
 *   - File-modified: refactored from `case "edited_text_file":` switch arm to
 *     an object-property dispatch `edited_text_file:(H)=>...`. Anchor rewritten.
 *   - Failure semantics: any configured sub-patch that misses its pattern now
 *     fails the whole patch (previously a silent partial success could mask
 *     regressions for multiple versions).
 *
 * Usage:
 *   node patch-system-reminders.js <cli.js path>
 *   node patch-system-reminders.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../lib/output');

// ============================================================
// CONFIGURATION
// ============================================================

// MALWARE_REMINDER: Controls the file read safety reminder
//   'remove' - Remove entirely (biggest impact - fires on every Read)
//   'keep'   - Keep original behavior
const MALWARE_REMINDER = 'remove';

// TASK_REMINDER: Controls the task tools reminder
//   'concise' - Replace with shorter version (preserves tool name placeholders)
//   'remove'  - Remove entirely
//   'keep'    - Keep original behavior
const TASK_REMINDER = 'remove';

// Concise replacement text for task reminder.
// The two placeholders reference TaskCreate and TaskUpdate tool names
// (resolved at runtime from variables in the original code).
const CONCISE_TASK_REMINDER = 'Use $1/$2 for task tracking where applicable.';

// FILE_MODIFIED_REMINDER: Controls the external file change notification
//   'concise' - Replace with short notice (no file content dump)
//   'remove'  - Remove entirely
//   'keep'    - Keep original behavior (dumps full file content)
const FILE_MODIFIED_REMINDER = 'concise';

// Concise replacement for file modification reminder.
// $1 is replaced with the filename variable.
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
// PATCH 1: Malware reminder on file reads
// ============================================================

if (MALWARE_REMINDER !== 'keep') {
  output.section('Malware reminder', { index: 1 });

  // Declaration looks like:
  //   ,VARNAME=`\n\n<system-reminder>\nWhenever you read...code behavior.\n</system-reminder>\n`,TAIL;
  // TAIL is one or more comma-separated identifiers before the terminating `;`.
  // We capture TAIL so the replacement preserves adjacent variable declarations.
  const malwareVarPattern = /,([$\w]+)=`\n\n<system-reminder>\nWhenever you read a file[^`]+code behavior\.\n<\/system-reminder>\n`(,[$\w,]+);/;

  const malwareMatch = patchedContent.match(malwareVarPattern);

  if (malwareMatch) {
    const varName = malwareMatch[1];
    const tail = malwareMatch[2];
    output.discovery('malware reminder variable', varName, {
      'Trailing declarations': tail,
      'Original length': malwareMatch[0].length + ' chars'
    });

    const replacement = `,${varName}=""${tail};`;
    output.modification('malware reminder', malwareMatch[0].slice(0, 60) + '...', replacement);

    patchedContent = patchedContent.replace(malwareMatch[0], replacement);
    patchCount++;
  } else {
    output.warning('Could not find malware reminder pattern', [
      'May already be patched or pattern changed'
    ]);
    missed.push('malware');
  }
}

// ============================================================
// PATCH 2: Task reminder
// ============================================================

if (TASK_REMINDER !== 'keep') {
  output.section('Task reminder', { index: 2 });

  // 'remove' mode: replace the whole `case "task_reminder":` body with `return [];`.
  //
  // We can't just empty out the reminder text variable. The original body ends in
  //   `return G1([t$({content:K,isMeta:!0})])`
  // If K is "" and no active tasks exist, t$ falls back through `content: H || jE`
  // to jE = "(no content)", then G1/ev wraps it as
  //   <system-reminder>\n(no content)\n</system-reminder>
  // So a "silenced" task reminder still emits a ghost meta-message on every fire.
  // Replacing the full case body with `return []` stops the harness from ever
  // constructing the message.
  //
  // 'concise' mode: keep the case body intact and only rewrite the reminder text.
  // The concise text is always non-empty (template references tool var names), so
  // the jE fallback cannot trigger.
  if (TASK_REMINDER === 'remove') {
    // Match the entire case body from `case"task_reminder":{...}` through
    // the trailing `return WRAP([HELPER({content:VAR,isMeta:!0})])}`.
    // The outer message arg (native: `H.content.map`, bare: `q.content.map`)
    // is whatever the enclosing message handler named its parameter; the
    // minifier picks different letters per bundle, so we accept any ident.
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
    // Concise: rewrite only the reminder text assignment.
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
// PATCH 3: File modification reminder
// ============================================================

if (FILE_MODIFIED_REMINDER !== 'keep') {
  output.section('File modification reminder', { index: 3 });

  // Structure (post-2.1.110 object-dispatch form):
  //   edited_text_file:(H)=>WRAPPER([HELPER({content:`Note: ${H.filename} was modified,
  //   either by the user or by a linter...${H.snippet}`,isMeta:!0})]),
  // The argument name (H) is backreferenced to ensure filename/snippet belong to the same var.
  const fileModifiedPattern = /edited_text_file:\(([$\w]+)\)=>([$\w]+)\(\[([$\w]+)\(\{content:`Note: \$\{\1\.filename\} was modified, either by the user or by a linter\.[^`]+\$\{\1\.snippet\}`,isMeta:!0\}\)\]\),/;

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
      output.modification('file modification reminder', 'Note: ${filename} was modified, either by the user or by a linter...${snippet}', conciseText);
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

// Strict failure: any enabled sub-patch that missed its pattern fails the run.
// A silent partial success previously let two sub-patches regress for multiple
// versions before anyone noticed the reminders were still firing.
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

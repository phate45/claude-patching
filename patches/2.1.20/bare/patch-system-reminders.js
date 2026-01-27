#!/usr/bin/env node
/**
 * Patch to reduce system reminder token overhead (2.1.20 bare)
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
 * Usage:
 *   node patch-system-reminders.js <cli.js path>
 *   node patch-system-reminders.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');

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
const TASK_REMINDER = 'concise';

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

// ============================================================
// PATCH 1: Malware reminder on file reads
// ============================================================

if (MALWARE_REMINDER === 'remove') {
  console.log('=== Patch 1: Malware reminder ===');

  // Pattern matches the variable definition containing the malware reminder.
  // Structure: ,VARNAME=`...system-reminder...behavior....`,NEXTVAR=
  // The variable name changes between versions, so we match generically.
  // Key anchors: "<system-reminder>" tag and "code behavior." text
  const malwareVarPattern = /,([$\w]+)=`\n\n<system-reminder>\nWhenever you read a file[^`]+code behavior\.\n<\/system-reminder>\n`,([$\w]+)=/;

  const malwareMatch = content.match(malwareVarPattern);

  if (malwareMatch) {
    const varName = malwareMatch[1];
    const nextVar = malwareMatch[2];
    console.log(`  Found reminder variable: ${varName}`);
    console.log(`  Original: ${malwareMatch[0].slice(0, 60)}...`);

    const replacement = `,${varName}="",${nextVar}=`;
    console.log(`  New: ${replacement}`);

    patchedContent = patchedContent.replace(malwareMatch[0], replacement);
    patchCount++;
  } else {
    console.log('  WARNING: Could not find malware reminder pattern');
    console.log('  (May already be patched or pattern changed)');
  }
  console.log();
}

// ============================================================
// PATCH 2: Task reminder
// ============================================================

if (TASK_REMINDER === 'remove' || TASK_REMINDER === 'concise') {
  console.log('=== Patch 2: Task reminder ===');

  // Pattern matches the task reminder string assignment inside case "task_reminder".
  // Structure: VARNAME=`The task tools haven't been used...${TOOL1}...${TOOL2}...NEVER mention...`
  // We capture the tool name placeholders to preserve them in concise mode.
  const taskReminderPattern = /([$\w]+)=`The task tools haven't been used recently\.[^`]*\$\{([$\w]+)\}[^`]*\$\{([$\w]+)\}[^`]*NEVER mention this reminder to the user\n`/;

  const taskMatch = content.match(taskReminderPattern);

  if (taskMatch) {
    const assignVar = taskMatch[1];
    const tool1Var = taskMatch[2];  // TaskCreate placeholder
    const tool2Var = taskMatch[3];  // TaskUpdate placeholder

    console.log(`  Found task reminder, assigned to: ${assignVar}`);
    console.log(`  Tool placeholders: \${${tool1Var}}, \${${tool2Var}}`);
    console.log(`  Original length: ${taskMatch[0].length} chars`);

    let replacement;
    if (TASK_REMINDER === 'remove') {
      replacement = `${assignVar}=""\n`;
      console.log(`  Action: remove`);
    } else {
      // Build concise version, substituting $1/$2 with actual placeholder vars
      const conciseText = CONCISE_TASK_REMINDER
        .replace('$1', '${' + tool1Var + '}')
        .replace('$2', '${' + tool2Var + '}');
      replacement = `${assignVar}=\`${conciseText}\n\``;
      console.log(`  Action: concise`);
      console.log(`  New text: ${conciseText}`);
    }

    console.log(`  New length: ${replacement.length} chars`);

    patchedContent = patchedContent.replace(taskMatch[0], replacement);
    patchCount++;
  } else {
    console.log('  WARNING: Could not find task reminder pattern');
    console.log('  (May already be patched or pattern changed)');
  }
  console.log();
}

// ============================================================
// PATCH 3: File modification reminder
// ============================================================

if (FILE_MODIFIED_REMINDER === 'remove' || FILE_MODIFIED_REMINDER === 'concise') {
  console.log('=== Patch 3: File modification reminder ===');

  // Pattern matches the edited_text_file case that dumps file content.
  // Structure: case"edited_text_file":return e9([q6({content:`Note: ${A.filename} was modified...${A.snippet}`,isMeta:!0})]);
  // Key anchors: case"edited_text_file" and the specific message text ending with ${A.snippet}
  const fileModifiedPattern = /case"edited_text_file":return ([$\w]+)\(\[([$\w]+)\(\{content:`Note: \$\{([$\w]+)\.filename\} was modified, either by the user or by a linter\.[^`]+\$\{\3\.snippet\}`,isMeta:!0\}\)\]\);/;

  const fileModMatch = patchedContent.match(fileModifiedPattern);

  if (fileModMatch) {
    const wrapperFn = fileModMatch[1];  // e9
    const helperFn = fileModMatch[2];   // q6
    const argVar = fileModMatch[3];     // A

    console.log(`  Found file modification case`);
    console.log(`  Wrapper: ${wrapperFn}, Helper: ${helperFn}, Arg: ${argVar}`);
    console.log(`  Original length: ${fileModMatch[0].length} chars`);

    let replacement;
    if (FILE_MODIFIED_REMINDER === 'remove') {
      replacement = `case"edited_text_file":return [];`;
      console.log(`  Action: remove`);
    } else {
      const conciseText = CONCISE_FILE_MODIFIED.replace('$1', '${' + argVar + '.filename}');
      replacement = `case"edited_text_file":return ${wrapperFn}([${helperFn}({content:\`${conciseText}\`,isMeta:!0})]);`;
      console.log(`  Action: concise`);
      console.log(`  New text: ${conciseText}`);
    }

    console.log(`  New length: ${replacement.length} chars`);

    patchedContent = patchedContent.replace(fileModMatch[0], replacement);
    patchCount++;
  } else {
    console.log('  WARNING: Could not find file modification reminder pattern');
    console.log('  (May already be patched or pattern changed)');
  }
  console.log();
}

// ============================================================
// Apply changes
// ============================================================

if (patchCount === 0) {
  console.log('No patches applied - patterns not found or already patched.');
  process.exit(1);
}

if (dryRun) {
  console.log(`(Dry run - ${patchCount} patch(es) would be applied)`);
  process.exit(0);
}

// Write patched file
try {
  fs.writeFileSync(targetPath, patchedContent);
  console.log(`Applied ${patchCount} patch(es) to ${targetPath}`);
  console.log();
  console.log('Restart Claude Code to apply changes.');
} catch (err) {
  console.error(`Failed to write patched file: ${err.message}`);
  process.exit(1);
}

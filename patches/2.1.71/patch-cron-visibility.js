#!/usr/bin/env node
/**
 * Patch to make cron-fired prompts visible in the TUI.
 *
 * When /loop or CronCreate schedules a task, the cron fire enters the
 * conversation silently — isMeta:!0 serves dual purpose:
 *   1. Auto-fire: hHH() classifies as nonEditable → queue stays for
 *      processing, never goes to the editable input bar
 *   2. Visibility: U_f() hides isMeta user messages from the message list
 *
 * The assistant responds but the user sees no visual trigger.
 *
 * Key insight: in interactive TUI mode, the queue consumer is the React
 * path (NQ$ at ~line 468608), NOT the streaming loop (Qkf). The React
 * path passes `isMeta: g.isMeta` from the queue item to NQ$, which
 * propagates it to Vkf → HA → the user message in the transcript.
 *
 * This patch:
 * 1. Marks cron queue items with _cronFire:!0 (both REPL + React hook)
 * 2. Conditionally clears isMeta for _cronFire items in the NQ$ call
 * 3. Prefixes the input text with "⏰ CronJob: " for _cronFire items
 * 4. Renders the ⏰ prefix as bold in the TUI user message renderer
 *
 * isMeta stays !0 on the queue item (auto-fire preserved via hHH),
 * but is cleared before user message creation (U_f allows display).
 * The prefix is visible in both TUI (styled) and API (raw text).
 *
 * Usage:
 *   node patch-cron-visibility.js <cli.js path>
 *   node patch-cron-visibility.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-cron-visibility.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// ============================================================
// Step 1: Mark cron queue items with _cronFire:!0
//
// Both scheduler creation sites (REPL loop + React hook) push
// queue items with isMeta:!0,workload:VAR — unique to cron.
// Add _cronFire:!0 as a marker for the NQ$ consumer to detect.
// ============================================================

const markerFind = 'isMeta:!0,workload:';
const markerReplace = 'isMeta:!0,_cronFire:!0,workload:';

const markerCount = (content.match(new RegExp(markerFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

if (markerCount === 0) {
  output.error('Could not find cron queue item pattern', [
    'Expected: isMeta:!0,workload:VAR in onFire callbacks',
    'The cron scheduler structure may have changed',
  ]);
  process.exit(1);
}

output.discovery('cron queue markers', `${markerCount} occurrence(s)`, {
  pattern: markerFind,
  expected: '2 (REPL loop + React hook)',
});

let patched = content.replaceAll(markerFind, markerReplace);
output.modification('cron queue marker', markerFind, markerReplace);

// ============================================================
// Step 2: Clear isMeta for _cronFire items in the React TUI
// queue consumer (NQ$ call)
//
// Unique pattern (1 occurrence):
//   isMeta:g.isMeta,skipAttachments:!U
//
// Replace with:
//   isMeta:g._cronFire?void 0:g.isMeta,skipAttachments:!U
//
// When _cronFire is set: isMeta → void 0 (falsy) → U_f() shows
// When _cronFire is not set: isMeta → g.isMeta (original) → no change
// ============================================================

// Build the pattern dynamically to handle different variable names
const nqPattern = /isMeta:([$\w]+)\.isMeta,skipAttachments:!([$\w]+)/;
const nqMatch = patched.match(nqPattern);

if (!nqMatch) {
  output.error('Could not find React TUI NQ$ isMeta pass-through', [
    'Expected: isMeta:VAR.isMeta,skipAttachments:!VAR',
    'The React queue consumer structure may have changed',
  ]);
  process.exit(1);
}

const [nqOriginal, itemVarNQ, boolVar] = nqMatch;
const nqReplacement = `isMeta:${itemVarNQ}._cronFire?void 0:${itemVarNQ}.isMeta,skipAttachments:!${boolVar}`;

output.discovery('React TUI NQ$ call', nqOriginal, {
  'queue item var': itemVarNQ,
});

// Use function replacer to avoid $ corruption in minified identifiers
patched = patched.replace(nqPattern, () => nqReplacement);

output.modification('NQ$ isMeta conditional',
  nqOriginal,
  nqReplacement,
);

// ============================================================
// Step 3: Prefix the input text for _cronFire items in NQ$
//
// Unique pattern (1 occurrence):
//   input:g.value,mode:g.mode
//
// Replace with:
//   input:g._cronFire?"⏰ CronJob: "+g.value:g.value,mode:g.mode
//
// The prefix persists in the user message text — visible in the
// TUI (styled by step 4) and in the API message (raw text).
// ============================================================

const inputPattern = /input:([$\w]+)\.value,mode:\1\.mode/;
const inputMatch = patched.match(inputPattern);

if (!inputMatch) {
  output.error('Could not find NQ$ input:value pass-through', [
    'Expected: input:VAR.value,mode:VAR.mode',
    'The React queue consumer structure may have changed',
  ]);
  process.exit(1);
}

const [inputOriginal, inputVar] = inputMatch;
const inputReplacement = `input:${inputVar}._cronFire?"\\u23F0 CronJob: "+${inputVar}.value:${inputVar}.value,mode:${inputVar}.mode`;

output.discovery('NQ$ input pass-through', inputOriginal, {
  'queue item var': inputVar,
});

patched = patched.replace(inputPattern, () => inputReplacement);

output.modification('NQ$ input prefix',
  inputOriginal,
  inputReplacement,
);

// ============================================================
// Step 4: Render ⏰-prefixed text with bold styling in bUD
//
// bUD is the user message text renderer. The simple path (no
// rainbow brackets) creates: <Text color="text">{text}</Text>
//
// Unique pattern (1 occurrence):
//   else _=$[3];let w=aI.createElement(E,{color:"text"},A)
//
// Replace the text child with a conditional: if text starts
// with ⏰, render [<Text bold>{prefix}</Text>, rest] as
// children inside the existing <Text color="text">.
// ============================================================

const renderPattern = /else ([$\w]+)=([$\w]+)\[(\d+)\];let ([$\w]+)=([$\w]+)\.createElement\(([$\w]+),\{color:"text"\},([$\w]+)\)/;
const renderMatch = patched.match(renderPattern);

if (!renderMatch) {
  output.error('Could not find bUD text render pattern', [
    'Expected: else VAR=ARR[N];let VAR=REACT.createElement(TEXT,{color:"text"},VAR)',
    'The user message text renderer structure may have changed',
  ]);
  process.exit(1);
}

const [renderOriginal, ptrVar, cacheArr, cacheIdx, elemVar, reactVar, textComp, textVar] = renderMatch;
const renderReplacement = `else ${ptrVar}=${cacheArr}[${cacheIdx}];let ${elemVar}=${reactVar}.createElement(${textComp},{color:"text"},${textVar}[0]=="\\u23F0"?[${reactVar}.createElement(${textComp},{bold:!0},${textVar}.slice(0,11)),${textVar}.slice(11)]:${textVar})`;

output.discovery('bUD text renderer', renderOriginal, {
  'React var': reactVar,
  'Text component': textComp,
  'text var': textVar,
});

patched = patched.replace(renderPattern, () => renderReplacement);

output.modification('bUD cron prefix styling',
  renderOriginal,
  renderReplacement,
);

if (patched === content) {
  output.error('Patches had no effect');
  process.exit(1);
}

const totalChanges = markerCount + 3; // markers + isMeta + input + render

if (dryRun) {
  output.result('dry_run', `Cron visibility patch ready (${totalChanges} changes)`);
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, patched);
  output.result('success', `Patched cron visibility in ${targetPath} (${totalChanges} changes)`);
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

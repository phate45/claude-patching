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
 * path (NQ$), NOT the streaming loop. The React path passes `isMeta` from
 * the queue item and propagates it to the user message in the transcript.
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
 * 2.1.246 change (step 4): the JSX element factory dropped from the member
 * form `RUNTIME.jsx(T,{…})` to a BARE import-aliased call `o(T,{…})` — there
 * is no `.jsx(` substring anymore (part of the 2.1.234 transcript-render
 * rework + the module split's per-chunk import aliasing). The user-message
 * text renderer is now `yf()`; its simple-path memo slot reads
 *   if(VR[3]!==YR)QR=o(t,{color:"text",children:YR}),VR[3]=YR,VR[4]=QR;else QR=VR[4]
 * preceded within ~300 chars by `color:"bashBorder"` (the bash `! ` prefix).
 * The render regex now matches a bare `FACTORY(` and the replacement emits
 * bare factory calls. Steps 1–3 are unchanged.
 *
 * Usage:
 *   node patch-cron-visibility.js <cli.js path>
 *   node patch-cron-visibility.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

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
// Both cron sites read `modelScheduledOrigin:!0,wakeupSource:VAR,workload:MJt`.
// Anchor on the stable `modelScheduledOrigin:!0,wakeupSource:` prefix (2 sites);
// inject _cronFire:!0 ahead of it.
// ============================================================

const markerFind = 'modelScheduledOrigin:!0,wakeupSource:';
const markerReplace = '_cronFire:!0,modelScheduledOrigin:!0,wakeupSource:';

const markerCount = (content.match(new RegExp(markerFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

if (markerCount === 0) {
  output.error('Could not find cron queue item pattern', [
    'Expected: modelScheduledOrigin:!0,wakeupSource:VAR in onFire callbacks',
    'The cron scheduler structure may have changed',
  ]);
  process.exit(1);
}

output.discovery('cron queue markers', `${markerCount} occurrence(s)`, {
  pattern: markerFind,
  expected: '2 (REPL loop + React hook)',
});

if (markerCount !== 2) {
  output.warning(`Expected 2 cron queue markers, found ${markerCount}`);
}

let patched = content.replaceAll(markerFind, markerReplace);
output.modification('cron queue marker', markerFind, markerReplace);

// ============================================================
// Step 2: Clear isMeta for _cronFire items in the React TUI
// queue consumer (NQ$ call). Unique pattern (1 occurrence):
//   isMeta:g.isMeta,skipAttachments:!U
// ============================================================

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

patched = patched.replace(nqPattern, () => nqReplacement);

output.modification('NQ$ isMeta conditional', nqOriginal, nqReplacement);

// ============================================================
// Step 3: Prefix the input text for _cronFire items in NQ$.
// Unique pattern (1 occurrence):
//   input:p.value,preExpansionInput:p.preExpansionValue
// ============================================================

const inputPattern = /input:([$\w]+)\.value,preExpansionInput:\1\.preExpansionValue/;
const inputMatch = patched.match(inputPattern);

if (!inputMatch) {
  output.error('Could not find NQ$ input:value pass-through', [
    'Expected: input:VAR.value,preExpansionInput:VAR.preExpansionValue',
    'The React queue consumer structure may have changed',
  ]);
  process.exit(1);
}

const [inputOriginal, inputVar] = inputMatch;
const inputReplacement = `input:${inputVar}._cronFire?"\\u23F0 CronJob: "+${inputVar}.value:${inputVar}.value,preExpansionInput:${inputVar}.preExpansionValue`;

output.discovery('NQ$ input pass-through', inputOriginal, {
  'queue item var': inputVar,
});

patched = patched.replace(inputPattern, () => inputReplacement);

output.modification('NQ$ input prefix', inputOriginal, inputReplacement);

// ============================================================
// Step 4: Render ⏰-prefixed text with bold styling in the user
// message text renderer (yf in 2.1.246). Simple-path memo slot:
//   if(CACHE[SLOT1]!==TEXTVAR)ELEM=FACTORY(TEXT,{color:"text",children:TEXTVAR}),
//   CACHE[SLOT1]=TEXTVAR,CACHE[SLOT2]=ELEM;else ELEM=CACHE[SLOT2]
// FACTORY is now a BARE import-aliased jsx call (no `.jsx(`).
// ============================================================

const renderPattern = new RegExp(
  'if\\(([$\\w]+)\\[(\\d+)\\]!==([$\\w]+)\\)' +          // if(CACHE[SLOT1]!==TEXTVAR) — 1,2,3
  '([$\\w]+)=([$\\w]+)\\(' +                             // ELEM=FACTORY( — 4,5
  '([$\\w]+),\\{color:"text",children:\\3\\}\\),' +      // TEXT,{color:"text",children:TEXTVAR}) — 6
  '\\1\\[\\2\\]=\\3,' +                                  // CACHE[SLOT1]=TEXTVAR
  '\\1\\[(\\d+)\\]=\\4;' +                               // CACHE[SLOT2]=ELEM — 7
  'else \\4=\\1\\[\\7\\]',                               // else ELEM=CACHE[SLOT2]
  'g'
);

// The true user-message text renderer is anchored by a preceding
// `color:"bashBorder"` element within ~300 chars (the bash `! ` prefix).
let renderMatch = null;
for (const m of patched.matchAll(renderPattern)) {
  const preceding = patched.slice(Math.max(0, m.index - 300), m.index);
  if (preceding.includes('color:"bashBorder"')) {
    renderMatch = m;
    break;
  }
}

if (!renderMatch) {
  output.error('Could not find user-message text render pattern', [
    'Expected: if(CACHE[N]!==A)ELEM=o(T,{color:"text",children:A}),CACHE[N]=A,CACHE[M]=ELEM;else ELEM=CACHE[M]',
    '(preceded within ~300 chars by color:"bashBorder" — the bash prefix element)',
    'The user message text renderer structure may have changed',
  ]);
  process.exit(1);
}

const [renderOriginal, cacheVar, slot1, textVar, elemVar, factoryVar, textComp, slot2] = renderMatch;

// Replace the text child with a conditional bold prefix. Bare-factory form:
// FACTORY(COMP, props, key). Array children render fine through the single-child
// jsx factory in a production build (the jsx/jsxs split only affects dev-mode
// key warnings).
const renderReplacement =
  `if(${cacheVar}[${slot1}]!==${textVar})` +
  `${elemVar}=${factoryVar}(${textComp},{color:"text",children:` +
  `${textVar}[0]=="\\u23F0"?` +
  `[${factoryVar}(${textComp},{bold:!0,children:${textVar}.slice(0,11)},"cp"),${textVar}.slice(11)]:` +
  `${textVar}}),` +
  `${cacheVar}[${slot1}]=${textVar},` +
  `${cacheVar}[${slot2}]=${elemVar};` +
  `else ${elemVar}=${cacheVar}[${slot2}]`;

output.discovery('user-message text renderer (memo-cache)', renderOriginal.slice(0, 80) + '...', {
  'factory var': factoryVar,
  'Text component': textComp,
  'text var': textVar,
  'cache var': cacheVar,
  'memo slots': `${slot1}, ${slot2}`,
});

patched = patched.replace(renderMatch[0], () => renderReplacement);

output.modification('cron prefix styling',
  renderOriginal.slice(0, 80) + '...',
  renderReplacement.slice(0, 80) + '...',
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

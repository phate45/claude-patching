#!/usr/bin/env node
/**
 * Patch: stop background subagents from notifying the main thread while they
 * wait on their own background work, and after a SubagentHandback delivery.
 *
 * Two upstream behaviours, both in the async-agent completion sequence:
 *
 * 1. Interim notifications. When a backgrounded subagent ends its turn with
 *    live background children, two predicates classify it:
 *
 *      fae(id,reg)  — true only for `agent:` keepalives        → PARK
 *      Zqe(id,reg)  — `agent:`, or (backgrounded) `workflow:`,
 *                     or (backgrounded && tengu_concurrent_shore) `bash:`
 *
 *    Parking defers the owner notification until the subagent resumes and
 *    finishes. A subagent waiting on its own auto-backgrounded Bash does not
 *    park: it falls through to $ot(), which enqueues a task-notification to the
 *    main thread ("stopped with background work of its own still running … may
 *    be interim", result = "This agent has not reported yet"). Resume resets
 *    `notified`, so every wait cycle repeats it. Not gated on the Workflow
 *    feature — tengu_concurrent_shore defaults on.
 *
 *    Fix: park on the Zqe() predicate. The bash task's completion still routes
 *    to the parked subagent and wakes it (the same path the interim case uses
 *    today); only the main-thread notification is deferred.
 *
 * 2. Post-handback pointer. A SubagentHandback call delivers the report as a
 *    mailbox message. When the subagent then stops, $ot() fires again with a
 *    pointer ("This agent's report was delivered to you as a message … it is
 *    not repeated here"). With WPn()'s handback === "send" the pointer carries
 *    nothing, so $ot() returns after its notified claim and keepalive cleanup,
 *    before the enqueue. "flagged" (auto-mode security warning) and
 *    "withheld" (no report delivered) still notify.
 *
 *    Since 2.1.292 upstream marks some pointers `shouldQuery:false` (gated on
 *    tengu_hushed_kestrel, main-thread recipient, single-block report). Those
 *    still enqueue and still reach the model; this patch drops them entirely.
 *
 * The flag reaches $ot() as an extra key on its argument object, read through
 * `arguments[0]`: $ot lives in a different chunk, and the object crosses
 * chunks where a captured identifier would not.
 *
 * Usage:
 *   node patch-quiet-subagent-waits.js <cli.js path>
 *   node patch-quiet-subagent-waits.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-quiet-subagent-waits.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

const FLAG = '__quietHandback';
let patchCount = 0;

// ── Point 1: park on the interim predicate ──
// Minified:
//   let mt=fae(e,T),nt=Zqe(e,T);if(!mt)Pe("completed");
// The var tested by `if(!X)LOG("completed")` is the park decision.
const p1 = /let ([$\w]+)=([$\w]+)\(([$\w]+),([$\w]+)\),([$\w]+)=([$\w]+)\(\3,\4\);if\(!\1\)([$\w]+)\("completed"\)/;
const m1 = content.match(p1);

if (!m1) {
  output.error('Could not find async-agent park decision', [
    'Expected: let PARK=fae(id,reg),INTERIM=Zqe(id,reg);if(!PARK)LOG("completed")',
  ]);
  process.exit(1);
}

const [p1Original, parkVar, parkFn, idVar, regVar, interimVar, interimFn, logFn] = m1;
const p1Replacement =
  `let ${parkVar}=${interimFn}(${idVar},${regVar}),${interimVar}=${interimFn}(${idVar},${regVar});` +
  `if(!${parkVar})${logFn}("completed")`;

output.discovery('async-agent park decision', p1Original, {
  'park fn': parkFn,
  'interim fn': interimFn,
});
output.modification('park on interim keepalives', `${parkVar}=${parkFn}(…)`, `${parkVar}=${interimFn}(…)`);

content = content.replace(p1Original, p1Replacement);
patchCount++;

// ── Point 2: tag the completed-notification call when handback was sent ──
// Minified:
//   $ot({taskId:e,runId:J,description:g,status:"completed",taskRegistry:T,finalMessage:wt,
//        …,usage:{totalTokens:Math.max(q$n(he),Je.totalTokens),…},…})
// Je is WPn()'s result, which carries handback:"send"|"flagged"|"withheld".
const p2 = /([$\w]+)\(\{taskId:[$\w]+,(?:runId:[$\w]+,)?description:[$\w]+,status:"completed",taskRegistry:[$\w]+,finalMessage:[$\w]+,maxTurnsReached:[$\w]+,(?:callerCanContinueAgents:[$\w.]+,)?usage:\{totalTokens:Math\.max\([$\w]+\([$\w]+\),([$\w]+)\.totalTokens\)/;
const m2 = content.match(p2);

if (!m2) {
  output.error('Could not find async-agent completed-notification call', [
    'Expected: NOTIFY({taskId:…,[runId:…,]description:…,status:"completed",taskRegistry:…,finalMessage:…,maxTurnsReached:…,[callerCanContinueAgents:…,]usage:{totalTokens:Math.max(F(x),RES.totalTokens)',
  ]);
  process.exit(1);
}

const [p2Original, notifyFn, resultVar] = m2;
const p2Replacement = p2Original.replace(
  `${notifyFn}({`,
  `${notifyFn}({${FLAG}:${resultVar}.handback==="send",`
);

output.discovery('completed-notification call', `${notifyFn}({…})`, {
  'notify fn': notifyFn,
  'WPn result var': resultVar,
});
output.modification('tag sent handback', `${notifyFn}({taskId:`, `${notifyFn}({${FLAG}:${resultVar}.handback==="send",taskId:`);

content = content.replace(p2Original, p2Replacement);
patchCount++;

// ── Point 3: return after the claim when the tag is set ──
// Minified (inside $ot, after Sq() claims notified and Fot() clears keepalive):
//   if(!_e){t(`[enqueueAgentNotification] skipped …`,{level:…});return}
const p3 = /\[enqueueAgentNotification\] skipped [^`]*`,\{level:[^}]*\}\);return\}/;
const m3 = content.match(p3);

if (!m3) {
  output.error('Could not find enqueueAgentNotification claim guard', [
    'Expected: if(!CLAIMED){LOG(`[enqueueAgentNotification] skipped …`,{level:…});return}',
  ]);
  process.exit(1);
}

const p3Original = m3[0];
const p3Replacement = `${p3Original}if(arguments[0].${FLAG})return;`;

output.discovery('enqueueAgentNotification claim guard', p3Original.slice(0, 60) + '…');
output.modification('skip enqueue after sent handback', 'return}', `return}if(arguments[0].${FLAG})return;`);

content = content.replace(p3Original, p3Replacement);
patchCount++;

// ── Write ──

if (patchCount !== 3) {
  output.error(`Expected 3 patches, got ${patchCount}`);
  process.exit(1);
}

if (dryRun) {
  output.result('dry_run', `quiet-subagent-waits: ${patchCount}/3 patches verified`);
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `quiet-subagent-waits: ${patchCount}/3 patches applied`);
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

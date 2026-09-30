#!/usr/bin/env node
/**
 * turn-timestamp — show the turn-end time as a local-time stamp.
 *
 * 2.1.246 made turn-end timestamping NATIVE: the completed-turn status line now
 * renders `${verb} for ${elapsed}${doneAt?` · done ${doneAt}`:""}`, e.g.
 *     "Sautéed for 23s · done 6:05 PM"
 * where `doneAt` is `Vs(msg.timestamp)` — the stored timestamp reformatted to a
 * locale time string ("6:05 PM"). `msg.timestamp` is stamped by the turn_duration
 * factory as `new Date().toISOString()`, i.e. it is ALREADY a full ISO 8601
 * string — native just downgrades it to locale time for display.
 *
 * This patch cooperates with the now-native line instead of injecting its own:
 * it swaps the `Vs()` reformat for an inline formatter rendering the stored
 * UTC instant in LOCAL time as `[YYYY-MM-DD HH:MM:SS]` —
 *     "Sautéed for 23s · done [2026-08-26 14:06:29]"
 * Local conversion is `d - d.getTimezoneOffset()*6e4` before `toISOString()`,
 * which follows DST because the offset is read from the instant itself (CEST
 * -120 in summer, CET -60 in winter).
 *
 * The message var is captured from the `doneAt:FMT(MSG.timestamp)` site; the
 * `MSG.timestamp&&…` guard keeps the value falsy while a turn is running
 * (timestamp undefined), so the `${doneAt?…:""}` guard still renders nothing
 * mid-turn. The site is a plain object literal, so the double-quoted bracket
 * literals need no escaping.
 *
 * Point 2 (2.1.284): when the turn ends with background agents or workflows
 * still pending, the same row renders `Waiting for N background agent(s) to
 * finish` INSTEAD of the `${verb} for ${elapsed}` template, and that branch
 * never reads doneAt. The render site is
 *     E&&(qe?be:e(n,{dimColor:!0,children:`${h} for ${V}${j?…}`}))
 * where `be` is the dim "Waiting for…" Text and `j` is doneAt. The patch wraps
 * the waiting branch in a dim Text that appends the same ` · done ${j}` suffix:
 *     E&&(qe?r(n,{dimColor:!0,children:[be,j&&` · done ${j}`]}):…)
 * `r` (jsxs) is captured from the enclosing `r(n,{children:[E&&(` call, so it
 * is the same chunk's binding. The row's memo already keys on `j` and `be`.
 *
 * Usage:
 *   node patch-turn-timestamp.js <cli.js path>
 *   node patch-turn-timestamp.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-turn-timestamp.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// ── Patch Point: reformat the native doneAt from locale time to full ISO ──
// Match `doneAt:FORMATTER(MSG.timestamp)` — capture the message var, drop the
// formatter so the raw ISO string (msg.timestamp) is shown directly.
const pattern = /doneAt:[\w$]+\(([\w$]+)\.timestamp\)/g;
const matches = [...content.matchAll(pattern)];

if (matches.length === 0) {
  output.error('Could not find the native doneAt formatter (doneAt:FMT(msg.timestamp))', [
    'Expected: doneAt:Vs(ut.timestamp) in the turn_duration render builder',
    'The end-of-turn duration line may have been restructured',
  ]);
  process.exit(1);
}

if (matches.length > 1) {
  output.error(`Ambiguous doneAt match: expected 1, found ${matches.length}`);
  process.exit(1);
}

const [full, msg] = matches[0];
output.discovery('doneAt formatter', full, { 'message var': msg });

const replacement =
  `doneAt:${msg}.timestamp&&(d=>"["` +
  `+new Date(d-d.getTimezoneOffset()*6e4).toISOString().slice(0,19).replace("T"," ")` +
  `+"]")(new Date(${msg}.timestamp))`;
content = content.replace(pattern, () => replacement);

output.modification('turn-end timestamp → local [YYYY-MM-DD HH:MM:SS]', full, replacement);

// ── Patch Point 2: append doneAt to the "Waiting for N background agents" row ──
// Match `JSXS(TEXT,{children:[SHOW&&(PENDING?WAITING:JSX(TEXT,{dimColor:!0,
// children:`${verb} for ${elapsed}${DONE?` — the waiting branch sits right
// beside the native doneAt template, which pins the match to this row.
const waitPattern =
  /([\w$]+)\(([\w$]+),\{children:\[([\w$]+)&&\(([\w$]+)\?([\w$]+):([\w$]+)\(\2,\{dimColor:!0,children:`\$\{[\w$]+\} for \$\{[\w$]+\}\$\{([\w$]+)\?/g;
const waitMatches = [...content.matchAll(waitPattern)];

if (waitMatches.length !== 1) {
  output.error(`Waiting-for-agents row: expected 1 match, found ${waitMatches.length}`, [
    'Expected: r(n,{children:[E&&(qe?be:e(n,{dimColor:!0,children:`${h} for ${V}${j?` in the turn_duration row',
    'The pending-agents branch may have been restructured',
  ]);
  process.exit(1);
}

const [waitFull, jsxs, text, show, pending, waiting, jsx, doneAt] = waitMatches[0];
output.discovery('waiting-for-agents row', waitFull.slice(0, 80), {
  jsxs, text, 'waiting element': waiting, 'doneAt var': doneAt,
});

const waitOld = `${show}&&(${pending}?${waiting}:${jsx}(`;
const waitNew =
  `${show}&&(${pending}?${jsxs}(${text},{dimColor:!0,children:[${waiting},${doneAt}&&\` \\xB7 done \${${doneAt}}\`]}):${jsx}(`;
const waitReplaced = waitFull.replace(waitOld, () => waitNew);
content = content.replace(waitFull, () => waitReplaced);

output.modification('waiting-for-agents row → append done timestamp', waitOld, waitNew);

if (dryRun) {
  output.result('dry_run', 'turn-timestamp: 2/2 patches verified');
} else {
  fs.writeFileSync(targetPath, content, 'utf8');
  output.result('success', 'turn-timestamp: 2/2 patches applied');
}

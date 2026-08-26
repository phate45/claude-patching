#!/usr/bin/env node
/**
 * patch-mode-cycle-order.js
 *
 * Reorders the shift+tab permission-mode cycle so bypassPermissions comes
 * before plan. The forward cycle is driven entirely by one function (lBH in
 * 2.1.170, minified to `M(e,o)` in 2.1.246) that maps the current mode to the
 * next one:
 *
 *   default → acceptEdits → plan → bypassPermissions → auto → default   (stock)
 *   default → acceptEdits → bypassPermissions → plan → auto → default   (patched)
 *
 * 2.1.246 change: the bypassPermissions availability check moved from an inline
 * `\2.isBypassPermissionsModeAvailable` property read into a helper call — the
 * `case"plan":` branch now reads `if(p(e))return"bypassPermissions"`. Both the
 * bypass-gate helper and the auto-mode gate helper are captured (not hardcoded),
 * so the reorder re-emits them in their new positions and survives renames.
 *
 *   default → acceptEdits → plan → bypassPermissions → auto → default   (stock)
 *
 * bypassPermissions stays gated behind its helper, so the guard moves with it:
 * when bypass is unavailable, acceptEdits falls straight through to plan. auto
 * and dontAsk are untouched. shift+tab is forward-only — no reverse counterpart.
 *
 * Usage:
 *   node patch-mode-cycle-order.js <cli.js path>
 *   node patch-mode-cycle-order.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-mode-cycle-order.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Match the next-mode switch. Captures:
//   $1 = `function <name>(` up to the open paren
//   $2 = the context arg var (referenced as \2.mode / helper(\2))
//   $3 = `,<other>){switch(<arg>.mode){`
//   $4 = the bypass-availability gate helper (p) — new in 2.1.246, was inline
//   $5 = the auto-mode gate helper
//   $6 = the trailing dontAsk + default fallthrough cases, re-emitted verbatim
const pattern =
  /(function [\w$]+\()([\w$]+)(,[\w$]+\)\{switch\(\2\.mode\)\{)case"default":return"acceptEdits";case"acceptEdits":return"plan";case"plan":if\(([\w$]+)\(\2\)\)return"bypassPermissions";if\(([\w$]+)\(\2\)\)return"auto";return"default";case"bypassPermissions":if\(\5\(\2\)\)return"auto";return"default";(case"dontAsk":return"default";default:return"default"\}\})/;

const match = content.match(pattern);

if (!match) {
  output.error('Could not find permission-mode cycle switch (lBH)', [
    'The shift+tab next-mode function may have been restructured',
    'Expected: switch(ctx.mode){case"default":return"acceptEdits";case"acceptEdits":return"plan";case"plan":if(bypassGate(ctx))return"bypassPermissions";…}',
  ]);
  process.exit(1);
}

const [, fnOpen, argVar, switchHead, bypassGate, autoGate, tail] = match;

output.discovery('mode-cycle switch', match[0].slice(0, 60) + '…', {
  'arg var': argVar,
  'bypass gate': `${bypassGate}()`,
  'auto-mode gate': `${autoGate}()`,
});

// Reordered body: acceptEdits → bypassPermissions (if available, else plan),
// bypassPermissions → plan, plan → auto (if gated) else default.
const newBody =
  `case"default":return"acceptEdits";` +
  `case"acceptEdits":if(${bypassGate}(${argVar}))return"bypassPermissions";return"plan";` +
  `case"bypassPermissions":return"plan";` +
  `case"plan":if(${autoGate}(${argVar}))return"auto";return"default";`;

const replacement = `${fnOpen}${argVar}${switchHead}${newBody}${tail}`;

output.modification('mode cycle order',
  'default→acceptEdits→plan→bypassPermissions→auto',
  'default→acceptEdits→bypassPermissions→plan→auto');

if (dryRun) {
  output.result('dry_run', 'Mode-cycle switch found — ready to patch');
  process.exit(0);
}

// Function replacer: minified identifiers contain `$`, which would otherwise
// be interpreted as replacement patterns ($&, $1, …).
content = content.replace(match[0], () => replacement);

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Reordered permission-mode cycle in ${targetPath}`);
  output.info('shift+tab now cycles: default → acceptEdits → bypassPermissions → plan → auto');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * patch-mode-cycle-order.js
 *
 * Reorders the shift+tab permission-mode cycle so auto leads and
 * bypassPermissions is one press away from it. The forward cycle is driven
 * entirely by one function (`Hxt(e,o)` in 2.1.289) that maps the current mode
 * to the next one:
 *
 *   default → acceptEdits → plan → bypassPermissions → auto → default   (stock)
 *   auto → bypassPermissions → acceptEdits → plan → default → auto      (patched)
 *
 * Stock has no `case"auto"`: auto falls through `default:` to "default". The
 * patch adds one. Both the bypass-gate helper and the auto-mode gate helper are
 * captured (not hardcoded) and re-emitted in their new positions, so each guard
 * moves with its mode: without auto, default steps to bypassPermissions; without
 * bypass, auto and default step to acceptEdits. The mode transition handler is
 * generic over (from, to), so the new auto → bypassPermissions hop still
 * restores the rules auto mode stashed on entry. dontAsk is untouched.
 * shift+tab is forward-only, no reverse counterpart.
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

// Reordered body: default → auto (if gated), auto → bypassPermissions (if
// available), each falling through to the next stop when its gate is closed.
const newBody =
  `case"default":if(${autoGate}(${argVar}))return"auto";if(${bypassGate}(${argVar}))return"bypassPermissions";return"acceptEdits";` +
  `case"auto":if(${bypassGate}(${argVar}))return"bypassPermissions";return"acceptEdits";` +
  `case"bypassPermissions":return"acceptEdits";` +
  `case"acceptEdits":return"plan";` +
  `case"plan":return"default";`;

const replacement = `${fnOpen}${argVar}${switchHead}${newBody}${tail}`;

output.modification('mode cycle order',
  'default→acceptEdits→plan→bypassPermissions→auto',
  'auto→bypassPermissions→acceptEdits→plan→default');

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
  output.info('shift+tab now cycles: auto → bypassPermissions → acceptEdits → plan → default');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

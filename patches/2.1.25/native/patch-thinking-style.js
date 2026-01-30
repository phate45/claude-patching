#!/usr/bin/env node
/**
 * Patch to style thinking block content with dim gray text (2.1.25+)
 *
 * This patch:
 * 1. Modifies the markdown renderer to accept a `dim` prop
 * 2. When dim=true, wraps rendered text in chalk.dim.italic()
 * 3. Modifies the thinking component to pass dim:!0 to the markdown renderer
 *
 * Changes from 2.1.19:
 * - Box component variable name is now dynamic (was hardcoded as `z`)
 *
 * Usage:
 *   node patch-thinking-style.js <cli.js path>
 *   node patch-thinking-style.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-thinking-style.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}:`, [err.message]);
  process.exit(1);
}

// ============================================================
// PATCH 1: Find markdown renderer and its f() helper function
// ============================================================

// Find the f() helper function pattern inside markdown renderer
// Pattern: function f(){if(B)D.push(REACT.default.createElement(COMP,{key:D.length},B.trim())),B=""}
const fFuncPattern = /function f\(\)\{if\(([$\w]+)\)([$\w]+)\.push\(([$\w]+)\.default\.createElement\(([$\w]+),\{key:([$\w]+)\.length\},([$\w]+)\.trim\(\)\)\),([$\w]+)=""\}/;
const fFuncMatch = content.match(fFuncPattern);

if (!fFuncMatch) {
  output.error('Could not find f() function pattern (markdown renderer helper)');
  process.exit(1);
}

// Extract variable names from f() function
const bVar = fFuncMatch[1];      // B (accumulated string)
const dVar = fFuncMatch[2];      // D (elements array)
const reactVar = fFuncMatch[3];  // React module
const compVar = fFuncMatch[4];   // text component
const bVar3 = fFuncMatch[7];     // B again (reset)

output.discovery('helper function', 'f()', {
  'String accumulator': bVar,
  'Elements array': dVar,
  'React var': reactVar,
  'Text component': compVar
});

// Now find the containing markdown renderer function
// Pattern: function FUNCNAME({children:VAR}){...function f(){if
const mdWithFPattern = /function ([$\w]+)\(\{children:([$\w]+)\}\)\{.{50,500}function f\(\)\{if/;
const mdWithFMatch = content.match(mdWithFPattern);

if (!mdWithFMatch) {
  output.error('Could not find markdown renderer function containing f()');
  process.exit(1);
}

const mdFuncName = mdWithFMatch[1];
const childrenVar = mdWithFMatch[2];
output.discovery('markdown renderer', mdFuncName, {
  'Children variable': childrenVar
});

// Helper to escape regex special characters
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Build the signature pattern dynamically
const mdSigPattern = new RegExp(`function ${escapeRegex(mdFuncName)}\\(\\{children:${escapeRegex(childrenVar)}\\}\\)`);
const mdSigMatch = content.match(mdSigPattern);

if (!mdSigMatch) {
  output.error(`Could not match ${mdFuncName} signature`);
  process.exit(1);
}

// Find chalk variable - it's used with .dim.italic
const chalkPattern = /\b([$\w]+)\.dim\.italic\(/;
const chalkMatch = content.match(chalkPattern);

if (!chalkMatch) {
  output.error('Could not find chalk variable');
  process.exit(1);
}

const chalkVar = chalkMatch[1];
output.discovery('chalk variable', chalkVar);

// ============================================================
// PATCH 2: Find markdown renderer call in thinking component
// ============================================================

// Pattern: createElement(BOX,{paddingLeft:2},createElement(MDFUNC,null,VAR))
// BOX is now dynamic (was hardcoded as `z` in older versions)
const thinkingMdPattern = new RegExp(
  `([$\\w]+\\.default\\.createElement)\\(([$\\w]+),\\{paddingLeft:2\\},([$\\w]+\\.default\\.createElement)\\(${escapeRegex(mdFuncName)},null,([$\\w]+)\\)\\)`
);
const thinkingMdMatch = content.match(thinkingMdPattern);

if (!thinkingMdMatch) {
  output.error(`Could not find thinking ${mdFuncName} pattern`);
  process.exit(1);
}

const outerReact = thinkingMdMatch[1];  // React.default.createElement
const boxComp = thinkingMdMatch[2];      // Box component (T, z, etc.)
const innerReact = thinkingMdMatch[3];   // React.default.createElement
const thinkingVar = thinkingMdMatch[4];  // H (thinking content)

output.discovery('thinking call', mdFuncName, {
  'Box component': boxComp,
  'Thinking var': thinkingVar
});

// ============================================================
// Apply patches
// ============================================================

output.section(`Modify ${mdFuncName} signature`, { index: 1 });
const newMdSig = `function ${mdFuncName}({children:${childrenVar},dim:_dimStyle})`;
output.modification('function signature', mdSigMatch[0], newMdSig);

output.section('Modify f() function', { index: 2 });
// New f function that checks _dimStyle and wraps in chalk.dim.italic if true
const newFFunc = `function f(){if(${bVar}){let _t=${bVar}.trim();if(_dimStyle)_t=${chalkVar}.dim.italic(_t);${dVar}.push(${reactVar}.default.createElement(${compVar},{key:${dVar}.length},_t))}${bVar3}=""}`;
output.modification('f() function', fFuncMatch[0].slice(0, 80) + '...', newFFunc.slice(0, 80) + '...');

output.section('Modify thinking component to pass dim:!0', { index: 3 });
// Change createElement(MDFUNC,null,H) to createElement(MDFUNC,{dim:!0},H)
const oldMdCall = `${innerReact}(${mdFuncName},null,${thinkingVar})`;
const newMdCall = `${innerReact}(${mdFuncName},{dim:!0},${thinkingVar})`;
output.modification('thinking component call', oldMdCall, newMdCall);

if (dryRun) {
  output.result('dry_run', 'no changes made');
  process.exit(0);
}

// Apply all patches
let patchedContent = content;

// Patch 1: Markdown renderer signature
patchedContent = patchedContent.replace(mdSigMatch[0], newMdSig);

// Patch 2: f() function
patchedContent = patchedContent.replace(fFuncMatch[0], newFFunc);

// Patch 3: Markdown renderer call in thinking component
patchedContent = patchedContent.replace(oldMdCall, newMdCall);

// Verify changes were made
const changes = [
  content !== patchedContent,
  patchedContent.includes('dim:_dimStyle'),
  patchedContent.includes('if(_dimStyle)'),
  patchedContent.includes('{dim:!0}')
];

if (!changes.every(Boolean)) {
  output.error('Some patches failed to apply', [
    `Content changed: ${changes[0]}`,
    `dimStyle in sig: ${changes[1]}`,
    `dimStyle check: ${changes[2]}`,
    `dim:!0 prop: ${changes[3]}`
  ]);
  process.exit(1);
}

// Write patched file
try {
  fs.writeFileSync(targetPath, patchedContent);
  output.result('success', `All patches applied to ${targetPath}`);
  output.info('Thinking blocks will now render with dim gray text.');
} catch (err) {
  output.error(`Failed to write patched file`, [err.message]);
  process.exit(1);
}

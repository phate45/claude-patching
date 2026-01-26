#!/usr/bin/env node
/**
 * Patch to style thinking block content with dim gray text (2.1.19+)
 *
 * This patch:
 * 1. Modifies VJ (markdown renderer) to accept a `dim` prop
 * 2. When dim=true, wraps rendered text in chalk.dim.italic()
 * 3. Modifies n7$ (thinking component) to pass dim:!0 to VJ
 *
 * Changes from 2.1.14:
 * - Markdown renderer changed from QV to VJ
 * - Helper function changed from X() to f()
 * - Variable names differ throughout
 *
 * Usage:
 *   node patch-thinking-style.js <cli.js path>
 *   node patch-thinking-style.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  console.error('Usage: node patch-thinking-style.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  console.error(`Failed to read ${targetPath}:`, err.message);
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
  console.error('❌ Could not find f() function pattern (markdown renderer helper)');
  process.exit(1);
}

// Extract variable names from f() function
const bVar = fFuncMatch[1];      // B (accumulated string)
const dVar = fFuncMatch[2];      // D (elements array)
const reactVar = fFuncMatch[3];  // E7$ (React)
const compVar = fFuncMatch[4];   // p1 (text component)
const bVar2 = fFuncMatch[6];     // B again (in trim())
const bVar3 = fFuncMatch[7];     // B again (reset)

console.log(`✓ Found f() function`);
console.log(`  String accumulator: ${bVar}`);
console.log(`  Elements array: ${dVar}`);
console.log(`  React var: ${reactVar}`);
console.log(`  Text component: ${compVar}`);

// Now find the containing markdown renderer function
// Pattern: function FUNCNAME({children:VAR}){...function f(){if
const mdWithFPattern = /function ([$\w]+)\(\{children:([$\w]+)\}\)\{.{50,500}function f\(\)\{if/;
const mdWithFMatch = content.match(mdWithFPattern);

if (!mdWithFMatch) {
  console.error('❌ Could not find markdown renderer function containing f()');
  process.exit(1);
}

const mdFuncName = mdWithFMatch[1];
const childrenVar = mdWithFMatch[2];
console.log(`✓ Found markdown renderer: ${mdFuncName}, children variable: ${childrenVar}`);

// Helper to escape regex special characters
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Build the signature pattern dynamically
const mdSigPattern = new RegExp(`function ${escapeRegex(mdFuncName)}\\(\\{children:${escapeRegex(childrenVar)}\\}\\)`);
const mdSigMatch = content.match(mdSigPattern);

if (!mdSigMatch) {
  console.error(`❌ Could not match ${mdFuncName} signature`);
  process.exit(1);
}

// Find chalk variable - it's used with .dim.italic
const chalkPattern = /\b([$\w]+)\.dim\.italic\(/;
const chalkMatch = content.match(chalkPattern);

if (!chalkMatch) {
  console.error('❌ Could not find chalk variable');
  process.exit(1);
}

const chalkVar = chalkMatch[1];
console.log(`✓ Found chalk variable: ${chalkVar}`);

// ============================================================
// PATCH 2: Find markdown renderer call in thinking component
// ============================================================

// Pattern: createElement(MDFUNC,null,H) within thinking component context
// Look for the paddingLeft:2 box containing the markdown call
const thinkingMdPattern = new RegExp(
  `([$\\w]+\\.default\\.createElement)\\(z,\\{paddingLeft:2\\},([$\\w]+\\.default\\.createElement)\\(${escapeRegex(mdFuncName)},null,([$\\w]+)\\)\\)`
);
const thinkingMdMatch = content.match(thinkingMdPattern);

if (!thinkingMdMatch) {
  console.error(`❌ Could not find thinking ${mdFuncName} pattern`);
  process.exit(1);
}

const thinkingVar = thinkingMdMatch[3]; // H (thinking content)
console.log(`✓ Found thinking ${mdFuncName} call, thinking var: ${thinkingVar}`);

// ============================================================
// Apply patches
// ============================================================

console.log();
console.log(`=== Patch 1: Modify ${mdFuncName} signature ===`);
const newMdSig = `function ${mdFuncName}({children:${childrenVar},dim:_dimStyle})`;
console.log(`  Old: ${mdSigMatch[0]}`);
console.log(`  New: ${newMdSig}`);

console.log();
console.log('=== Patch 2: Modify f() function ===');
// New f function that checks _dimStyle and wraps in chalk.dim.italic if true
const newFFunc = `function f(){if(${bVar}){let _t=${bVar}.trim();if(_dimStyle)_t=${chalkVar}.dim.italic(_t);${dVar}.push(${reactVar}.default.createElement(${compVar},{key:${dVar}.length},_t))}${bVar3}=""}`;
console.log(`  Old: ${fFuncMatch[0].slice(0, 80)}...`);
console.log(`  New: ${newFFunc.slice(0, 80)}...`);

console.log();
console.log(`=== Patch 3: Modify thinking component to pass dim:!0 ===`);
// Change createElement(MDFUNC,null,H) to createElement(MDFUNC,{dim:!0},H)
const oldMdCall = `${thinkingMdMatch[2]}(${mdFuncName},null,${thinkingVar})`;
const newMdCall = `${thinkingMdMatch[2]}(${mdFuncName},{dim:!0},${thinkingVar})`;
console.log(`  Old: ${oldMdCall}`);
console.log(`  New: ${newMdCall}`);

if (dryRun) {
  console.log();
  console.log('(Dry run - no changes made)');
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
  console.error('❌ Some patches failed to apply');
  console.error('  Content changed:', changes[0]);
  console.error('  dimStyle in sig:', changes[1]);
  console.error('  dimStyle check:', changes[2]);
  console.error('  dim:!0 prop:', changes[3]);
  process.exit(1);
}

// Write patched file
try {
  fs.writeFileSync(targetPath, patchedContent);
  console.log();
  console.log(`✓ All patches applied to ${targetPath}`);
  console.log();
  console.log('Thinking blocks will now render with dim gray text.');
} catch (err) {
  console.error(`Failed to write patched file: ${err.message}`);
  process.exit(1);
}

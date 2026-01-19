#!/usr/bin/env node
/**
 * Patch to style thinking block content with dim gray text
 *
 * This patch:
 * 1. Modifies QV (markdown renderer) to accept a `dim` prop
 * 2. When dim=true, wraps rendered text in chalk.dim()
 * 3. Modifies dvA (thinking component) to pass dim:!0 to QV
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
// PATCH 1: Modify QV to accept dim prop and apply styling
// ============================================================

// Find QV function: function QV({children:A}){...}
// We need to:
// 1. Change signature to accept dim: function QV({children:A,dim:dimStyle})
// 2. Modify the X() function to wrap text in W1.dim() when dimStyle is true

// Find the markdown renderer by locating its unique X() helper function
// The X() function has a distinctive pattern: function X(){if(J)Y.push(...createElement(TextComponent,{key:Y.length},J.trim()))...
// First find this pattern, then extract the containing function name
const xFuncPattern = /function X\(\)\{if\(([$\w]+)\)([$\w]+)\.push\(([$\w]+)\.default\.createElement\(([$\w]+),\{key:([$\w]+)\.length\},([$\w]+)\.trim\(\)\)\),([$\w]+)=""\}/;
const xFuncMatch = content.match(xFuncPattern);

if (!xFuncMatch) {
  console.error('❌ Could not find X() function pattern (markdown renderer helper)');
  process.exit(1);
}

// Now find the containing function by looking for the pattern that includes both signature and X()
// Pattern: function FUNCNAME({children:VAR}){...up to 500 chars...function X(){if
// Use bounded match to avoid spanning across multiple functions
const mdWithXPattern = /function ([$\w]+)\(\{children:([$\w]+)\}\)\{.{50,500}function X\(\)\{if/;
const mdWithXMatch = content.match(mdWithXPattern);

if (!mdWithXMatch) {
  console.error('❌ Could not find markdown renderer function containing X()');
  process.exit(1);
}

const mdFuncName = mdWithXMatch[1];
const childrenVar = mdWithXMatch[2];
console.log(`✓ Found markdown renderer: ${mdFuncName}, children variable: ${childrenVar}`);

// Helper to escape regex special characters
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Build the signature pattern dynamically (escape $ in variable names)
const mdSigPattern = new RegExp(`function ${escapeRegex(mdFuncName)}\\(\\{children:${escapeRegex(childrenVar)}\\}\\)`);
const mdSigMatch = content.match(mdSigPattern);

if (!mdSigMatch) {
  console.error(`❌ Could not match ${mdFuncName} signature (this shouldn't happen)`);
  process.exit(1);
}

console.log(`✓ Found X() function`);

// Extract variable names
const jVar = xFuncMatch[1];      // J (accumulated string)
const yVar = xFuncMatch[2];      // Y (elements array)
const reactVar = xFuncMatch[3];  // lZ1 (React)
const c8Var = xFuncMatch[4];     // C8 (text component)
const jVar2 = xFuncMatch[6];     // J again (in trim())
const jVar3 = xFuncMatch[7];     // J again (reset)

console.log(`✓ Found X() function`);
console.log(`  String accumulator: ${jVar}`);
console.log(`  React var: ${reactVar}`);
console.log(`  C8 component: ${c8Var}`);

// Find W1 (chalk) - it's used in WE function
const chalkPattern = /\b([$\w]+)\.dim\.italic\(/;
const chalkMatch = content.match(chalkPattern);

if (!chalkMatch) {
  console.error('❌ Could not find chalk variable');
  process.exit(1);
}

const chalkVar = chalkMatch[1];
console.log(`✓ Found chalk variable: ${chalkVar}`);

// ============================================================
// PATCH 2: Modify dvA to pass dim:!0 to QV
// ============================================================

// Find the markdown renderer call in thinking component
// Pattern: createElement(BOX,{paddingLeft:2},createElement(MDFUNC,null,A))
// In context with "∴ Thinking…"
// Box component can be T or j depending on version
const thinkingMdPattern = new RegExp(
  `([$\\w]+\\.default\\.createElement)\\([$\\w]+,\\{dimColor:!0,italic:!0\\},"∴ Thinking…"\\),([$\\w]+\\.default\\.createElement)\\([$\\w]+,\\{paddingLeft:2\\},([$\\w]+\\.default\\.createElement)\\(${escapeRegex(mdFuncName)},null,([$\\w]+)\\)\\)`
);
const thinkingMdMatch = content.match(thinkingMdPattern);

if (!thinkingMdMatch) {
  console.error(`❌ Could not find thinking ${mdFuncName} pattern`);
  process.exit(1);
}

const thinkingVar = thinkingMdMatch[4]; // A (thinking content)
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
console.log('=== Patch 2: Modify X() function ===');
// New X function that checks _dimStyle and wraps in chalk.dim if true
const newXFunc = `function X(){if(${jVar}){let _t=${jVar}.trim();if(_dimStyle)_t=${chalkVar}.dim.italic(_t);${yVar}.push(${reactVar}.default.createElement(${c8Var},{key:${yVar}.length},_t))}${jVar3}=""}`;
console.log(`  Old: ${xFuncMatch[0].slice(0, 80)}...`);
console.log(`  New: ${newXFunc.slice(0, 80)}...`);

console.log();
console.log(`=== Patch 3: Modify thinking component to pass dim:!0 ===`);
// Change createElement(MDFUNC,null,A) to createElement(MDFUNC,{dim:!0},A)
const oldMdCall = `${thinkingMdMatch[3]}(${mdFuncName},null,${thinkingVar})`;
const newMdCall = `${thinkingMdMatch[3]}(${mdFuncName},{dim:!0},${thinkingVar})`;
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

// Patch 2: X() function
patchedContent = patchedContent.replace(xFuncMatch[0], newXFunc);

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
  console.error('  Signature change:', changes[0]);
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

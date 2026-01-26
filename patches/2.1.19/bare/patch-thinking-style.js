#!/usr/bin/env node
/**
 * Patch to style thinking block content with dim gray text (2.1.19 bare)
 *
 * This patch:
 * 1. Modifies qO (markdown renderer) to accept a `dim` prop
 * 2. When dim=true, wraps rendered text in chalk.dim.italic()
 * 3. Modifies oG1 (thinking component) to pass dim:!0 to qO
 *
 * Bare-specific differences from native:
 * - Markdown renderer is qO (vs VJ in native)
 * - Uses function qO(A){...{children:q}=A...} (indirect destructuring)
 * - Helper is $ = function() {...} (vs named function f())
 * - Different variable names throughout
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
// PATCH 1: Find markdown renderer and its helper function
// ============================================================

// Find the qO function by looking for the specific pattern with createElement(t3,{key:...},O.trim())
// This pattern: function FUNC(A){...{children:q}=A...X=[],O="",$=function(){if(O)X.push(...createElement(t3,{key:X.length},O.trim()))
// We search for the helper function with t3 component first, then work backwards to find the function name.

// First find the helper function that uses t3 (text component) - this is unique to qO
const helperPattern = /([$\w]+)=function\(\)\{if\(([$\w]+)\)([$\w]+)\.push\(([$\w]+)\.default\.createElement\(t3,\{key:([$\w]+)\.length\},([$\w]+)\.trim\(\)\)\),([$\w]+)=""\}/;
const helperMatch = content.match(helperPattern);

if (!helperMatch) {
  console.error('Could not find helper function pattern (markdown renderer helper with t3)');
  process.exit(1);
}

const helperName = helperMatch[1];  // $
const strVar = helperMatch[2];      // O (string accumulator)
const arrVar = helperMatch[3];      // X (elements array)
const reactVar = helperMatch[4];    // XG1 (React)
const compVar = 't3';               // t3 (text component - fixed)
const arrVar2 = helperMatch[5];     // X (for .length)
const strVar2 = helperMatch[6];     // O (in .trim())
const strVar3 = helperMatch[7];     // O (reset)

console.log(`Found helper function: ${helperName}`);
console.log(`  String accumulator: ${strVar}`);
console.log(`  Elements array: ${arrVar}`);
console.log(`  React var: ${reactVar}`);
console.log(`  Text component: ${compVar}`);

// Now find the markdown renderer function that contains this helper
// Look for: function FUNC(A){let K=a(N),{children:q}=A ... that comes before the helper
// We search backwards from the helper position
const helperPos = content.indexOf(helperMatch[0]);
const searchSection = content.slice(Math.max(0, helperPos - 500), helperPos);

const mdSigPattern = /function ([$\w]+)\(([$\w]+)\)\{let ([$\w]+)=a\(\d+\),\{children:([$\w]+)\}=([$\w]+)/g;
let mdSigMatch;
let lastMatch = null;
while ((mdSigMatch = mdSigPattern.exec(searchSection)) !== null) {
  lastMatch = mdSigMatch;
}

if (!lastMatch) {
  console.error('Could not find markdown renderer signature pattern near helper');
  process.exit(1);
}

const mdFuncName = lastMatch[1];    // qO
const argVar = lastMatch[2];        // A
const cacheVar = lastMatch[3];      // K
const childrenVar = lastMatch[4];   // q
const argVar2 = lastMatch[5];       // A

console.log(`Found markdown renderer: ${mdFuncName}`);
console.log(`  Argument: ${argVar}, children: ${childrenVar}`);

// Find chalk variable - it's used with .dim.italic
const chalkPattern = /\b([$\w]+)\.dim\.italic\(/;
const chalkMatch = content.match(chalkPattern);

if (!chalkMatch) {
  console.error('Could not find chalk variable');
  process.exit(1);
}

const chalkVar = chalkMatch[1];
console.log(`Found chalk variable: ${chalkVar}`);

// ============================================================
// PATCH 2: Find markdown renderer call in thinking component
// ============================================================

// Pattern: createElement(I,{paddingLeft:2},REACT.default.createElement(qO,null,VAR))
const escMdFuncName = mdFuncName.replace(/\$/g, '\\$');
const thinkingMdPattern = new RegExp(
  `([$\\w]+\\.default\\.createElement)\\(I,\\{paddingLeft:2\\},([$\\w]+\\.default\\.createElement)\\(${escMdFuncName},null,([$\\w]+)\\)\\)`
);
const thinkingMdMatch = content.match(thinkingMdPattern);

if (!thinkingMdMatch) {
  console.error(`Could not find thinking ${mdFuncName} pattern`);
  process.exit(1);
}

const thinkingVar = thinkingMdMatch[3]; // J (thinking content)
console.log(`Found thinking ${mdFuncName} call, thinking var: ${thinkingVar}`);

// ============================================================
// Apply patches
// ============================================================

console.log();
console.log(`=== Patch 1: Modify ${mdFuncName} signature ===`);
const oldMdSig = lastMatch[0];
const newMdSig = `function ${mdFuncName}(${argVar}){let ${cacheVar}=a(4),{children:${childrenVar},dim:_dimStyle}=${argVar2}`;
console.log(`  Old: ${oldMdSig}`);
console.log(`  New: ${newMdSig}`);

console.log();
console.log('=== Patch 2: Modify helper function ===');
// New helper function that checks _dimStyle and wraps in chalk.dim.italic if true
const newHelper = `${helperName}=function(){if(${strVar}){let _t=${strVar}.trim();if(_dimStyle)_t=${chalkVar}.dim.italic(_t);${arrVar}.push(${reactVar}.default.createElement(${compVar},{key:${arrVar2}.length},_t))}${strVar3}=""}`;
console.log(`  Old: ${helperMatch[0].slice(0, 80)}...`);
console.log(`  New: ${newHelper.slice(0, 80)}...`);

console.log();
console.log(`=== Patch 3: Modify thinking component to pass dim:!0 ===`);
// Change createElement(qO,null,J) to createElement(qO,{dim:!0},J)
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
patchedContent = patchedContent.replace(oldMdSig, newMdSig);

// Patch 2: Helper function
patchedContent = patchedContent.replace(helperMatch[0], newHelper);

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
  console.error('Some patches failed to apply');
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
  console.log(`All patches applied to ${targetPath}`);
  console.log();
  console.log('Thinking blocks will now render with dim gray text.');
} catch (err) {
  console.error(`Failed to write patched file: ${err.message}`);
  process.exit(1);
}

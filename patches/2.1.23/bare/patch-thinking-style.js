#!/usr/bin/env node
/**
 * Patch to style thinking block content with dim gray text (2.1.23 bare)
 *
 * This patch:
 * 1. Modifies PO (markdown renderer) to accept a `dim` prop
 * 2. When dim=true, wraps rendered text in chalk.dim.italic()
 * 3. Modifies thinking component to pass dim:!0 to PO
 *
 * Changes from 2.1.20:
 * - Box component in thinking: I → S (now dynamic)
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
  output.error(`Failed to read ${targetPath}: ${err.message}`);
  process.exit(1);
}

// ============================================================
// PATCH 1: Find markdown renderer and its helper function
// ============================================================

// Find helper function by looking for the specific pattern with createElement(COMP,{key:...},VAR.trim())
// The text component name is dynamic (was t3 in 2.1.19, A9 in 2.1.20, a3 in 2.1.23)
const helperPattern = /([$\w]+)=function\(\)\{if\(([$\w]+)\)([$\w]+)\.push\(([$\w]+)\.default\.createElement\(([$\w]+),\{key:([$\w]+)\.length\},([$\w]+)\.trim\(\)\)\),([$\w]+)=""\}/;
const helperMatch = content.match(helperPattern);

if (!helperMatch) {
  output.error('Could not find helper function pattern (markdown renderer helper)');
  process.exit(1);
}

const helperName = helperMatch[1];  // $
const strVar = helperMatch[2];      // X (string accumulator)
const arrVar = helperMatch[3];      // O (elements array)
const reactVar = helperMatch[4];    // AW1 (React)
const compVar = helperMatch[5];     // a3 (text component - now dynamic)
const arrVar2 = helperMatch[6];     // O (for .length)
const strVar2 = helperMatch[7];     // X (in .trim())
const strVar3 = helperMatch[8];     // X (reset)

output.discovery('helper function', helperName, {
  'String accumulator': strVar,
  'Elements array': arrVar,
  'React var': reactVar,
  'Text component': compVar
});

// Now find the markdown renderer function that contains this helper
// Look for: function FUNC(A){let K=s(N),{children:q}=A ... that comes before the helper
const helperPos = content.indexOf(helperMatch[0]);
const searchSection = content.slice(Math.max(0, helperPos - 500), helperPos);

const mdSigPattern = /function ([$\w]+)\(([$\w]+)\)\{let ([$\w]+)=([as])\((\d+)\),\{children:([$\w]+)\}=([$\w]+)/g;
let mdSigMatch;
let lastMatch = null;
while ((mdSigMatch = mdSigPattern.exec(searchSection)) !== null) {
  lastMatch = mdSigMatch;
}

if (!lastMatch) {
  output.error('Could not find markdown renderer signature pattern near helper');
  process.exit(1);
}

const mdFuncName = lastMatch[1];    // PO
const argVar = lastMatch[2];        // A
const cacheVar = lastMatch[3];      // K
const cacheFn = lastMatch[4];       // s (cache function name)
const cacheArg = lastMatch[5];      // 4 (cache size)
const childrenVar = lastMatch[6];   // q
const argVar2 = lastMatch[7];       // A

output.discovery('markdown renderer', mdFuncName, {
  'Argument': argVar,
  'Children': childrenVar,
  'Cache function': `${cacheFn}(${cacheArg})`
});

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

// Pattern: createElement(BOX,{paddingLeft:2},REACT.default.createElement(PO,null,VAR))
// BOX component is now dynamic (was I in 2.1.20, S in 2.1.23)
const escMdFuncName = mdFuncName.replace(/\$/g, '\\$');
const thinkingMdPattern = new RegExp(
  `([$\\w]+\\.default\\.createElement)\\(([$\\w]+),\\{paddingLeft:2\\},([$\\w]+\\.default\\.createElement)\\(${escMdFuncName},null,([$\\w]+)\\)\\)`
);
const thinkingMdMatch = content.match(thinkingMdPattern);

if (!thinkingMdMatch) {
  output.error(`Could not find thinking ${mdFuncName} pattern`);
  process.exit(1);
}

const createElementCall1 = thinkingMdMatch[1];  // S3A.default.createElement
const boxComponent = thinkingMdMatch[2];         // S (Box component)
const createElementCall2 = thinkingMdMatch[3];  // S3A.default.createElement
const thinkingVar = thinkingMdMatch[4];          // J (thinking content)
output.discovery('thinking call', mdFuncName, {
  'Box component': boxComponent,
  'Thinking var': thinkingVar
});

// ============================================================
// Apply patches
// ============================================================

output.section(`Modify ${mdFuncName} signature`, { index: 1 });
const oldMdSig = lastMatch[0];
const newMdSig = `function ${mdFuncName}(${argVar}){let ${cacheVar}=${cacheFn}(${cacheArg}),{children:${childrenVar},dim:_dimStyle}=${argVar2}`;
output.modification('function signature', oldMdSig, newMdSig);

output.section('Modify helper function', { index: 2 });
// New helper function that checks _dimStyle and wraps in chalk.dim.italic if true
const newHelper = `${helperName}=function(){if(${strVar}){let _t=${strVar}.trim();if(_dimStyle)_t=${chalkVar}.dim.italic(_t);${arrVar}.push(${reactVar}.default.createElement(${compVar},{key:${arrVar2}.length},_t))}${strVar3}=""}`;
output.modification('helper function', helperMatch[0].slice(0, 80) + '...', newHelper.slice(0, 80) + '...');

output.section('Modify thinking component to pass dim:!0', { index: 3 });
// Change createElement(BOX,{paddingLeft:2},createElement(PO,null,J)) to createElement(BOX,{paddingLeft:2},createElement(PO,{dim:!0},J))
const oldMdCall = `${createElementCall1}(${boxComponent},{paddingLeft:2},${createElementCall2}(${mdFuncName},null,${thinkingVar})`;
const newMdCall = `${createElementCall1}(${boxComponent},{paddingLeft:2},${createElementCall2}(${mdFuncName},{dim:!0},${thinkingVar})`;
output.modification('thinking component', oldMdCall, newMdCall);

if (dryRun) {
  output.result('dry_run', 'no changes made');
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
  output.error(`Failed to write patched file: ${err.message}`);
  process.exit(1);
}

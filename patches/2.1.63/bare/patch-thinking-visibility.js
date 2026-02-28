#!/usr/bin/env node
/**
 * Minimal patch to make Claude Code thinking blocks visible inline (2.1.63 bare)
 *
 * What it does:
 * 1. Finds the case"thinking": renderer block
 * 2. Removes the "if not transcript mode and not verbose, return null" check
 * 3. Sets isTranscriptMode to always be true
 *
 * Changes from 2.1.45 bare:
 * - Null check simplified from three conditions (!VAR&&!VAR&&!VAR) to two (!VAR&&!VAR)
 * - Dead-code !0 removed from hideInTranscript computation
 * - Cache indices shifted (q[21]..q[26])
 *
 * Usage:
 *   node patch-thinking-visibility.js <cli.js path>
 *   node patch-thinking-visibility.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-thinking-visibility.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Pattern for CC 2.1.63 bare (two conditions + caching + verbose prop)
// The full thinking case looks like:
// case"thinking":{if(!X&&!_)return null;let f=X&&!(!G||W===G),N;
//   if(q[21]!==Y||q[22]!==X||q[23]!==K||q[24]!==f||q[25]!==_)
//     N=U5.createElement(qN1,{addMargin:Y,param:K,isTranscriptMode:X,verbose:_,hideInTranscript:f}),
//     q[21]=Y,q[22]=X,q[23]=K,q[24]=f,q[25]=_,q[26]=N;
//   else N=q[26];return N}

// Step 1: Find and remove the null return check (two conditions)
const nullCheckPattern = /(case"thinking":)\{if\(!([$\w]+)&&!([$\w]+)\)return null;/;
const nullCheckMatch = content.match(nullCheckPattern);

if (!nullCheckMatch) {
  output.error('Could not find thinking null-check pattern in cli.js', [
    'This might be an unsupported Claude Code version or install type',
    'Expected pattern: case"thinking":{if(!VAR&&!VAR)return null;...'
  ]);
  process.exit(1);
}

const transcriptVar = nullCheckMatch[2];  // X
const verboseVar = nullCheckMatch[3];     // _

output.discovery('thinking visibility pattern', '2.1.63 bare', {
  'isTranscriptMode var': transcriptVar,
  'verbose var': verboseVar
});
output.info(`Original null check: ${nullCheckMatch[0]}`);

// Step 2: Find the isTranscriptMode prop in the createElement call
const escapedTranscriptVar = transcriptVar.replace(/\$/g, '\\$');
const createElementPattern = new RegExp(
  `(createElement\\([$\\w]+,\\{addMargin:[$\\w]+,param:[$\\w]+,isTranscriptMode:)${escapedTranscriptVar}(,verbose:[$\\w]+,hideInTranscript:)`
);
const createElementMatch = content.match(createElementPattern);

if (!createElementMatch) {
  output.error('Could not find thinking createElement pattern', [
    'Expected: createElement(VAR,{addMargin:VAR,param:VAR,isTranscriptMode:VAR,verbose:VAR,hideInTranscript:VAR})'
  ]);
  process.exit(1);
}

output.modification('null check', `if(!${transcriptVar}&&!${verboseVar})return null;`, '(removed)');
output.modification('isTranscriptMode', `...isTranscriptMode:${transcriptVar},verbose:...`, `...isTranscriptMode:!0,verbose:...`);

if (dryRun) {
  output.result('dry_run', 'Patch point found');
  process.exit(0);
}

// Apply patches
let patchedContent = content;

// Remove null check
patchedContent = patchedContent.replace(nullCheckPattern, '$1{');

// Change isTranscriptMode to true (only in createElement context)
patchedContent = patchedContent.replace(createElementPattern, '$1!0$2');

try {
  fs.writeFileSync(targetPath, patchedContent);
  output.result('success', `Patched ${targetPath}`);
  output.info('Restart Claude Code to see thinking blocks inline.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

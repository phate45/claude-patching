#!/usr/bin/env node
/**
 * Minimal patch to make Claude Code thinking blocks visible inline (2.1.31 bare)
 *
 * What it does:
 * 1. Finds the case"thinking": renderer block
 * 2. Removes the "if not transcript mode and not verbose, return null" check
 * 3. Sets isTranscriptMode to always be true
 *
 * Changes from 2.1.19:
 * - Pattern simplified from three conditions (!D&&!H&&!T) to two (!j&&!V)
 * - Still uses caching pattern with array indices
 *
 * Note: Thinking-style patch is no longer needed as of 2.1.31 - dim styling is native.
 *
 * Usage:
 *   node patch-thinking-visibility.js <cli.js path>
 *   node patch-thinking-visibility.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const path = require('path');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-thinking-visibility.js [--check] <cli.js path>');
  process.exit(1);
}

// Read the file
let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}:`, [err.message]);
  process.exit(1);
}

// Pattern for CC 2.1.31 bare (with two conditions and caching)
// The full thinking case looks like:
// case"thinking":{if(!j&&!V)return null;let T=j&&!(!G||P===G)&&!V,k;if(q[21]!==Y||q[22]!==j||q[23]!==K||q[24]!==T)k=K9.createElement(_j6,{addMargin:Y,param:K,isTranscriptMode:j,hideInTranscript:T}),...}
//
// We need to:
// 1. Remove the if(!...&&!...)return null; part
// 2. Change isTranscriptMode:VAR to isTranscriptMode:!0 (only in createElement, not destructuring)

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

const transcriptVar = nullCheckMatch[2];  // j
const verboseVar = nullCheckMatch[3];     // V

output.discovery('thinking visibility pattern', '2.1.31 bare', {
  'isTranscriptMode var': transcriptVar,
  'verbose var': verboseVar
});
output.info(`Original null check: ${nullCheckMatch[0]}`);

// Step 2: Find the isTranscriptMode prop SPECIFICALLY in the createElement call
// Match: createElement(COMPONENT,{addMargin:VAR,param:VAR,isTranscriptMode:VAR,hideInTranscript:VAR})
// This is more specific than just "isTranscriptMode:VAR" to avoid matching destructuring
const escapedTranscriptVar = transcriptVar.replace(/\$/g, '\\$');
const createElementPattern = new RegExp(
  `(createElement\\([$\\w]+,\\{addMargin:[$\\w]+,param:[$\\w]+,isTranscriptMode:)${escapedTranscriptVar}(,hideInTranscript:)`
);
const createElementMatch = content.match(createElementPattern);

if (!createElementMatch) {
  output.error('Could not find thinking createElement pattern');
  process.exit(1);
}

output.modification('null check', `if(!${transcriptVar}&&!${verboseVar})return null;`, '(removed)');
output.modification('isTranscriptMode', `...isTranscriptMode:${transcriptVar},hideInTranscript:...`, `...isTranscriptMode:!0,hideInTranscript:...`);

if (dryRun) {
  output.result('dry_run', 'No changes made');
  process.exit(0);
}

// Apply patches
let patchedContent = content;

// Remove null check
patchedContent = patchedContent.replace(nullCheckPattern, '$1{');

// Change isTranscriptMode to true (only in createElement context)
patchedContent = patchedContent.replace(createElementPattern, '$1!0$2');

// Note: Backup is handled by the main executor (claude-patching.js)
// Individual patches should not create their own backups

// Write the patched file
try {
  fs.writeFileSync(targetPath, patchedContent);
  output.result('success', `Patched ${targetPath}`);
  output.info('Restart Claude Code to see thinking blocks inline.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

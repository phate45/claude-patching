#!/usr/bin/env node
/**
 * Minimal patch to make Claude Code thinking blocks visible inline (2.1.19 bare)
 *
 * What it does:
 * 1. Finds the case"thinking": renderer block
 * 2. Removes the "if not transcript mode and not verbose and not T, return null" check
 * 3. Sets isTranscriptMode to always be true
 *
 * Bare-specific differences from native:
 * - Condition checks three vars !D&&!H&&!T (vs two in native: !J&&!I)
 * - Uses caching pattern with K[23] etc instead of direct return
 *
 * Usage:
 *   node patch-thinking-visibility.js <cli.js path>
 *   node patch-thinking-visibility.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  console.error('Usage: node patch-thinking-visibility.js [--check] <cli.js path>');
  process.exit(1);
}

// Read the file
let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  console.error(`Failed to read ${targetPath}:`, err.message);
  process.exit(1);
}

// Pattern for CC 2.1.19 bare (with three conditions and caching)
// Match: case"thinking":{if(!D&&!H&&!T)return null;...isTranscriptMode:D,verbose:H,hideInTranscript:R})
// We need to:
// 1. Remove the if(!...&&!...&&!...)return null; part
// 2. Change isTranscriptMode:VAR to isTranscriptMode:true

// Step 1: Find and remove the null return check
const nullCheckPattern = /(case"thinking":)\{if\(!([$\w]+)&&!([$\w]+)&&!([$\w]+)\)return null;/;
const nullCheckMatch = content.match(nullCheckPattern);

if (!nullCheckMatch) {
  console.error('Could not find thinking null-check pattern in cli.js');
  console.error('   This might be an unsupported Claude Code version or install type');
  process.exit(1);
}

const transcriptVar = nullCheckMatch[2];  // D
const verboseVar = nullCheckMatch[3];     // H
const thirdVar = nullCheckMatch[4];       // T

console.log('Found thinking visibility pattern (bare format)');
console.log(`  isTranscriptMode var: ${transcriptVar}`);
console.log(`  verbose var: ${verboseVar}`);
console.log(`  third condition var: ${thirdVar}`);
console.log();
console.log('Original null check:');
console.log(`  ${nullCheckMatch[0]}`);

// Step 2: Find the isTranscriptMode prop and change to true
const transcriptModePattern = new RegExp(
  `(isTranscriptMode:)${transcriptVar.replace(/\$/g, '\\$')}(,verbose:)`
);
const transcriptModeMatch = content.match(transcriptModePattern);

if (!transcriptModeMatch) {
  console.error('Could not find isTranscriptMode property pattern');
  process.exit(1);
}

console.log();
console.log('Original isTranscriptMode:');
console.log(`  ${transcriptModeMatch[0]}`);
console.log('Patched isTranscriptMode:');
console.log(`  isTranscriptMode:true,verbose:`);

if (dryRun) {
  console.log();
  console.log('(Dry run - no changes made)');
  process.exit(0);
}

// Apply patches
let patchedContent = content;

// Remove null check
patchedContent = patchedContent.replace(nullCheckPattern, '$1{');

// Change isTranscriptMode to true
patchedContent = patchedContent.replace(transcriptModePattern, '$1true$2');

// Verify the patches took effect
if (patchedContent.includes('if(!') && patchedContent.match(/case"thinking":\{if\(!/)) {
  console.error('Warning: null check may not have been fully removed');
}

// Backup the original
const backupPath = targetPath + '.bak';
try {
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(targetPath, backupPath);
    console.log();
    console.log(`Backed up original to ${backupPath}`);
  }
} catch (err) {
  console.error(`Warning: Could not create backup: ${err.message}`);
}

// Write the patched file
try {
  fs.writeFileSync(targetPath, patchedContent);
  console.log(`Patched ${targetPath}`);
  console.log();
  console.log('Done! Restart Claude Code to see thinking blocks inline.');
} catch (err) {
  console.error(`Failed to write patched file: ${err.message}`);
  process.exit(1);
}

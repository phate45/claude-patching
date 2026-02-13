#!/usr/bin/env node
/**
 * Minimal patch to make Claude Code thinking blocks visible inline
 *
 * What it does:
 * 1. Finds the case"thinking": renderer block
 * 2. Removes the "if not transcript mode and not verbose, return null" check
 * 3. Sets isTranscriptMode to always be true
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

// Pattern for CC 2.0.77+ (new format with braces and hideInTranscript)
const newFormatPattern =
  /(case"thinking":)\{if\(![$\w]+&&![$\w]+\)return null;(return [$\w]+\.createElement\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,isTranscriptMode:)([$\w]+)(,verbose:[$\w]+,hideInTranscript:[$\w]+&&!\(![$\w]+\|\|[$\w]+===[$\w]+\)\})\)\}/;

// Pattern for older CC versions (without braces)
const oldFormatPattern =
  /(case"thinking":)if\([$\w!&]+\)return null;([$\w.]+\.createElement\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,isTranscriptMode:)([$\w]+)(,verbose:[$\w]+\s*\})\)/;

let match = content.match(newFormatPattern);
let isNewFormat = true;

if (!match) {
  match = content.match(oldFormatPattern);
  isNewFormat = false;
}

if (!match) {
  console.error('❌ Could not find thinking visibility pattern in cli.js');
  console.error('   This might be an unsupported Claude Code version');
  process.exit(1);
}

console.log('✓ Found thinking visibility pattern');
console.log(`  Format: ${isNewFormat ? 'new (2.0.77+)' : 'old'}`);
console.log(`  isTranscriptMode variable: ${match[3]}`);
console.log();
console.log('Original:');
console.log(`  ${match[0].slice(0, 100)}...`);

// Build the replacement
let replacement;
if (isNewFormat) {
  // New format: remove the if block, set isTranscriptMode to true
  replacement = `${match[1]}{${match[2]}true${match[4]})}`;
} else {
  // Old format: remove the if block, set isTranscriptMode to true
  replacement = `${match[1]}${match[2]}true${match[4]}`;
}

console.log();
console.log('Patched:');
console.log(`  ${replacement.slice(0, 100)}...`);

if (dryRun) {
  console.log();
  console.log('(Dry run - no changes made)');
  process.exit(0);
}

// Apply the patch
const patchedContent = content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length);

// Individual patches should not create their own backups — the orchestrator handles it

// Write the patched file
try {
  fs.writeFileSync(targetPath, patchedContent);
  console.log(`✓ Patched ${targetPath}`);
  console.log();
  console.log('Done! Restart Claude Code to see thinking blocks inline.');
} catch (err) {
  console.error(`Failed to write patched file: ${err.message}`);
  process.exit(1);
}

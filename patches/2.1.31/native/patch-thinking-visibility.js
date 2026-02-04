#!/usr/bin/env node
/**
 * Minimal patch to make Claude Code thinking blocks visible inline (2.1.31+)
 *
 * What it does:
 * 1. Finds the case"thinking": renderer block
 * 2. Removes the "if not transcript mode, return null" check
 * 3. Sets isTranscriptMode to always be true
 *
 * Changes from 2.1.19:
 * - Pattern no longer has verbose prop (removed in 2.1.31)
 * - Condition simplified from !J&&!I to just !U
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

// Pattern for CC 2.1.31+ (no verbose prop, single transcript mode check)
// case"thinking":{if(!U)return null;return D8.createElement(z_$,{addMargin:$,param:H,isTranscriptMode:U,hideInTranscript:U&&!(!Q||F===Q)&&!0})}
const pattern =
  /(case"thinking":)\{if\(!([$\w]+)\)return null;(return [$\w]+\.createElement\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,isTranscriptMode:)([$\w]+)(,hideInTranscript:[$\w]+&&!\(![$\w]+\|\|[$\w]+===[$\w]+\)&&!0\})\)\}/;

const match = content.match(pattern);

if (!match) {
  output.error('Could not find thinking visibility pattern in cli.js', [
    'This might be an unsupported Claude Code version',
    'Expected pattern: case"thinking":{if(!VAR)return null;return...isTranscriptMode:VAR,hideInTranscript:...}'
  ]);
  process.exit(1);
}

output.discovery('thinking visibility pattern', '2.1.31+', {
  isTranscriptMode_variable: match[4],
  condition_variable: match[2]
});
output.info(`Original: ${match[0].slice(0, 100)}...`);

// Build the replacement:
// - Remove the if(!U)return null; check (by not including it)
// - Set isTranscriptMode to true (hardcoded)
const replacement = `${match[1]}{${match[3]}!0${match[5]})}`;

output.modification('pattern', `if(!${match[2]})return null; ... isTranscriptMode:${match[4]}`, `isTranscriptMode:!0`);

if (dryRun) {
  output.result('dry_run', 'No changes made');
  process.exit(0);
}

// Apply the patch
const patchedContent = content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length);

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

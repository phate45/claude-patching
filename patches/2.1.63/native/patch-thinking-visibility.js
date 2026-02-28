#!/usr/bin/env node
/**
 * Minimal patch to make Claude Code thinking blocks visible inline (2.1.63 native)
 *
 * What it does:
 * 1. Finds the case"thinking": renderer block
 * 2. Removes the "if not transcript mode and not verbose, return null" check
 * 3. Sets isTranscriptMode to always be true
 *
 * Changes from 2.1.45 native:
 * - Dead-code !0&& removed from condition (was !U&&!0&&!I, now !U&&!I)
 * - Trailing &&!0 removed from hideInTranscript prop
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
  output.error(`Failed to read ${targetPath}:`, [err.message]);
  process.exit(1);
}

// Pattern for CC 2.1.63 native:
// case"thinking":{if(!U&&!I)return null;return b9.createElement(JO$,{addMargin:$,param:H,isTranscriptMode:U,verbose:I,hideInTranscript:U&&!(!K||F===K)})}
//
// Two conditions: !transcriptMode && !verbose (dead-code !0 removed since 2.1.45)
// hideInTranscript no longer has trailing &&!0
const pattern =
  /(case"thinking":)\{if\(!([$\w]+)&&!([$\w]+)\)return null;(return [$\w]+\.createElement\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,isTranscriptMode:)([$\w]+),verbose:([$\w]+)(,hideInTranscript:[$\w]+&&!\(![$\w]+\|\|[$\w]+===[$\w]+\)\})\)\}/;

const match = content.match(pattern);

if (!match) {
  output.error('Could not find thinking visibility pattern in cli.js', [
    'This might be an unsupported Claude Code version',
    'Expected pattern: case"thinking":{if(!VAR&&!VAR)return null;return...isTranscriptMode:VAR,verbose:VAR,hideInTranscript:...}'
  ]);
  process.exit(1);
}

output.discovery('thinking visibility pattern', '2.1.63', {
  isTranscriptMode_variable: match[5],
  verbose_variable: match[6],
  condition_variables: `${match[2]}, ${match[3]}`
});
output.info(`Original: ${match[0].slice(0, 120)}...`);

// Build the replacement:
// - Remove the if(!U&&!I)return null; check
// - Set isTranscriptMode to true (hardcoded)
// - Keep verbose as-is (doesn't affect visibility)
// Groups: 1=case prefix, 2/3=condition vars, 4=createElement prefix, 5=isTranscriptMode val, 6=verbose val, 7=hideInTranscript suffix
const replacement = `${match[1]}{${match[4]}!0,verbose:${match[6]}${match[7]})}`;

output.modification('pattern',
  `if(!${match[2]}&&!${match[3]})return null; ... isTranscriptMode:${match[5]}`,
  `isTranscriptMode:!0`);

if (dryRun) {
  output.result('dry_run', 'Patch point found');
  process.exit(0);
}

const patchedContent = content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length);

try {
  fs.writeFileSync(targetPath, patchedContent);
  output.result('success', `Patched ${targetPath}`);
  output.info('Restart Claude Code to see thinking blocks inline.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

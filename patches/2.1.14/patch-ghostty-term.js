#!/usr/bin/env node
/**
 * Patch to add proper color support for Ghostty terminal
 *
 * Ghostty uses TERM=xterm-ghostty and supports truecolor (16M colors).
 * However, Claude Code only recognizes "xterm-kitty" for truecolor
 * detection. This patch adds "xterm-ghostty" to the truecolor check.
 *
 * Without this patch, xterm-ghostty only gets color level 1 (basic 16 colors)
 * because it matches /^xterm/ but not /-256(color)?$/.
 *
 * Usage:
 *   node patch-ghostty-term.js <cli.js path>
 *   node patch-ghostty-term.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-ghostty-term.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Pattern for the xterm-kitty truecolor check
// Original: if(VAR.TERM==="xterm-kitty")return 3;
// We capture the variable name to use in the replacement
//
// The pattern matches: VAR.TERM==="xterm-kitty")return 3
// We need to add: ||VAR.TERM==="xterm-ghostty"
const kittyPattern = /([$\w]+)\.TERM==="xterm-kitty"\)return 3/g;

const matches = [...content.matchAll(kittyPattern)];

if (matches.length === 0) {
  output.error('Could not find xterm-kitty color detection pattern', [
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

output.discovery('xterm-kitty checks', `${matches.length} found`);

for (let i = 0; i < matches.length; i++) {
  const match = matches[i];
  const varName = match[1];
  const original = `if(${varName}.TERM==="xterm-kitty")return 3`;
  const patched = `if(${varName}.TERM==="xterm-kitty"||${varName}.TERM==="xterm-ghostty")return 3`;
  output.modification(`match ${i + 1}`, original, patched);
}

if (dryRun) {
  output.result('dry_run', 'No changes made');
  process.exit(0);
}

// Apply the patch - add ghostty check alongside kitty
let patchedContent = content.replace(
  kittyPattern,
  (match, varName) => `${varName}.TERM==="xterm-kitty"||${varName}.TERM==="xterm-ghostty")return 3`
);

// Verify the patch was applied
const afterMatches = [...patchedContent.matchAll(/xterm-ghostty.*return 3/g)];
if (afterMatches.length === 0) {
  output.error('Patch failed to apply');
  process.exit(1);
}

// Write patched file
try {
  fs.writeFileSync(targetPath, patchedContent);
  output.result('success', `Patched ${targetPath}`);
  output.info('Ghostty terminal will now get truecolor support (level 3).');
  output.info('Restart Claude Code to apply the change.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

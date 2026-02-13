#!/usr/bin/env node
/**
 * Patch to show offset/limit in the Read tool's compact display
 *
 * The Read tool's renderToolUseMessage already formats offset/limit
 * as "· lines X-Y", but gates it behind the verbose flag. This patch
 * removes that gate so the lines info shows in normal mode too.
 *
 * Before: Read(claude-patching.js)
 * After:  Read(claude-patching.js · lines 200-229)
 *
 * Usage:
 *   node patch-read-summary.js <cli.js path>
 *   node patch-read-summary.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-read-summary.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// ── Target: renderToolUseMessage for Read tool ──
//
// The verbose-gated offset/limit display in fC7 / equivalent:
//
// Bare:   if(z&&(q||K)){let H=q??1,$=K?`lines ${H}-${H+K-1}`:`from line ${H}`;return wK.createElement(...
// Native: if(I&&($||A)){let B=$??1,f=A?`lines ${B}-${B+A-1}`:`from line ${B}`;return L0.createElement(...
//
// Structure: if(VERBOSE&&(OFFSET||LIMIT)){...lines formatting...}
//
// Fix: remove the VERBOSE&& prefix so it always shows.

const pattern = /if\(([$\w]+)&&\(([$\w]+)\|\|([$\w]+)\)\)\{let ([$\w]+)=\2\?\?1,([$\w]+)=\3\?`lines \$\{\4\}-\$\{\4\+\3-1\}`:`from line \$\{\4\}`/;

const match = content.match(pattern);

if (!match) {
  output.error('Could not find Read renderToolUseMessage verbose gate', [
    'Expected: if(VERBOSE&&(OFFSET||LIMIT)){let S=OFFSET??1,L=LIMIT?`lines ...`:`from line ...`',
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

const [original, verboseVar, offsetVar, limitVar, startVar, labelVar] = match;

output.discovery('Read renderToolUseMessage verbose gate', original.slice(0, 80) + '...', {
  verboseVar, offsetVar, limitVar, startVar, labelVar
});

// Replace: remove the verbose variable from the condition
const replacement = original.replace(`if(${verboseVar}&&(${offsetVar}||${limitVar}))`, `if(${offsetVar}||${limitVar})`);

output.modification('verbose gate removal',
  `if(${verboseVar}&&(${offsetVar}||${limitVar}))`,
  `if(${offsetVar}||${limitVar})`
);

if (dryRun) {
  output.result('dry_run', 'Patch point found');
  process.exit(0);
}

content = content.replace(original, replacement);

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Patched ${targetPath}`);
  output.info('Read tool will now show offset/limit in compact mode. Restart Claude Code to apply.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

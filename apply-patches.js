#!/usr/bin/env node
/**
 * Apply all Claude Code patches in order
 *
 * Usage:
 *   node apply-patches.js <cli.js path>
 *   node apply-patches.js --check <cli.js path>  (dry run)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Patches in application order (deterministic)
const PATCHES = [
  'patch-thinking-visibility.js',
  'patch-thinking-style.js',
  'patch-spinner.js',
  'patch-ghostty-term.js',
];

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  console.error('Usage: node apply-patches.js [--check] <cli.js path>');
  process.exit(1);
}

// Verify target exists
if (!fs.existsSync(targetPath)) {
  console.error(`Error: ${targetPath} does not exist`);
  process.exit(1);
}

const scriptDir = __dirname;

// Create backup before any patches (only if not dry run)
if (!dryRun) {
  const backupPath = targetPath + '.bak';
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(targetPath, backupPath);
    console.log(`Backed up to ${backupPath}`);
  }
}

console.log(`\nApplying ${PATCHES.length} patches${dryRun ? ' (dry run)' : ''}...\n`);

let success = true;

for (const patch of PATCHES) {
  const patchPath = path.join(scriptDir, patch);

  if (!fs.existsSync(patchPath)) {
    console.error(`❌ ${patch} - not found`);
    success = false;
    continue;
  }

  console.log(`→ ${patch}`);

  try {
    const args = dryRun ? ['--check', targetPath] : [targetPath];
    const result = execSync(`node "${patchPath}" ${args.map(a => `"${a}"`).join(' ')}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Indent output
    const lines = result.trim().split('\n').map(l => '  ' + l).join('\n');
    console.log(lines);
    console.log();
  } catch (err) {
    console.error(`  ❌ Failed: ${err.message}`);
    if (err.stderr) {
      console.error(err.stderr.trim().split('\n').map(l => '  ' + l).join('\n'));
    }
    success = false;
    console.log();
  }
}

if (success) {
  console.log(dryRun ? '✓ All patterns matched (dry run)' : '✓ All patches applied');
} else {
  console.error('⚠ Some patches failed');
  process.exit(1);
}

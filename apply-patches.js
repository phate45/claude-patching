#!/usr/bin/env node
/**
 * Apply all Claude Code patches in order
 *
 * Usage:
 *   node apply-patches.js [options] [cli.js path]
 *
 * Options:
 *   --check   Dry run - verify patterns match without applying
 *   --force   Re-apply patches even if already recorded
 *   --stamp   Record all patches as applied (for already-patched files)
 *   --status  Show current patch status and exit
 *
 * If no path is provided, auto-discovers from pnpm installation.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Metadata marker for tracking applied patches
const PATCH_MARKER = '__CLAUDE_PATCHES__';

// Patches in application order (deterministic)
const PATCHES = [
  { file: 'patch-thinking-visibility.js', id: 'thinking-visibility', version: '1.0' },
  { file: 'patch-thinking-style.js', id: 'thinking-style', version: '1.0' },
  { file: 'patch-spinner.js', id: 'spinner', version: '1.0' },
  { file: 'patch-ghostty-term.js', id: 'ghostty-term', version: '1.0' },
];

/**
 * Read patch metadata from cli.js if present
 */
function readPatchMetadata(content) {
  const regex = new RegExp(`/\\* ${PATCH_MARKER} (\\{.*?\\}) \\*/`);
  const match = content.match(regex);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Write patch metadata to cli.js (after shebang if present)
 */
function writePatchMetadata(content, metadata) {
  const metaComment = `/* ${PATCH_MARKER} ${JSON.stringify(metadata)} */\n`;

  // Remove existing metadata if present
  const cleanRegex = new RegExp(`/\\* ${PATCH_MARKER} \\{.*?\\} \\*/\\n?`);
  const cleanContent = content.replace(cleanRegex, '');

  // Insert after shebang (must stay on line 1) or prepend if no shebang
  if (cleanContent.startsWith('#!')) {
    const newlineIdx = cleanContent.indexOf('\n');
    const shebang = cleanContent.slice(0, newlineIdx + 1);
    const rest = cleanContent.slice(newlineIdx + 1);
    return shebang + metaComment + rest;
  }

  return metaComment + cleanContent;
}

/**
 * Extract CC version from path
 */
function extractVersion(cliPath) {
  const match = cliPath.match(/@anthropic-ai\+claude-code@([^/]+)/);
  return match ? match[1] : 'unknown';
}

/**
 * Auto-discover cli.js path from pnpm installation
 */
function discoverCliPath() {
  const wrapperPath = path.join(os.homedir(), '.local/share/pnpm/claude');

  if (!fs.existsSync(wrapperPath)) {
    return null;
  }

  const wrapperContent = fs.readFileSync(wrapperPath, 'utf8');

  // Extract from NODE_PATH - contains full absolute path to claude-code
  const nodePathMatch = wrapperContent.match(
    /NODE_PATH="([^"]*@anthropic-ai\+claude-code@[^/]+\/node_modules\/@anthropic-ai\/claude-code)/
  );

  if (nodePathMatch) {
    return path.join(nodePathMatch[1], 'cli.js');
  }

  // Fallback: extract from exec line (uses $basedir)
  const execMatch = wrapperContent.match(
    /\$basedir\/(global\/\d+\/\.pnpm\/@anthropic-ai\+claude-code@[^/]+\/node_modules\/@anthropic-ai\/claude-code\/cli\.js)/
  );

  if (execMatch) {
    const pnpmDir = path.join(os.homedir(), '.local/share/pnpm');
    return path.join(pnpmDir, execMatch[1]);
  }

  return null;
}

// Parse arguments
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
apply-patches.js - Apply Claude Code patches

USAGE
  node apply-patches.js [options] [cli.js path]

OPTIONS
  --check    Dry run. Verify patterns match without modifying files.
  --force    Re-apply all patches, even if already recorded in metadata.
  --stamp    Mark all patches as applied without running them.
             Use this for files that were patched before metadata tracking.
  --status   Show current patch status and exit.
  --help     Show this help message.

PATH DISCOVERY
  If no path is provided, auto-discovers cli.js from pnpm installations
  by reading the wrapper script at ~/.local/share/pnpm/claude.

  For other installation methods (npm, yarn), provide the path manually:
    node apply-patches.js /path/to/cli.js

METADATA
  Patches are tracked via a JSON comment at the start of cli.js:
    /* __CLAUDE_PATCHES__ {"ccVersion":"x.y.z","patches":[...]} */

  This allows the script to skip already-applied patches and detect
  when patches need re-application after a CC update.

PATCHES
  ${PATCHES.map(p => `${p.id} (v${p.version})`).join('\n  ')}
`);
  process.exit(0);
}

const dryRun = args.includes('--check');
const force = args.includes('--force');
const stamp = args.includes('--stamp');
const statusOnly = args.includes('--status');
const positionalArgs = args.filter(a => !a.startsWith('--'));
let targetPath = positionalArgs[0];

// Auto-discover if no path provided
if (!targetPath) {
  targetPath = discoverCliPath();
  if (targetPath) {
    console.log(`Auto-discovered: ${targetPath}`);
  } else {
    console.error('Could not auto-discover cli.js path.');
    console.error('');
    console.error('Auto-discovery only works for pnpm installations (looks for ~/.local/share/pnpm/claude).');
    console.error('For other installation methods (npm, yarn, etc.), provide the path manually:');
    console.error('');
    console.error('  node apply-patches.js /path/to/claude-code/cli.js');
    console.error('');
    console.error('Common locations:');
    console.error('  npm global:  ~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js');
    console.error('  yarn global: ~/.yarn/global/node_modules/@anthropic-ai/claude-code/cli.js');
    process.exit(1);
  }
}

// Verify target exists
if (!fs.existsSync(targetPath)) {
  console.error(`Error: ${targetPath} does not exist`);
  process.exit(1);
}

const scriptDir = __dirname;
const ccVersion = extractVersion(targetPath);

// Read current file and check for existing patches
let content = fs.readFileSync(targetPath, 'utf8');
const existingMeta = readPatchMetadata(content);

if (existingMeta) {
  console.log(`\nExisting patch metadata found:`);
  console.log(`  CC version: ${existingMeta.ccVersion}`);
  console.log(`  Applied: ${existingMeta.appliedAt}`);
  console.log(`  Patches: ${existingMeta.patches.map(p => p.id).join(', ')}`);
} else {
  console.log(`\nNo patch metadata found (CC version: ${ccVersion})`);
}

// --status: just show current state and exit
if (statusOnly) {
  process.exit(0);
}

// --stamp: record all patches as applied without re-running them
if (stamp) {
  const metadata = {
    ccVersion,
    appliedAt: new Date().toISOString().split('T')[0],
    applier: 'claude-patching',
    patches: PATCHES.map(p => ({ id: p.id, version: p.version })),
  };

  const updatedContent = writePatchMetadata(content, metadata);
  fs.writeFileSync(targetPath, updatedContent);

  console.log(`\n✓ Stamped ${PATCHES.length} patches as applied:`);
  console.log(`  ${PATCHES.map(p => p.id).join(', ')}`);
  process.exit(0);
}

// Determine which patches to apply
const appliedIds = existingMeta?.patches?.map(p => `${p.id}@${p.version}`) || [];
const patchesToApply = force
  ? PATCHES
  : PATCHES.filter(p => !appliedIds.includes(`${p.id}@${p.version}`));

if (patchesToApply.length === 0) {
  console.log('\n✓ All patches already applied');
  process.exit(0);
}

if (!force && existingMeta) {
  const skipped = PATCHES.length - patchesToApply.length;
  if (skipped > 0) {
    console.log(`\nSkipping ${skipped} already-applied patch(es)`);
  }
}

// Create backup before any patches (only if not dry run)
if (!dryRun) {
  const backupPath = targetPath + '.bak';
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(targetPath, backupPath);
    console.log(`\nBacked up to ${backupPath}`);
  }
}

console.log(`\nApplying ${patchesToApply.length} patch(es)${dryRun ? ' (dry run)' : ''}...\n`);

let success = true;
const successfulPatches = [];

for (const patch of patchesToApply) {
  const patchPath = path.join(scriptDir, patch.file);

  if (!fs.existsSync(patchPath)) {
    console.error(`❌ ${patch.file} - not found`);
    success = false;
    continue;
  }

  console.log(`→ ${patch.id} (v${patch.version})`);

  try {
    const patchArgs = dryRun ? ['--check', targetPath] : [targetPath];
    const result = execSync(`node "${patchPath}" ${patchArgs.map(a => `"${a}"`).join(' ')}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Indent output
    const lines = result.trim().split('\n').map(l => '  ' + l).join('\n');
    console.log(lines);
    console.log();

    successfulPatches.push({ id: patch.id, version: patch.version });
  } catch (err) {
    console.error(`  ❌ Failed: ${err.message}`);
    if (err.stderr) {
      console.error(err.stderr.trim().split('\n').map(l => '  ' + l).join('\n'));
    }
    success = false;
    console.log();
  }
}

// Update metadata if not dry run and we applied patches
if (!dryRun && successfulPatches.length > 0) {
  // Merge with existing patches (keep ones we didn't re-apply)
  const existingPatches = force ? [] : (existingMeta?.patches || []);
  const newPatchIds = successfulPatches.map(p => p.id);
  const keptPatches = existingPatches.filter(p => !newPatchIds.includes(p.id));

  const metadata = {
    ccVersion,
    appliedAt: new Date().toISOString().split('T')[0],
    applier: 'claude-patching',
    patches: [...keptPatches, ...successfulPatches],
  };

  // Re-read file (patches may have modified it)
  content = fs.readFileSync(targetPath, 'utf8');
  const updatedContent = writePatchMetadata(content, metadata);
  fs.writeFileSync(targetPath, updatedContent);

  console.log(`Metadata updated: ${successfulPatches.length} patch(es) recorded`);
}

if (success) {
  console.log(dryRun ? '\n✓ All patterns matched (dry run)' : '\n✓ All patches applied');
} else {
  console.error('\n⚠ Some patches failed');
  process.exit(1);
}

/**
 * Setup command for claude-patching
 *
 * Prepares the patching environment:
 * - Detects installations
 * - Updates tweakcc reference
 * - Creates/updates backups (cli.js.{type}.original)
 * - Generates prettified versions (cli.js.{type}.pretty)
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const {
  detectInstalls,
  readPatchMetadata,
  isPatched,
  formatBytes,
  safeStats,
} = require('./shared');

const SCRIPT_DIR = path.dirname(__dirname);
const TWEAKCC_PATH = '/tmp/tweakcc';

// ============ Status Tracking ============

class SetupStatus {
  constructor() {
    this.installs = { bare: null, native: null };
    this.backups = { bare: null, native: null };
    this.prettified = { bare: null, native: null };
    this.tweakcc = null;
    this.errors = [];
    this.warnings = [];
  }

  toJSON() {
    const readyTypes = [];
    if (this.backups.bare?.status === '✓' || this.backups.bare?.status === 'created' || this.backups.bare?.status === 'updated') {
      readyTypes.push('bare');
    }
    if (this.backups.native?.status === '✓' || this.backups.native?.status === 'created' || this.backups.native?.status === 'updated') {
      readyTypes.push('native');
    }

    return {
      installs: this.installs,
      backups: this.backups,
      prettified: this.prettified,
      tweakcc: this.tweakcc,
      errors: this.errors,
      warnings: this.warnings,
      ready: readyTypes,
      success: this.errors.length === 0,
    };
  }

  toReport() {
    const lines = [];
    lines.push('## Patch Environment Status\n');
    lines.push('| Component | Status | Details |');
    lines.push('|-----------|--------|---------|');

    // Installations
    if (this.installs.bare) {
      const i = this.installs.bare;
      const patches = i.patches ? i.patches.join(', ') : 'none';
      lines.push(`| bare install | ✓ | ${i.version} at ${i.path} |`);
      lines.push(`| | | patches: ${patches} |`);
    } else {
      lines.push(`| bare install | ✗ | not detected |`);
    }

    if (this.installs.native) {
      const i = this.installs.native;
      const patches = i.patches ? i.patches.join(', ') : 'none';
      lines.push(`| native install | ✓ | ${i.version} at ${i.path} |`);
      lines.push(`| | | patches: ${patches} |`);
    } else {
      lines.push(`| native install | ✗ | not detected |`);
    }

    // Backups
    for (const type of ['bare', 'native']) {
      const b = this.backups[type];
      if (b) {
        lines.push(`| cli.js.${type}.original | ${b.status} | ${b.details} |`);
      }
    }

    // Prettified
    for (const type of ['bare', 'native']) {
      const p = this.prettified[type];
      if (p) {
        lines.push(`| cli.js.${type}.pretty | ${p.status} | ${p.details} |`);
      }
    }

    // tweakcc
    if (this.tweakcc) {
      lines.push(`| tweakcc | ${this.tweakcc.status} | ${this.tweakcc.details} |`);
    }

    lines.push('');

    // Warnings
    if (this.warnings.length > 0) {
      lines.push('## Warnings\n');
      for (const w of this.warnings) {
        lines.push(`- ${w}`);
      }
      lines.push('');
    }

    // Errors
    if (this.errors.length > 0) {
      lines.push('## Errors\n');
      for (const e of this.errors) {
        lines.push(`- ${e}`);
      }
      lines.push('');
    }

    // Ready section
    const readyTypes = [];
    if (this.backups.bare?.status === '✓' || this.backups.bare?.status === 'created' || this.backups.bare?.status === 'updated') {
      readyTypes.push('bare');
    }
    if (this.backups.native?.status === '✓' || this.backups.native?.status === 'created' || this.backups.native?.status === 'updated') {
      readyTypes.push('native');
    }

    if (readyTypes.length > 0 && this.errors.length === 0) {
      lines.push('## Ready to Patch\n');
      lines.push(`Working files prepared for: ${readyTypes.join(', ')}\n`);
      lines.push('Commands:');
      for (const t of readyTypes) {
        lines.push(`- Test patches: \`node claude-patching.js --${t} --check\``);
        lines.push(`- Apply patches: \`node claude-patching.js --${t} --apply\``);
        lines.push(`- Search code: \`rg -oP 'pattern' cli.js.${t}.original\``);
        lines.push(`- Generate chunks: \`./chunk-pretty.sh --${t}\``);
      }
    } else if (this.errors.length > 0) {
      lines.push('## Action Required\n');
      lines.push('Resolve the errors above before patching.');
    }

    return lines.join('\n');
  }
}

// ============ Setup Steps ============

/**
 * Step 1: Detect installations and their patch status
 */
function discoverInstallations(status) {
  const installs = detectInstalls();

  if (installs.bare) {
    const content = fs.readFileSync(installs.bare.path, 'utf8');
    const meta = readPatchMetadata(content);
    status.installs.bare = {
      ...installs.bare,
      patched: isPatched(content),
      patches: meta?.patches?.map(p => p.id) || null,
      appliedAt: meta?.appliedAt || null,
    };
  }

  if (installs.native) {
    // Native detection works but extraction is stubbed
    status.installs.native = {
      ...installs.native,
      patched: false, // Can't check without extraction
      patches: null,
      appliedAt: null,
      note: 'extraction not yet implemented',
    };
  }

  if (!installs.bare && !installs.native) {
    status.errors.push('No Claude Code installations detected');
    return false;
  }

  return true;
}

/**
 * Step 2: Update tweakcc reference
 */
function updateTweakcc(status) {
  try {
    if (fs.existsSync(TWEAKCC_PATH)) {
      const result = spawnSync('git', ['pull'], {
        cwd: TWEAKCC_PATH,
        encoding: 'utf8',
        timeout: 30000,
      });

      if (result.status === 0) {
        const output = result.stdout.trim();
        if (output.includes('Already up to date')) {
          status.tweakcc = { status: '✓', details: 'up to date' };
        } else {
          // Count changed files
          const changes = output.match(/(\d+) files? changed/);
          const detail = changes ? `${changes[1]} files changed` : 'updated';
          status.tweakcc = { status: 'updated', details: detail };
        }
      } else {
        status.tweakcc = { status: '⚠', details: 'git pull failed' };
        status.warnings.push(`tweakcc update failed: ${result.stderr}`);
      }
    } else {
      const result = spawnSync('git', ['clone', '--depth', '1', 'https://github.com/Piebald-AI/tweakcc.git', TWEAKCC_PATH], {
        encoding: 'utf8',
        timeout: 60000,
      });

      if (result.status === 0) {
        status.tweakcc = { status: 'cloned', details: 'fresh clone' };
      } else {
        status.tweakcc = { status: '⚠', details: 'clone failed' };
        status.warnings.push(`tweakcc clone failed: ${result.stderr}`);
      }
    }
  } catch (err) {
    status.tweakcc = { status: '⚠', details: err.message };
    status.warnings.push(`tweakcc: ${err.message}`);
  }
}

/**
 * Step 3a: Create/update backup for an install type
 */
function processBackup(type, install, status) {
  const backupPath = path.join(SCRIPT_DIR, `cli.js.${type}.original`);
  const backupStats = safeStats(backupPath);

  // Native extraction is stubbed - skip
  if (type === 'native') {
    status.backups.native = {
      status: '⚠',
      details: 'native extraction not yet implemented',
    };
    status.warnings.push('Native backup skipped: binary extraction not yet implemented');
    return;
  }

  // Bare install processing
  const sourcePath = install.path;
  const sourceStats = safeStats(sourcePath);

  if (!sourceStats.exists) {
    status.backups[type] = { status: '✗', details: 'source not found' };
    status.errors.push(`${type} source not found at ${sourcePath}`);
    return;
  }

  // Check if source is patched
  const sourceContent = fs.readFileSync(sourcePath, 'utf8');
  const sourcePatched = isPatched(sourceContent);

  if (sourcePatched) {
    // Source is patched - don't overwrite backup
    if (backupStats.exists) {
      status.backups[type] = {
        status: '✓',
        details: `${formatBytes(backupStats.size)} (source is patched, keeping existing backup)`,
      };
    } else {
      status.backups[type] = {
        status: '⚠',
        details: 'source is patched but no clean backup exists',
      };
      status.warnings.push(
        `${type}: Source is patched but no clean backup exists. ` +
        `Reinstall CC or restore from git to get a clean source.`
      );
    }
    return;
  }

  // Source is clean
  if (!backupStats.exists) {
    // Create initial backup
    fs.copyFileSync(sourcePath, backupPath);
    status.backups[type] = {
      status: 'created',
      details: formatBytes(sourceStats.size),
    };
    return;
  }

  // Compare sizes
  if (sourceStats.size === backupStats.size) {
    status.backups[type] = {
      status: '✓',
      details: `${formatBytes(backupStats.size)} (current)`,
    };
  } else {
    // Version change - update backup
    fs.copyFileSync(sourcePath, backupPath);
    status.backups[type] = {
      status: 'updated',
      details: `${formatBytes(backupStats.size)} → ${formatBytes(sourceStats.size)} (CC version changed)`,
    };
  }
}

/**
 * Step 3b: Generate prettified version
 */
function processPrettified(type, status) {
  const backupPath = path.join(SCRIPT_DIR, `cli.js.${type}.original`);
  const prettyPath = path.join(SCRIPT_DIR, `cli.js.${type}.pretty`);

  const backupStats = safeStats(backupPath);
  const prettyStats = safeStats(prettyPath);

  if (!backupStats.exists) {
    // No backup means we can't prettify
    return;
  }

  // Check if js-beautify is available
  const jsBeautifyCheck = spawnSync('which', ['js-beautify'], { encoding: 'utf8' });
  if (jsBeautifyCheck.status !== 0) {
    status.prettified[type] = {
      status: '⚠',
      details: 'js-beautify not installed',
    };
    status.warnings.push('js-beautify not found. Install with: npm install -g js-beautify');
    return;
  }

  // Check if prettified needs regeneration
  const needsRegen = !prettyStats.exists || backupStats.mtime > prettyStats.mtime;

  if (!needsRegen) {
    // Count lines
    try {
      const lineCount = execSync(`wc -l < "${prettyPath}"`, { encoding: 'utf8' }).trim();
      status.prettified[type] = {
        status: '✓',
        details: `${parseInt(lineCount).toLocaleString()} lines`,
      };
    } catch {
      status.prettified[type] = { status: '✓', details: 'current' };
    }
    return;
  }

  // Generate prettified version
  if (process.env.CLAUDECODE !== '1') {
    console.log(`Generating cli.js.${type}.pretty...`);
  }
  const result = spawnSync('js-beautify', ['-f', backupPath, '-o', prettyPath], {
    encoding: 'utf8',
    timeout: 120000, // 2 minutes for large files
  });

  if (result.status === 0) {
    try {
      const lineCount = execSync(`wc -l < "${prettyPath}"`, { encoding: 'utf8' }).trim();
      status.prettified[type] = {
        status: 'created',
        details: `${parseInt(lineCount).toLocaleString()} lines`,
      };
    } catch {
      status.prettified[type] = { status: 'created', details: 'generated' };
    }
  } else {
    status.prettified[type] = {
      status: '✗',
      details: 'js-beautify failed',
    };
    status.errors.push(`Failed to prettify ${type}: ${result.stderr}`);
  }
}

// ============ Main ============

/**
 * Run the full setup process
 * @param {object} options - Options
 * @param {boolean} options.json - Force JSON output (auto-detected from CLAUDECODE env var)
 * @returns {string} Status report (markdown or JSON string)
 */
function runSetup(options = {}) {
  const jsonMode = options.json ?? process.env.CLAUDECODE === '1';
  const log = jsonMode ? () => {} : console.log.bind(console);

  const status = new SetupStatus();

  log('Patch Environment Setup');
  log('=======================\n');

  // Step 1: Discover installations
  log('Detecting installations...');
  if (!discoverInstallations(status)) {
    return jsonMode ? JSON.stringify(status.toJSON(), null, 2) : status.toReport();
  }

  // Step 2: Update tweakcc
  log('Updating tweakcc reference...');
  updateTweakcc(status);

  // Step 3: Process each install type
  for (const type of ['bare', 'native']) {
    const install = status.installs[type];
    if (!install) continue;

    log(`\nProcessing ${type} install...`);

    // 3a: Backup
    processBackup(type, install, status);

    // 3b: Prettify
    processPrettified(type, status);
  }

  log('\n' + '='.repeat(40) + '\n');

  return jsonMode ? JSON.stringify(status.toJSON(), null, 2) : status.toReport();
}

module.exports = { runSetup };

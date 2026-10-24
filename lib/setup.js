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

const { extractClaudeJs } = require('./bun-binary.ts');

const SCRIPT_DIR = path.dirname(__dirname);
const TWEAKCC_PATH = '/tmp/tweakcc';
const CLAUDE_CODE_PATH = '/tmp/claude-code-src';
const CLAUDE_CODE_REPO = 'https://github.com/anthropics/claude-code.git';
// CHANGELOG.md lives at the repo root — read by scan-changelog.js during --port.
const CHANGELOG_PATH = path.join(CLAUDE_CODE_PATH, 'CHANGELOG.md');

// ============ Status Tracking ============

class SetupStatus {
  constructor() {
    this.installs = { bare: null, native: null };
    this.backups = { bare: null, native: null };
    this.prettified = { bare: null, native: null };
    this.tweakcc = null;
    this.claudeCode = null;
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
      claudeCode: this.claudeCode,
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

    // claude-code (CHANGELOG source)
    if (this.claudeCode) {
      lines.push(`| claude-code | ${this.claudeCode.status} | ${this.claudeCode.details} |`);
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

  // Both bare and native targets are Bun ELFs — extract JS uniformly.
  for (const type of ['bare', 'native']) {
    const install = installs[type];
    if (!install) continue;

    try {
      const jsBuffer = extractClaudeJs(install.path);
      const content = jsBuffer.toString('utf8');
      const meta = readPatchMetadata(content);
      status.installs[type] = {
        ...install,
        patched: isPatched(content),
        patches: meta?.patches?.map(p => p.id) || null,
        appliedAt: meta?.appliedAt || null,
      };
    } catch (err) {
      status.installs[type] = {
        ...install,
        patched: false,
        patches: null,
        appliedAt: null,
        note: `extraction failed: ${err.message}`,
      };
      status.warnings.push(`${type} extraction failed: ${err.message}`);
    }
  }

  if (!installs.bare && !installs.native) {
    status.errors.push('No Claude Code installations detected');
    return false;
  }

  return true;
}

/**
 * Shallow clone/refresh a reference repo into a temp path.
 * Returns { status, details } and pushes any failure to status.warnings.
 * @param {string} label - Human label used in status/warnings (e.g. 'tweakcc')
 * @param {string} repoUrl - Git URL to clone
 * @param {string} destPath - Local checkout path (under /tmp)
 */
function updateRepo(status, label, repoUrl, destPath) {
  try {
    if (fs.existsSync(destPath)) {
      // fetch + reset --hard, not pull: systemd-tmpfiles ages untouched files out of
      // /tmp, and pull's inherited rebase/autostash config then conflicts on them.
      const git = (...args) => spawnSync('git', args, { cwd: destPath, encoding: 'utf8', timeout: 30000 });
      const before = git('rev-parse', 'HEAD').stdout.trim();
      const fetch = git('fetch', '--depth', '1', 'origin', 'HEAD');
      const reset = fetch.status === 0 ? git('reset', '--hard', '-q', 'FETCH_HEAD') : fetch;

      if (reset.status === 0) {
        const after = git('rev-parse', 'HEAD').stdout.trim();
        return before === after
          ? { status: '✓', details: 'up to date' }
          : { status: 'updated', details: `${before.slice(0, 7)} -> ${after.slice(0, 7)}` };
      }
      status.warnings.push(`${label} update failed: ${reset.stderr}`);
      return { status: '⚠', details: 'git fetch/reset failed' };
    }

    const result = spawnSync('git', ['clone', '--depth', '1', repoUrl, destPath], {
      encoding: 'utf8',
      timeout: 60000,
    });

    if (result.status === 0) {
      return { status: 'cloned', details: 'fresh clone' };
    }
    status.warnings.push(`${label} clone failed: ${result.stderr}`);
    return { status: '⚠', details: 'clone failed' };
  } catch (err) {
    status.warnings.push(`${label}: ${err.message}`);
    return { status: '⚠', details: err.message };
  }
}

/**
 * Step 2: Update reference repos.
 * - tweakcc: patch-pattern reference.
 * - claude-code: source of CHANGELOG.md for the --port impact scan.
 */
function updateReferenceRepos(status) {
  status.tweakcc = updateRepo(status, 'tweakcc', 'https://github.com/Piebald-AI/tweakcc.git', TWEAKCC_PATH);
  status.claudeCode = updateRepo(status, 'claude-code', CLAUDE_CODE_REPO, CLAUDE_CODE_PATH);
}

/**
 * Step 3a: Create/update backup for an install type.
 *
 * Both bare and native installs are Bun ELFs (since 2.1.117 the pnpm wrapper
 * also ships a binary). We extract the JS payload via bun-binary.ts for both
 * and write the pristine JS to cli.js.<type>.original.
 */
function processBackup(type, install, status) {
  const backupPath = path.join(SCRIPT_DIR, `cli.js.${type}.original`);
  const backupStats = safeStats(backupPath);

  try {
    const jsBuffer = extractClaudeJs(install.path);
    const sourceContent = jsBuffer.toString('utf8');
    const sourceSize = jsBuffer.length;
    const sourcePatched = isPatched(sourceContent);

    if (sourcePatched) {
      // Try .bak fallback — extract JS from the backup binary
      const bakPath = install.path + '.bak';
      const bakStats = safeStats(bakPath);
      let bakIsClean = false;
      let bakJsBuffer = null;

      if (bakStats.exists) {
        try {
          bakJsBuffer = extractClaudeJs(bakPath);
          bakIsClean = !isPatched(bakJsBuffer.toString('utf8'));
        } catch (err) {
          status.warnings.push(`${type}: .bak extraction failed: ${err.message}`);
        }
      }

      if (bakIsClean && bakJsBuffer) {
        fs.writeFileSync(backupPath, bakJsBuffer);
        status.backups[type] = {
          status: 'created',
          details: `${formatBytes(bakJsBuffer.length)} (from .bak — source is patched)`,
        };
      } else if (backupStats.exists) {
        const existingContent = fs.readFileSync(backupPath, 'utf8');
        if (isPatched(existingContent)) {
          status.backups[type] = {
            status: '⚠',
            details: 'workspace backup is also patched — needs clean source',
          };
          status.warnings.push(
            `${type}: Both source and workspace backup are patched. ` +
            `Reinstall CC to get a clean source.`
          );
        } else {
          status.backups[type] = {
            status: '✓',
            details: `${formatBytes(backupStats.size)} (source is patched, keeping existing backup)`,
          };
        }
      } else {
        status.backups[type] = {
          status: '⚠',
          details: 'source is patched, no clean backup available',
        };
        status.warnings.push(
          `${type}: Source is patched and no clean backup exists (.bak ${bakStats.exists ? 'is also patched' : 'not found'}). ` +
          `Reinstall CC or restore binary to get a clean source.`
        );
      }
      return;
    }

    // Source is clean
    if (!backupStats.exists) {
      fs.writeFileSync(backupPath, jsBuffer);
      status.backups[type] = {
        status: 'created',
        details: formatBytes(sourceSize),
      };
      return;
    }

    // Compare sizes
    if (sourceSize === backupStats.size) {
      status.backups[type] = {
        status: '✓',
        details: `${formatBytes(backupStats.size)} (current)`,
      };
    } else {
      fs.writeFileSync(backupPath, jsBuffer);
      status.backups[type] = {
        status: 'updated',
        details: `${formatBytes(backupStats.size)} → ${formatBytes(sourceSize)} (CC version changed)`,
      };
    }
  } catch (err) {
    status.backups[type] = {
      status: '✗',
      details: `extraction failed: ${err.message}`,
    };
    status.errors.push(`${type} backup failed: ${err.message}`);
  }
}

/**
 * Step 3b: Generate prettified version
 */
function processPrettified(type, status, options) {
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
  if (process.env.CLAUDECODE !== '1' && !options?.quiet) {
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
 * @param {boolean} options.quiet - Suppress progress output
 * @returns {SetupStatus} Status object with .toJSON() and .toReport() methods
 */
function runSetup(options = {}) {
  const jsonMode = options.json ?? process.env.CLAUDECODE === '1';
  const quiet = options.quiet ?? false;
  const log = (jsonMode || quiet) ? () => {} : console.log.bind(console);

  const status = new SetupStatus();

  log('Patch Environment Setup');
  log('=======================\n');

  // Step 1: Discover installations
  log('Detecting installations...');
  if (!discoverInstallations(status)) {
    return status;
  }

  // Step 2: Update reference repos
  log('Updating reference repos (tweakcc, claude-code)...');
  updateReferenceRepos(status);

  // Step 3: Process each install type
  for (const type of ['bare', 'native']) {
    const install = status.installs[type];
    if (!install) continue;

    log(`\nProcessing ${type} install...`);

    // 3a: Backup
    processBackup(type, install, status);

    // 3b: Prettify
    processPrettified(type, status, { quiet });
  }

  log('\n' + '='.repeat(40) + '\n');

  return status;
}

module.exports = { runSetup, SetupStatus, CHANGELOG_PATH, CLAUDE_CODE_PATH };

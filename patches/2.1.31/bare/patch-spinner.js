#!/usr/bin/env node
/**
 * Patch to customize the Claude Code spinner animation (2.1.31 bare)
 *
 * The spinner is the animated symbol shown while Claude is working.
 * This patch replaces the platform-specific spinner function with
 * a custom sequence.
 *
 * Changes from 2.1.23:
 * - Freeze pattern may not be present (behavior changed in 2.1.31)
 * - No longer fails if freeze pattern not found
 *
 * Usage:
 *   node patch-spinner.js <cli.js path>
 *   node patch-spinner.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../../lib/output');

// ============================================================
// CONFIGURATION - Edit this to customize your spinner
// ============================================================

const SPINNER_CHARS = ["·","∴","∴","·","∵","∵"];

// Animation mode:
//   false = mirror (default): cycles forward then backward
//   true  = loop: cycles forward continuously
const LOOP_MODE = true;

// No-freeze mode:
//   When true, removes the code that freezes the spinner when disconnected.
//   CC freezes the spinner on frame 4 when !isConnected.
//   Note: This pattern may not exist in all versions.
const NO_FREEZE = true;

// ============================================================
// PATCH IMPLEMENTATION
// ============================================================

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-spinner.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Pattern for 2.1.19+ bare spinner function (with darwin branch)
const spinnerFuncPattern = /function ([$\w]+)\(\)\{if\(process\.env\.TERM==="xterm-ghostty"\)return\["[^"]+(?:","[^"]+)*"\];return process\.platform==="darwin"\?\["[^"]+(?:","[^"]+)*"\]:\["[^"]+(?:","[^"]+)*"\]\}/;

// Pattern for already-patched spinner function
const patchedSpinnerPattern = /function ([$\w]+)\(\)\{return(\["[^"]+(?:","[^"]+)*"\])\}/g;

let match = content.match(spinnerFuncPattern);
let isRepatch = false;
let currentChars = null;

if (!match) {
  let patchedMatch;
  while ((patchedMatch = patchedSpinnerPattern.exec(content)) !== null) {
    const candidateName = patchedMatch[1];
    const arrayStr = patchedMatch[2];

    try {
      const arr = JSON.parse(arrayStr);
      if (arr.length >= 2 && arr.length <= 16 &&
          arr.every(c => typeof c === 'string' && c.length === 1)) {
        const escapedName = candidateName.replace(/\$/g, '\\$');
        const mirrorRef = new RegExp(`[$\\w]+=${escapedName}\\(\\)`);
        if (mirrorRef.test(content)) {
          match = patchedMatch;
          isRepatch = true;
          currentChars = arr;
          break;
        }
      }
    } catch (e) {
      // Not valid JSON, skip
    }
  }
}

if (!match) {
  output.error('Could not find spinner function pattern');
  process.exit(1);
}

const funcName = match[1];

if (isRepatch) {
  output.discovery('spinner function', funcName + '()', { 'Status': 'already patched', 'Current chars': currentChars.join(' ') });
} else {
  output.discovery('spinner function', funcName + '()', { 'Status': 'original' });
  output.info(`Original: ${match[0].slice(0, 120)}...`);
}

const charsJson = JSON.stringify(SPINNER_CHARS);
const replacement = `function ${funcName}(){return${charsJson}}`;

output.modification('spinner chars', match[0].slice(0, 120) + '...', replacement);
output.info(`Spinner sequence: ${SPINNER_CHARS.join(' ')}`);
output.info(`Animation mode: ${LOOP_MODE ? 'loop' : 'mirror'}`);

// Mirror pattern matching
let mirrorMatches = [];
if (LOOP_MODE) {
  const escapedFuncName = funcName.replace(/\$/g, '\\$');
  const mirrorPattern = new RegExp(
    `([$\\w]+)=${escapedFuncName}\\(\\),([$\\w]+)=\\[\\.\\.\\.\\1,\\.\\.\\.\\[\\.\\.\\.\\1\\]\\.reverse\\(\\)\\]`,
    'g'
  );

  let m;
  while ((m = mirrorPattern.exec(content)) !== null) {
    mirrorMatches.push({
      full: m[0],
      baseVar: m[1],
      arrayVar: m[2]
    });
  }

  if (mirrorMatches.length > 0) {
    output.discovery('mirror patterns', `${mirrorMatches.length} found`);
    for (let i = 0; i < mirrorMatches.length; i++) {
      const mm = mirrorMatches[i];
      output.modification(`mirror ${i}`, mm.full, `${mm.baseVar}=${funcName}(),${mm.arrayVar}=[...${mm.baseVar}]`);
    }
  } else {
    output.info('No mirror patterns found - animation may already be loop mode');
  }
}

// Freeze pattern matching (2.1.23 format)
// Pattern: s9(()=>{if(!COND){SETTER(4);return}SETTER((VAR)=>VAR+1)},120)
let freezeMatches = [];
if (NO_FREEZE) {
  // 2.1.23 bare: inline callback in interval hook
  const freezePattern2123 = /([$\w]+)\(\(\)=>\{if\(!([$\w]+)\)\{([$\w]+)\(4\);return\}\3\(\(([$\w]+)\)=>\4\+1\)\},(\d+)\)/g;

  let m;
  while ((m = freezePattern2123.exec(content)) !== null) {
    freezeMatches.push({
      full: m[0],
      hookName: m[1],
      condVar: m[2],
      setterName: m[3],
      incVar: m[4],
      interval: m[5]
    });
  }

  // Also try 2.1.19 pattern as fallback
  if (freezeMatches.length === 0) {
    const freezePattern2119 = /([$\w]+)=\(\)=>\{if\(!([$\w]+)\)\{([$\w]+)\(4\);return\}(\3)\(([$\w]+)\)\}/g;
    while ((m = freezePattern2119.exec(content)) !== null) {
      freezeMatches.push({
        full: m[0],
        callbackVar: m[1],
        condVar: m[2],
        setterName: m[3],
        incrementVar: m[5],
        format: '2.1.19'
      });
    }
  }

  if (freezeMatches.length > 0) {
    output.discovery('freeze branches', `${freezeMatches.length} found`);
    for (let i = 0; i < freezeMatches.length; i++) {
      const fm = freezeMatches[i];
      let before, after;
      if (fm.hookName) {
        before = `${fm.hookName}(()=>{if(!${fm.condVar}){${fm.setterName}(4);return}${fm.setterName}((${fm.incVar})=>${fm.incVar}+1)},${fm.interval})`;
        after = `${fm.hookName}(()=>{${fm.setterName}((${fm.incVar})=>${fm.incVar}+1)},${fm.interval})`;
      } else {
        before = `${fm.callbackVar}=()=>{if(!${fm.condVar}){${fm.setterName}(4);return}${fm.setterName}(${fm.incrementVar})}`;
        after = `${fm.callbackVar}=()=>{${fm.setterName}(${fm.incrementVar})}`;
      }
      output.modification(`freeze ${i}`, before, after);
    }
  } else {
    // Not a critical error in 2.1.31 - freeze behavior may have changed
    output.info('No freeze pattern found - may have been removed or changed in this version');
  }
}

if (dryRun) {
  output.result('dry_run', 'No changes made');
  process.exit(0);
}

// Apply the patches
let patchedContent = content.replace(match[0], replacement);

// Apply mirror patches
if (LOOP_MODE) {
  for (const mm of mirrorMatches) {
    const loopReplacement = `${mm.baseVar}=${funcName}(),${mm.arrayVar}=[...${mm.baseVar}]`;
    patchedContent = patchedContent.replace(mm.full, loopReplacement);
  }
}

// Apply freeze branch removal
if (NO_FREEZE) {
  for (const fm of freezeMatches) {
    let noFreezeReplacement;
    if (fm.hookName) {
      noFreezeReplacement = `${fm.hookName}(()=>{${fm.setterName}((${fm.incVar})=>${fm.incVar}+1)},${fm.interval})`;
    } else {
      noFreezeReplacement = `${fm.callbackVar}=()=>{${fm.setterName}(${fm.incrementVar})}`;
    }
    patchedContent = patchedContent.replace(fm.full, noFreezeReplacement);
  }
}

// Write patched file
try {
  fs.writeFileSync(targetPath, patchedContent);
  output.result('success', `Patched ${targetPath}`);
} catch (err) {
  output.error(`Failed to write patched file`, [err.message]);
  process.exit(1);
}

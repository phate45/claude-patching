#!/usr/bin/env node
/**
 * Patch to customize the Claude Code spinner animation (2.1.19+)
 *
 * The spinner is the animated symbol shown while Claude is working.
 * This patch replaces the platform-specific spinner function with
 * a custom sequence.
 *
 * Changes from 2.1.14:
 * - Spinner function no longer has darwin-specific branch
 * - Pattern is simpler: ghostty check + default return
 *
 * Usage:
 *   node patch-spinner.js <cli.js path>
 *   node patch-spinner.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');

// ============================================================
// CONFIGURATION - Edit this to customize your spinner
// ============================================================

// The sequence of characters to cycle through.
// Keep it short (4-8 chars) for smooth animation.
//
// Ideas:
//   ["◐","◓","◑","◒"]           - rotating half-moon (default)
//   ["·","∴","·","∵"]           - therefore/because (matches thinking header)
//   ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]  - braille spinner
//   ["○","◔","◑","◕","●","◕","◑","◔"]  - filling circle
//   ["◢","◣","◤","◥"]           - rotating triangle
//   ["✶","✷","✸","✹","✺"]       - star burst
//   ["·","✦","✧","✦"]           - twinkling star
//
const SPINNER_CHARS = ["·","∴","∴","·","∵","∵"];

// Animation mode:
//   false = mirror (default): cycles forward then backward (0,1,2,3,2,1,0,...)
//   true  = loop: cycles forward continuously (0,1,2,3,0,1,2,3,...)
//
// Loop mode works better for directional spinners (rotating shapes).
// Mirror mode works better for symmetric patterns (pulsing, filling).
//
const LOOP_MODE = true;

// No-freeze mode:
//   When true, removes the code that freezes the spinner when disconnected.
//   CC freezes the spinner on frame 4 when !isConnected. With custom spinners
//   (especially 4-char ones), this shows as stuck on the first frame (4%4=0).
//
const NO_FREEZE = true;

// ============================================================
// PATCH IMPLEMENTATION
// ============================================================

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  console.error('Usage: node patch-spinner.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  console.error(`Failed to read ${targetPath}:`, err.message);
  process.exit(1);
}

// Pattern for 2.1.19+ spinner function (no darwin branch)
// function FUNC(){if(process.env.TERM==="xterm-ghostty")return[...];return[...]}
const spinnerFuncPattern = /function ([$\w]+)\(\)\{if\(process\.env\.TERM==="xterm-ghostty"\)return\["[^"]+(?:","[^"]+)*"\];return\["[^"]+(?:","[^"]+)*"\]\}/;

// Pattern for already-patched spinner function (simple return form)
// Patched: function $vA(){return["◐","◓","◑","◒"]}
const patchedSpinnerPattern = /function ([$\w]+)\(\)\{return(\["[^"]+(?:","[^"]+)*"\])\}/g;

let match = content.match(spinnerFuncPattern);
let isRepatch = false;
let currentChars = null;

if (!match) {
  // Try to find an already-patched spinner function
  let patchedMatch;
  while ((patchedMatch = patchedSpinnerPattern.exec(content)) !== null) {
    const candidateName = patchedMatch[1];
    const arrayStr = patchedMatch[2];

    // Parse the array to check if it looks like spinner chars
    try {
      const arr = JSON.parse(arrayStr);
      // Spinner arrays are typically 4-12 single-char strings
      if (arr.length >= 2 && arr.length <= 16 &&
          arr.every(c => typeof c === 'string' && c.length === 1)) {
        // Check if this function is referenced in a mirror pattern (confirms it's the spinner)
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
  console.error('❌ Could not find spinner function pattern');
  console.error('   This might be an unsupported Claude Code version');
  console.error('   Or the spinner function was modified in an unexpected way');
  process.exit(1);
}

const funcName = match[1];

if (isRepatch) {
  console.log(`✓ Found already-patched spinner function: ${funcName}()`);
  console.log(`  Current chars: ${currentChars.join(' ')}`);
  console.log();
  console.log('Current:');
  console.log(`  ${match[0]}`);
} else {
  console.log(`✓ Found spinner function: ${funcName}()`);
  console.log();
  console.log('Original:');
  console.log(`  ${match[0].slice(0, 100)}...`);
}

// Build replacement - simple function that returns our custom array
const charsJson = JSON.stringify(SPINNER_CHARS);
const replacement = `function ${funcName}(){return${charsJson}}`;

console.log();
console.log('New:');
console.log(`  ${replacement}`);
console.log();
console.log(`Spinner sequence: ${SPINNER_CHARS.join(' ')}`);

if (isRepatch) {
  console.log();
  console.log('(Re-patching spinner characters only - mirror/freeze already handled)');
} else {
  console.log(`Animation mode: ${LOOP_MODE ? 'loop' : 'mirror'}`);
}

// If LOOP_MODE is enabled, also patch the mirror array construction
// Skip if re-patching (already done)
let mirrorMatches = [];
if (LOOP_MODE && !isRepatch) {
  // Pattern: VAR1=SPINNERFUNC(),VAR2=[...VAR1,...[...VAR1].reverse()]
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
    console.log();
    console.log(`✓ Found ${mirrorMatches.length} mirror pattern(s) to patch for loop mode`);
    for (const mm of mirrorMatches) {
      console.log(`  ${mm.baseVar} → ${mm.arrayVar}`);
    }
  }
}

// Find freeze branch if NO_FREEZE is enabled
// Skip if re-patching (already done)
let freezeMatches = [];
if (NO_FREEZE && !isRepatch) {
  // Match the whole useInterval call with the freeze branch
  const freezePattern = /\b([$\w]+)\(\(\)=>\{if\(!([$\w]+)\)\{([$\w]+)\(\d+\);return\}(\3)\(\([^)]+\)=>[^)]+\+1\)\},(\d+)\)/g;

  let m;
  while ((m = freezePattern.exec(content)) !== null) {
    freezeMatches.push({
      full: m[0],
      hookName: m[1],
      condVar: m[2],
      setterName: m[3],
      interval: m[5]
    });
  }

  if (freezeMatches.length > 0) {
    console.log();
    console.log(`✓ Found ${freezeMatches.length} freeze branch(es) to remove`);
    for (const fm of freezeMatches) {
      console.log(`  ${fm.hookName}(...{if(!${fm.condVar}){${fm.setterName}(4);return}...}, ${fm.interval})`);
    }
  }
}

if (dryRun) {
  console.log();
  console.log('(Dry run - no changes made)');
  process.exit(0);
}

// Apply the patches
let patchedContent = content.replace(match[0], replacement);

// Apply mirror patches if LOOP_MODE
if (LOOP_MODE) {
  for (const mm of mirrorMatches) {
    const loopReplacement = `${mm.baseVar}=${funcName}(),${mm.arrayVar}=[...${mm.baseVar}]`;
    patchedContent = patchedContent.replace(mm.full, loopReplacement);
  }
}

// Apply freeze branch removal if NO_FREEZE
if (NO_FREEZE) {
  for (const fm of freezeMatches) {
    const noFreezeReplacement = fm.full.replace(
      /if\(![$\w]+\)\{[$\w]+\(\d+\);return\}/,
      ''
    );
    patchedContent = patchedContent.replace(fm.full, noFreezeReplacement);
  }
}

// Write patched file
try {
  fs.writeFileSync(targetPath, patchedContent);
  console.log();
  console.log(`✓ Patched ${targetPath}`);
  console.log();
  console.log('Restart Claude Code to see the new spinner.');
} catch (err) {
  console.error(`Failed to write patched file: ${err.message}`);
  process.exit(1);
}

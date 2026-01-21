#!/usr/bin/env node
/**
 * Patch to customize the Claude Code spinner animation
 *
 * The spinner is the animated symbol shown while Claude is working.
 * This patch replaces the platform-specific spinner function with
 * a custom sequence.
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
const SPINNER_CHARS = ["◐","◓","◑","◒"];

// Animation mode:
//   false = mirror (default): cycles forward then backward (0,1,2,3,2,1,0,...)
//   true  = loop: cycles forward continuously (0,1,2,3,0,1,2,3,...)
//
// Loop mode works better for directional spinners (rotating shapes).
// Mirror mode works better for symmetric patterns (pulsing, filling).
//
const LOOP_MODE = true;

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

// Pattern for the spinner function
// Original: function RxA(){if(process.env.TERM==="xterm-ghostty")return[...];return process.platform==="darwin"?[...]:["..."]}
// We match the entire function and replace it with a simple return
const spinnerFuncPattern = /function ([$\w]+)\(\)\{if\(process\.env\.TERM==="xterm-ghostty"\)return\["[·✢✳✶✻\*]+(?:","[·✢✳✶✻\*]+)*"\];return process\.platform==="darwin"\?\["[·✢✳✶✻✽]+(?:","[·✢✳✶✻✽]+)*"\]:\["[·✢✳✶✻\*✽]+(?:","[·✢✳✶✻\*✽]+)*"\]\}/;

const match = content.match(spinnerFuncPattern);

if (!match) {
  console.error('❌ Could not find spinner function pattern');
  console.error('   This might be an unsupported Claude Code version');
  process.exit(1);
}

const funcName = match[1];
console.log(`✓ Found spinner function: ${funcName}()`);
console.log();
console.log('Original:');
console.log(`  ${match[0].slice(0, 80)}...`);

// Build replacement - simple function that returns our custom array
const charsJson = JSON.stringify(SPINNER_CHARS);
const replacement = `function ${funcName}(){return${charsJson}}`;

console.log();
console.log('Patched:');
console.log(`  ${replacement}`);
console.log();
console.log(`Spinner sequence: ${SPINNER_CHARS.join(' ')}`);
console.log(`Animation mode: ${LOOP_MODE ? 'loop' : 'mirror'}`);

// If LOOP_MODE is enabled, also patch the mirror array construction
let mirrorMatches = [];
if (LOOP_MODE) {
  // Pattern: VAR1=SPINNERFUNC(),VAR2=[...VAR1,...[...VAR1].reverse()]
  // This creates the mirrored animation array
  // Note: funcName may contain $ which must be escaped for regex
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
    // Change: VAR1=func(),VAR2=[...VAR1,...[...VAR1].reverse()]
    // To:     VAR1=func(),VAR2=[...VAR1]
    const loopReplacement = `${mm.baseVar}=${funcName}(),${mm.arrayVar}=[...${mm.baseVar}]`;
    patchedContent = patchedContent.replace(mm.full, loopReplacement);
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

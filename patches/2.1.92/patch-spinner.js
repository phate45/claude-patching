#!/usr/bin/env node
/**
 * Patch to customize the Claude Code spinner animation (2.1.92+)
 *
 * The "thinking header" spinner is the animated symbol shown while Claude thinks.
 * In 2.1.92 the spinner function changed from a standalone function to a
 * memoized closure: VAR = _8(() => { if(ghostty)...; return[...] }, cacheKey)
 *
 * This patch replaces the memoized closure with a simple return of custom chars,
 * converts mirror arrays to loop arrays, and removes the freeze branch.
 *
 * Usage:
 *   node patch-spinner.js <cli.js path>
 *   node patch-spinner.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../lib/output');

// ============================================================
// CONFIGURATION - Edit this to customize your spinner
// ============================================================

const SPINNER_CHARS = ["·","·","✧","✦","✧","·"];

// Animation mode:
//   false = mirror (default): cycles forward then backward
//   true  = loop: cycles forward continuously
const LOOP_MODE = true;

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

// Pattern for 2.1.92+ memoized spinner function:
// VAR=_8(()=>{if(process.env.TERM==="xterm-ghostty")return[...];return[...]},()=>process.env.TERM)
const memoizedPattern = /([$\w]+)=_8\(\(\)=>\{if\(process\.env\.TERM==="xterm-ghostty"\)return\["[^"]*(?:","[^"]*)*"\];return\["[^"]*(?:","[^"]*)*"\]\},\(\)=>process\.env\.TERM\)/;

// Pattern for already-patched (simple assignment):
// VAR=_8(()=>{return[...]},()=>process.env.TERM)
// or VAR=_8(()=>["..."],()=>process.env.TERM)
const patchedPattern = /([$\w]+)=_8\(\(\)=>\{return(\["[^"]*(?:","[^"]*)*"\])\},\(\)=>process\.env\.TERM\)/;

let match = content.match(memoizedPattern);
let isRepatch = false;
let currentChars = null;

if (!match) {
  // Try already-patched form
  match = content.match(patchedPattern);
  if (match) {
    isRepatch = true;
    try { currentChars = JSON.parse(match[2]); } catch {}
  }
}

// Fallback: try the old standalone function pattern (pre-2.1.92)
if (!match) {
  const standalonePattern = /function ([$\w]+)\(\)\{if\(process\.env\.TERM==="xterm-ghostty"\)return\["[^"]+(?:","[^"]+)*"\];return\["[^"]+(?:","[^"]+)*"\]\}/;
  match = content.match(standalonePattern);
  if (match) {
    // Old format — delegate to the 2.1.19 patch
    output.error('Found old-style spinner function (pre-2.1.92)', [
      'Use 2.1.19/patch-spinner.js for this version'
    ]);
    process.exit(1);
  }
}

if (!match) {
  output.error('Could not find spinner function pattern', [
    'Expected: VAR=_8(()=>{if(process.env.TERM==="xterm-ghostty")return[...];return[...]},()=>process.env.TERM)',
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

const varName = match[1];

if (isRepatch) {
  output.discovery('spinner function', varName, { 'Status': 'already patched', 'Current chars': currentChars?.join(' ') || 'unknown' });
} else {
  output.discovery('spinner function', varName, { 'Status': 'original' });
  output.info(`Original: ${match[0].slice(0, 120)}...`);
}

// Build replacement — keep the memoizer wrapper but simplify the body
const charsJson = JSON.stringify(SPINNER_CHARS);
const replacement = `${varName}=_8(()=>{return${charsJson}},()=>process.env.TERM)`;

output.modification('spinner chars', match[0].slice(0, 120) + '...', replacement);
output.info(`Spinner sequence: ${SPINNER_CHARS.join(' ')}`);

// Find mirror array constructions: VAR1=SPINNERFUNC(),VAR2=[...VAR1,...[...VAR1].reverse()]
let mirrorMatches = [];
if (LOOP_MODE && !isRepatch) {
  const escapedVar = varName.replace(/\$/g, '\\$');
  const mirrorPattern = new RegExp(
    `([$\\w]+)=${escapedVar}\\(\\),([$\\w]+)=\\[\\.\\.\\.\\1,\\.\\.\\.\\[\\.\\.\\.\\1\\]\\.reverse\\(\\)\\]`,
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
      const before = `${mm.baseVar}=${varName}(),${mm.arrayVar}=[...${mm.baseVar},...[...${mm.baseVar}].reverse()]`;
      const after = `${mm.baseVar}=${varName}(),${mm.arrayVar}=[...${mm.baseVar}]`;
      output.modification(`mirror ${i}`, before, after);
    }
  }
}

if (dryRun) {
  output.result('dry_run', 'Patch point found');
  process.exit(0);
}

// Apply patches
let patchedContent = content.replace(match[0], replacement);

if (LOOP_MODE) {
  for (const mm of mirrorMatches) {
    const loopReplacement = `${mm.baseVar}=${varName}(),${mm.arrayVar}=[...${mm.baseVar}]`;
    patchedContent = patchedContent.replace(mm.full, loopReplacement);
  }
}

try {
  fs.writeFileSync(targetPath, patchedContent);
  output.result('success', `Patched ${targetPath}`);
  output.info('Restart Claude Code to see the new spinner.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Patch to add fish-style abbreviation expansion to the input pipeline.
 *
 * Injects expansion logic in the submit orchestrator, right between the
 * empty-input guard and the exit alias check — the same spot where CC
 * already rewrites ":q" → "/exit". Two modes:
 *
 * 1. Exact match — first token matched, trailing args preserved:
 *    "gs" → "git status", "gs ." → "git status ."
 *
 * 2. Regex match — keys starting with "/" are regex patterns tested against
 *    the full input. One capture group ($1) is interpolated into the value:
 *    "/^rw (\\d+)$" → "Hey, Claude. Review MR $1 for me, please."
 *
 * Usage:
 *   CLAUDE_CODE_ABBREVIATIONS='{"gs":"git status","/^rw (\\d+)$":"Review MR $1"}' claude
 *
 * The JSON object maps trigger words (or /regex patterns) to expansions.
 * Exact keys split on space, dot, comma, or semicolon separators.
 * Regex keys are tried as fallback if no exact match hits.
 * Invalid JSON is silently ignored.
 *
 * Patch invocation:
 *   node patch-abbreviations.js <cli.js path>
 *   node patch-abbreviations.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-abbreviations.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Match the unique empty-input guard immediately followed by an if-statement.
// Structure: if(INPUT.trim()===""&&!GUARD)return;if(
// The INPUT variable is captured — we inject expansion that reassigns it.
const pattern = /if\(([\w$]+)\.trim\(\)===""&&!([\w$]+)\)return;if\(/;
const match = content.match(pattern);

if (!match) {
  output.error('Could not find submit orchestrator empty-input guard', [
    'Expected: if(X.trim()===""&&!Y)return;if(',
    'The submit orchestrator structure may have changed'
  ]);
  process.exit(1);
}

const [original, inputVar, guardVar] = match;

output.discovery('submit orchestrator', inputVar, {
  'input variable': inputVar,
  'guard variable': guardVar,
  'env var': 'CLAUDE_CODE_ABBREVIATIONS'
});

// Inject abbreviation expansion between the empty guard and exit alias check.
// globalThis.__abbrevMap caches the parsed JSON — env var is read once per session.
// try/catch on init silently ignores bad JSON (map stays empty).
//
// Logic:
//   1. Init cache from CLAUDE_CODE_ABBREVIATIONS on first submit
//   2. Split trimmed input on first separator (space, dot, comma, semicolon) → key + rest
//   3. If key matches exactly, reassign input var to expansion (+ rest if present)
//   4. If no exact match, try keys starting with "/" as regex against full input
//      Single capture group ($1) is interpolated into the expansion value
//      Any input after the regex match is appended (use $ anchor to suppress)
const expansion = [
  `{if(!globalThis.__abbrevMap){try{let _e=process.env.CLAUDE_CODE_ABBREVIATIONS;`,
  `globalThis.__abbrevMap=_e?JSON.parse(_e):{}}catch{globalThis.__abbrevMap={}}}`,
  `let _m=globalThis.__abbrevMap,`,
  `_t=${inputVar}.trim(),`,
  `_i=_t.search(/[ .,;]/),`,
  `_k=_i===-1?_t:_t.slice(0,_i);`,
  `if(_k in _m)${inputVar}=_i===-1?_m[_k]:_m[_k]+_t.slice(_i);`,
  `else{for(let _p of Object.keys(_m)){if(_p[0]==="/"){`,
  `let _x=_t.match(new RegExp(_p.slice(1)));`,
  `if(_x){${inputVar}=_m[_p].replace("$1",_x[1]||"")+_t.slice(_x.index+_x[0].length);break}}}}`,
  `}`
].join('');

const replacement = `if(${inputVar}.trim()===""&&!${guardVar})return;${expansion}if(`;

output.modification('submit orchestrator', original, replacement);

if (dryRun) {
  output.result('dry_run', 'Submit orchestrator found — ready to patch');
  process.exit(0);
}

content = content.replace(original, replacement);

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Patched abbreviation expansion (${inputVar}) in ${targetPath}`);
  output.info('Set CLAUDE_CODE_ABBREVIATIONS=\'{"gs":"git status","/^rw (\\\\d+)$":"Review MR $1"}\' to define abbreviations');
  output.info('Exact keys: first token matched, trailing args preserved. /regex keys: $1 interpolation, full input match.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

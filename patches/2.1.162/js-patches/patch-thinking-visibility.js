#!/usr/bin/env node
/**
 * Minimal patch to make Claude Code thinking blocks visible inline (2.1.162)
 *
 * What it does:
 * 1. Finds the case"thinking": renderer block
 * 2. Removes the "if not transcript mode and not verbose, return null" check
 * 3. Sets isTranscriptMode to always be true
 *
 * Changes from 2.1.69 native:
 * - hideInTranscript expression simplified from `O&&!(!J||X===J)` to `D&&L===P`
 *   (parent thinkingId equality check instead of negated-alternative form)
 * - Three more memo cache slots ($[22..27] -> $[49..54]); pattern uses [$\w]+
 *
 * Usage:
 *   node patch-thinking-visibility.js <cli.js path>
 *   node patch-thinking-visibility.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-thinking-visibility.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}:`, [err.message]);
  process.exit(1);
}

// Pattern for CC 2.1.162:
// case"thinking":{if(!D&&!z)return null;let y=D&&L===P,R;if($[49]!==K||$[50]!==D||$[51]!==q||$[52]!==y||$[53]!==z)R=C_.createElement(r$$,{addMargin:K,param:q,isTranscriptMode:D,verbose:z,hideInTranscript:y}),$[49]=K,$[50]=D,$[51]=q,$[52]=y,$[53]=z,$[54]=R;else R=$[54];return R}
//
// Strategy: remove the null-return gate, set isTranscriptMode to !0 in the createElement args
const pattern =
  /(case"thinking":)\{if\(!([$\w]+)&&!([$\w]+)\)return null;(let [$\w]+=[$\w]+&&[$\w]+===[$\w]+,[$\w]+;if\([$\w]+\[[$\w]+\]!==[$\w]+\|\|[$\w]+\[[$\w]+\]!==[$\w]+\|\|[$\w]+\[[$\w]+\]!==[$\w]+\|\|[$\w]+\[[$\w]+\]!==[$\w]+\|\|[$\w]+\[[$\w]+\]!==[$\w]+\)[$\w]+=[$\w]+\.createElement\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,isTranscriptMode:)([$\w]+)(,verbose:[$\w]+,hideInTranscript:[$\w]+\})/;

const match = content.match(pattern);

if (!match) {
  output.error('Could not find thinking visibility pattern in cli.js', [
    'This might be an unsupported Claude Code version',
    'Expected pattern: case"thinking":{if(!VAR&&!VAR)return null;let VAR=...isTranscriptMode:VAR,verbose:VAR,hideInTranscript:VAR}'
  ]);
  process.exit(1);
}

output.discovery('thinking visibility pattern', '2.1.162', {
  isTranscriptMode_variable: match[5],
  condition_variables: `${match[2]}, ${match[3]}`
});
output.info(`Original: ${match[0].slice(0, 120)}...`);

// Build the replacement:
// - Remove the if(!O&&!I)return null; check
// - Set isTranscriptMode to !0
const replacement = `${match[1]}{${match[4]}!0${match[6]}`;

output.modification('pattern',
  `if(!${match[2]}&&!${match[3]})return null; ... isTranscriptMode:${match[5]}`,
  `isTranscriptMode:!0`);

if (dryRun) {
  output.result('dry_run', 'Patch point found');
  process.exit(0);
}

const patchedContent = content.slice(0, match.index) + replacement + content.slice(match.index + match[0].length);

try {
  fs.writeFileSync(targetPath, patchedContent);
  output.result('success', `Patched ${targetPath}`);
  output.info('Restart Claude Code to see thinking blocks inline.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

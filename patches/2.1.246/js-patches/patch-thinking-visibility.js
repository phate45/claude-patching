#!/usr/bin/env node
/**
 * Minimal patch to make Claude Code thinking blocks visible inline (2.1.246)
 *
 * What it does:
 * 1. Finds the case"thinking" full-render (the `wl` component carrying
 *    {addMargin,param,isTranscriptMode,verbose})
 * 2. Removes the "if not transcript mode and not verbose, return null" guard
 *    that sits immediately before it
 * 3. Forces isTranscriptMode to !0 in the render args
 *
 * Changes from 2.1.209:
 * - JSX factory dropped from the member form `RUNTIME.jsx(COMP,{…})` to a BARE
 *   import-aliased call `o(COMP,{…})` (2.1.234 render rework + module-split
 *   import aliasing). The render match now accepts a bare `FACTORY(`.
 * - A NEW leading compact-render branch was prepended inside case"thinking":
 *   `if(Vh!==null&&Yh!==null&&Vh(param)){…}` (the collapsed "dot" summary path).
 *   It is left untouched — this patch only drops the null guard and forces
 *   transcript mode on the full render.
 * - `if(!X&&!Y){return null}` occurs twice in the bundle, so the guard is NOT
 *   matched on its own; it is anchored to the one immediately followed by the
 *   thinking full-render (matched through to its isTranscriptMode prop).
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

// Match the null guard + memo preamble + full-render, up to the isTranscriptMode
// prop value. Anchoring the guard to the render that follows disambiguates it
// from the other `if(!X&&!Y){return null}` in the bundle.
//   if(!li&&!et){return null}let eo;if(mi[42]!==fo||…)eo=o(wl,{addMargin:fo,
//   param:Pe,isTranscriptMode:li,verbose:et}),…
const pattern =
  /if\(!([$\w]+)&&!([$\w]+)\)\{?return null\}?;?(let [$\w]+;if\([^)]*\)[$\w]+=[$\w]+\([$\w]+,\{addMargin:[$\w]+,param:[$\w]+,isTranscriptMode:)([$\w]+)(,verbose:[$\w]+\})/;

const match = content.match(pattern);

if (!match) {
  output.error('Could not find thinking visibility pattern in cli.js', [
    'This might be an unsupported Claude Code version',
    'Expected: if(!X&&!Y){return null}let V;if(…)V=o(COMP,{addMargin:…,param:…,isTranscriptMode:X,verbose:Y})'
  ]);
  process.exit(1);
}

output.discovery('thinking visibility pattern', '2.1.246', {
  isTranscriptMode_variable: match[4],
  condition_variables: `${match[1]}, ${match[2]}`
});
output.info(`Original: ${match[0].slice(0, 120)}...`);

// Build the replacement:
// - Drop the if(!X&&!Y){return null} guard (omit it from the replacement)
// - Keep the memo preamble ($3) and set isTranscriptMode to !0
const replacement = `${match[3]}!0${match[5]}`;

output.modification('pattern',
  `if(!${match[1]}&&!${match[2]})return null; ... isTranscriptMode:${match[4]}`,
  `isTranscriptMode:!0 (guard removed)`);

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

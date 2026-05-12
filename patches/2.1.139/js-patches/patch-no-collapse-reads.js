#!/usr/bin/env node
/**
 * Patch to disable collapsing of Read/Search tool calls (2.1.139)
 *
 * 2.1.39 introduced "collapsed_read_search" — consecutive Read/Grep/Glob
 * tool calls get folded into a "Read 3 files (ctrl+o to expand)" summary.
 * We've been disabling this since then by short-circuiting the predicate
 * that decides "is this message eligible for collapse inspection?".
 *
 * 2.1.139 refactor: the predicate was rewritten without the inner
 * `let A = H.message.content[0]` aliasing and now returns a tool_use boolean
 * directly via optional chaining:
 *
 *   function $q5(H){
 *     if(H.type==="assistant")return H.message.content[0]?.type==="tool_use";
 *     if(H.type==="grouped_tool_use")return H.messages[0]?.message.content[0]?.type==="tool_use";
 *     return!1
 *   }
 *
 * It's called from the collapse driver as `$q5(z) ? t65(z, $) : null`. By
 * injecting `return!1;` at the function head we keep that call returning
 * null and skip the entire collapse pipeline.
 *
 * Usage:
 *   node patch-no-collapse-reads.js <cli.js path>
 *   node patch-no-collapse-reads.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-no-collapse-reads.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

const collapsePredicatePattern = /(function [$\w]+\(([$\w]+)\)\{)(if\(\2\.type==="assistant"\)return \2\.message\.content\[0\]\?\.type==="tool_use";if\(\2\.type==="grouped_tool_use"\)return \2\.messages\[0\]\?\.message\.content\[0\]\?\.type==="tool_use";return!1\})/;

const match = content.match(collapsePredicatePattern);

if (!match) {
  output.error('Could not find collapse predicate function pattern', [
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

const funcSignature = match[1];
const funcBody = match[3];
output.discovery('collapse predicate', match[0].slice(0, 80) + '...');

const original = funcSignature + funcBody;
const patched = funcSignature + 'return!1;' + funcBody;

output.modification('collapse predicate', original.slice(0, 80) + '...', patched.slice(0, 80) + '...');

if (dryRun) {
  output.result('dry_run', 'No changes made');
  process.exit(0);
}

const patchedContent = content.replace(original, patched);

if (patchedContent === content) {
  output.error('Patch failed to apply (content unchanged)');
  process.exit(1);
}

try {
  fs.writeFileSync(targetPath, patchedContent);
  output.result('success', `Patched ${targetPath}`);
  output.info('Read/Search tool calls will now display individually.');
  output.info('Restart Claude Code to apply the change.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

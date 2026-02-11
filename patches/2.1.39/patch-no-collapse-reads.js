#!/usr/bin/env node
/**
 * Patch to disable collapsing of Read/Search tool calls
 *
 * CC 2.1.39 introduced "collapsed_read_search" grouping that collapses
 * consecutive Read/Grep/Glob tool calls into a single summary line like
 * "Read 3 files (ctrl+o to expand)". This patch disables that behavior
 * so each tool call is shown individually with its filename and details.
 *
 * The patch targets the predicate function that determines whether a
 * message is collapsible. By making it always return false, no messages
 * are ever grouped into collapsed_read_search nodes.
 *
 * Usage:
 *   node patch-no-collapse-reads.js <cli.js path>
 *   node patch-no-collapse-reads.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../lib/output');

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

// Match the "is this message collapsible?" predicate function.
// Structure: function NAME(H,$){if(H.type==="assistant"){let A=H.message.content[0];return A?.type==="tool_use"&&FUNC(A.name,A.input,$)}if(H.type==="grouped_tool_use"){...}return!1}
//
// The key structural pattern is:
//   function FUNC(VAR,VAR){if(VAR.type==="assistant"){let VAR=VAR.message.content[0];return VAR?.type==="tool_use"
// followed eventually by:
//   if(VAR.type==="grouped_tool_use")
// and ending with:
//   return!1}
//
// We inject `return!1;` right after the opening brace to short-circuit all collapsing.
const collapsePredicatePattern = /(function [$\w]+\([$\w]+,[$\w]+\)\{)(if\([$\w]+\.type==="assistant"\)\{let [$\w]+=[$\w]+\.message\.content\[0\];return [$\w]+\?\.type==="tool_use"&&[$\w]+\([$\w]+\.name,[$\w]+\.input,[$\w]+\)}if\([$\w]+\.type==="grouped_tool_use"\))/;

const match = content.match(collapsePredicatePattern);

if (!match) {
  output.error('Could not find collapse predicate function pattern', [
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

const funcSignature = match[1];
const funcBody = match[2];
output.discovery('collapse predicate', match[0].slice(0, 80) + '...');

const original = funcSignature + funcBody;
const patched = funcSignature + 'return!1;' + funcBody;

output.modification('collapse predicate', original.slice(0, 80) + '...', patched.slice(0, 80) + '...');

if (dryRun) {
  output.result('dry_run', 'No changes made');
  process.exit(0);
}

const patchedContent = content.replace(original, patched);

// Verify
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

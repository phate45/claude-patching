#!/usr/bin/env node
/**
 * Patch to make ToolSearch tool calls visible in the TUI
 *
 * CC 2.1.71+ suppressed all ToolSearch rendering — renderToolUseMessage
 * returns null and userFacingName returns "". The user never sees what
 * tools are being searched for or loaded.
 *
 * In 2.1.84, the render functions moved from separate named functions
 * to inline methods on the tool definition object. renderToolResultMessage
 * was removed entirely. This patch targets the inline structure:
 *
 * 1. userFacingName: ()=>"" → ()=>"ToolSearch"
 * 2. renderToolUseMessage(){return null} → renderToolUseMessage(H){return H.query||""}
 *
 * The anchor is unique: the only tool with userFacingName:()=>"".
 *
 * Usage:
 *   node patch-toolsearch-visibility.js <cli.js path>
 *   node patch-toolsearch-visibility.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-toolsearch-visibility.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// ============================================================
// Find the inline render block — unique anchor is the empty
// userFacingName adjacent to renderToolUseMessage returning null.
//
// Pattern in 2.1.84:
//   renderToolUseMessage(){return null},userFacingName:()=>""
// ============================================================

const inlinePattern = /renderToolUseMessage\(\)\{return null\},userFacingName:\(\)=>""/;
const match = content.match(inlinePattern);

if (!match) {
  output.error('Could not find ToolSearch render block pattern', [
    'Expected: renderToolUseMessage(){return null},userFacingName:()=>"" in tool definition',
    'This might be an unsupported Claude Code version',
  ]);
  process.exit(1);
}

output.discovery('ToolSearch inline render block', match[0], null);

// ============================================================
// Replace both in one shot:
// - renderToolUseMessage: accept input H, return query string
// - userFacingName: return "ToolSearch" instead of ""
// ============================================================

const find = 'renderToolUseMessage(){return null},userFacingName:()=>""';
const replace = 'renderToolUseMessage(H){return H.query||""},userFacingName:()=>"ToolSearch"';

let patched = content.replace(find, replace);

if (patched === content) {
  output.error('Replacement failed — find string not in content');
  process.exit(1);
}

output.modification('renderToolUseMessage', '{return null}', '(H){return H.query||""}');
output.modification('userFacingName', '""', '"ToolSearch"');

if (dryRun) {
  output.result('dry_run', '2 patch points found');
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, patched);
  output.result('success', `Patched ${targetPath} (2 changes)`);
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Patch to fix resume cache regression (present since 2.1.69)
 *
 * The JSONL session write filter (isLoggableMessage) drops attachment
 * messages of type "deferred_tools_delta" and "mcp_instructions_delta"
 * from the session file. When a session resumes, those attachments are
 * missing from the reconstructed conversation context, breaking cache
 * prefix alignment and forcing expensive re-caching from scratch.
 *
 * The fix adds both attachment types to the allow-list in the filter
 * function, right before the final `return !1` fallthrough.
 *
 * Based on analysis from /tmp/cc-cache-fix (standalone cache fix toolkit).
 *
 * Usage:
 *   node patch-resume-cache-fix.js <cli.js path>
 *   node patch-resume-cache-fix.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-resume-cache-fix.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// ── Find the isLoggableMessage filter function ──
//
// Structure (2.1.89):
//   function _q$(H){
//     if(H.type==="progress")return!1;
//     if(H.type==="attachment"&&tn$()!=="ant"){
//       if(H.attachment.type==="hook_additional_context"&&dH(process.env.CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT))return!0;
//       if(H.attachment.type==="hook_deferred_tool")return!0;
//       return!1    ← deferred_tools_delta and mcp_instructions_delta die here
//     }
//     return!0
//   }
//
// We match the tail of the attachment block: the last allow (hook_deferred_tool)
// followed by the reject fallthrough, anchored by the function's closing `return!0}`.
//
// Inject: if(H.attachment.type==="deferred_tools_delta"||H.attachment.type==="mcp_instructions_delta")return!0;

const pattern = /(if\(([$\w]+)\.attachment\.type==="hook_deferred_tool"\)return!0;)(return!1\}return!0\})/;

const match = content.match(pattern);

if (!match) {
  output.error('Could not find isLoggableMessage attachment filter', [
    'Expected: ...hook_deferred_tool")return!0;return!1}return!0}',
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

output.discovery('isLoggableMessage filter', match[0].slice(0, 80) + '...');

const argVar = match[2]; // The function parameter (H)

const oldTail = match[0];
const newTail = `${match[1]}if(${argVar}.attachment.type==="deferred_tools_delta"||${argVar}.attachment.type==="mcp_instructions_delta")return!0;${match[3]}`;

output.modification('persist cache-critical attachments', oldTail, newTail);

content = content.replace(oldTail, () => newTail);

// ── Write ──

if (dryRun) {
  output.result('dry_run', 'Resume cache fix ready — deferred_tools_delta + mcp_instructions_delta will be persisted');
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', 'Resume cache fix applied — session JSONL will now persist cache-critical attachments');
  output.info('Restart Claude Code to apply the change.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

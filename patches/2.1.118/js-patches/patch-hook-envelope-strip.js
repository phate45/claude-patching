#!/usr/bin/env node
/**
 * Patch: strip the "${hookName} hook success:" envelope from hook-success
 * system-reminder attachments.
 *
 * Scope is naturally narrow — the renderer at line 388007-388013 is already
 * gated so only SessionStart, UserPromptSubmit, and UserPromptExpansion events
 * ever reach this template. PreToolUse, PostToolUse, Notification, Stop, etc.
 * return [] above the template and emit nothing here.
 *
 * Rationale: the envelope adds 30+ characters of harness plumbing around the
 * actual hook payload. Hook content is self-describing in practice (e.g.
 * "Temporal grounding: Thursday, 2026-04-23 22:07:43") and the added framing
 * tends to get lost in the surrounding system prompt noise.
 *
 * Before:
 *   content:rT(`${H.hookName} hook success: ${H.content}`)
 * After:
 *   content:rT(`${H.content}`)
 *
 * Usage:
 *   node patch-hook-envelope-strip.js <cli.js path>
 *   node patch-hook-envelope-strip.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-hook-envelope-strip.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Match the hook_success template literal. Capture the attachment-object var
// (`H` in current builds) with a backreference to guarantee both ${...}
// interpolations reference the same identifier.
const pattern = /`\$\{([$\w]+)\.hookName\} hook success: \$\{\1\.content\}`/;

const match = content.match(pattern);

if (!match) {
  output.error('Could not find hook_success template literal');
  process.exit(1);
}

const varName = match[1];
output.discovery('hook_success template', match[0], { 'attachment var': varName });

content = content.replace(pattern, (_m, v) => '`${' + v + '.content}`');

output.modification(
  'strip hook envelope',
  match[0],
  '`${' + varName + '.content}`'
);

if (dryRun) {
  output.result('dry_run', 'hook-envelope-strip: 1/1 patch verified');
} else {
  fs.writeFileSync(targetPath, content, 'utf8');
  output.result('success', 'hook-envelope-strip: 1/1 patch applied');
}

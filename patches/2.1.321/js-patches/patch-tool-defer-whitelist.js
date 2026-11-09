#!/usr/bin/env node
/**
 * Patch to whitelist specific tools as immediately available (non-deferred).
 *
 * Claude Code defers most tools behind ToolSearch by default. The
 * isDeferredTool() function gates this — MCP tools are always deferred,
 * and built-in tools with shouldDefer:true stay deferred even when the
 * tengu_defer_all_bn4 flag is disabled.
 *
 * This patch injects a whitelist check at the TOP of isDeferredTool(),
 * ahead of all built-in logic including the MCP gate. Any tool whose
 * name appears in the whitelist is immediately available.
 *
 * Usage:
 *   CLAUDE_CODE_IMMEDIATE_TOOLS='mcp__context-mode__search,WebFetch' claude
 *
 * The comma-separated list of tool names bypasses all deferral logic.
 * Tools not in the list fall through to the original isDeferredTool flow.
 * When the env var is unset, behavior is unchanged.
 *
 * 2.1.177 change: isDeferredTool gained an additional early-return guard
 * (if(oT7().includes(H.name))return!1;) between the alwaysLoad return and
 * the isMcp gate. The pattern now lazily absorbs any number of these
 * leading guard clauses and re-emits them verbatim ahead of the isMcp gate.
 *
 * 2.1.295 change: the MCP gate moved into a separate helper and the
 * function gained a second parameter. The pattern now anchors on the head
 * alone (signature + alwaysLoad return) and injects ahead of it.
 *
 * 2.1.321 change: the gate split into two entry points sharing one tail
 * predicate (`f(e,n)`, keyed on `areRareBuiltinsDeferred`); the whitelist
 * now lands at the head of that predicate, covering both.
 *
 * Patch invocation:
 *   node patch-tool-defer-whitelist.js <cli.js path>
 *   node patch-tool-defer-whitelist.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-tool-defer-whitelist.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// 2.1.321: isDeferredTool split into two entry points (D6 -> u7e(e,n,r={})
// and a hook-free sibling mSs(e)), each consulting the hook-override memo
// first. Both fall through to one shared tail predicate, the only code that
// ever answers "deferred":
//   function f(e,n){if(e.isMcp===!0)return!0;if((n.areRareBuiltinsDeferred??=…
// Injecting there covers every entry point. Hook overrides still win, as
// they did before (they run ahead of isDeferredTool).
//
// Captures:
//   $1 = function name
//   $2 = tool parameter
//   $3 = options parameter
const pattern = /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{if\(\2\.isMcp===!0\)return!0;if\(\(\3\.areRareBuiltinsDeferred\?\?=/;

const match = content.match(pattern);

if (!match) {
  output.error('Could not find isDeferredTool function', [
    'Expected: function f(e,n){if(e.isMcp===!0)return!0;if((n.areRareBuiltinsDeferred??=...',
    'The isDeferredTool tail predicate may have changed'
  ]);
  process.exit(1);
}

const [original, fnName, param, optParam] = match;

// Check for already-patched marker
if (content.includes('globalThis.__immTools')) {
  output.result('dry_run', 'isDeferredTool already patched with whitelist');
  process.exit(0);
}

output.discovery('isDeferredTool tail predicate', fnName, {
  'parameter': param,
  'env var': 'CLAUDE_CODE_IMMEDIATE_TOOLS'
});

// The lazy-init pattern caches the Set in globalThis so env parsing happens once.
const injection =
  `if(!globalThis.__immTools){` +
    `let _e=process.env.CLAUDE_CODE_IMMEDIATE_TOOLS;` +
    `globalThis.__immTools=_e?new Set(_e.split(",")):new Set` +
  `}` +
  `if(globalThis.__immTools.has(${param}.name))return!1;`;

const replacement =
  `function ${fnName}(${param},${optParam}){` +
  injection +
  original.slice(original.indexOf('{') + 1);

output.modification('isDeferredTool', original.slice(0, 80) + '...', replacement.slice(0, 80) + '...');

if (dryRun) {
  output.result('dry_run', 'isDeferredTool found — ready to patch');
  process.exit(0);
}

// Use function replacer to avoid $ in minified identifiers being
// interpreted as replacement patterns ($&, $1, etc.)
content = content.replace(original, () => replacement);

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Patched isDeferredTool (${fnName}) in ${targetPath}`);
  output.info('Set CLAUDE_CODE_IMMEDIATE_TOOLS to a comma-separated list of tool names');
  output.info('Example: CLAUDE_CODE_IMMEDIATE_TOOLS=\'AskUserQuestion,WebFetch\' claude');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

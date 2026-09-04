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

// Match isDeferredTool by its unique structure. The function opens with an
// alwaysLoad early-return, then any number of further `if(...)return!1;`
// guard clauses (2.1.177 added `if(oT7().includes(H.name))return!1;`), then
// the MCP gate `if(H.isMcp===!0)return!0;`.
//
// The prefix (alwaysLoad + extra guards) is captured lazily and re-emitted
// verbatim so we don't drop any behavior.
//
// Captures:
//   $1 = function name
//   $2 = parameter name
//   $3 = guard prefix (alwaysLoad return + any further return!1 guards)
// 2.1.260: the MCP gate return changed from `return!0;` to `return!mfe();`
// (public-build DCE folds mfe() but the source form differs). Anchor only up
// to `isMcp===!0)return!` — the remainder (`0;` or `mfe();…`) stays untouched
// because content.replace swaps just the matched span.
const pattern = /function ([\w$]+)\(([\w$]+)\)\{(if\(\2\.alwaysLoad===!0\)return!1;.*?)if\(\2\.isMcp===!0\)return!/;

const match = content.match(pattern);

if (!match) {
  output.error('Could not find isDeferredTool function', [
    'Expected: function X(A){if(A.alwaysLoad===!0)return!1;[...guards...]if(A.isMcp===!0)return!0;...',
    'The isDeferredTool structure may have changed'
  ]);
  process.exit(1);
}

const [original, fnName, param, guardPrefix] = match;

// Check for already-patched marker
if (content.includes('globalThis.__immTools')) {
  output.result('dry_run', 'isDeferredTool already patched with whitelist');
  process.exit(0);
}

output.discovery('isDeferredTool function', fnName, {
  'parameter': param,
  'guard prefix': guardPrefix.slice(0, 60) + (guardPrefix.length > 60 ? '...' : ''),
  'env var': 'CLAUDE_CODE_IMMEDIATE_TOOLS'
});

// Inject whitelist check before the original body. The lazy-init pattern
// caches the Set in globalThis so env parsing happens exactly once.
// The captured guard prefix and the MCP gate are left untouched.
const injection =
  `if(!globalThis.__immTools){` +
    `let _e=process.env.CLAUDE_CODE_IMMEDIATE_TOOLS;` +
    `globalThis.__immTools=_e?new Set(_e.split(",")):new Set` +
  `}` +
  `if(globalThis.__immTools.has(${param}.name))return!1;`;

const replacement =
  `function ${fnName}(${param}){` +
  injection +
  guardPrefix +
  `if(${param}.isMcp===!0)return!`;

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

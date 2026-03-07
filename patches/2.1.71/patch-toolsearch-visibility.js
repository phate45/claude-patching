#!/usr/bin/env node
/**
 * Patch to make ToolSearch tool calls visible in the TUI
 *
 * CC 2.1.71 suppressed all ToolSearch rendering — every render function
 * returns null and userFacingName returns "". This means the user never
 * sees what tools are being searched for or loaded.
 *
 * This patch restores visibility via three targeted changes:
 * 1. userFacingName: "" → "ToolSearch" (tool-use line shows the name)
 * 2. renderToolUseMessage: null → query string (shows what was searched)
 * 3. renderToolResultMessage: null → React element (shows what was loaded)
 *
 * The render functions (e.g. e8D, LDD) are in the same top-level scope as:
 * - of = N(jH(), 1)  — React module (used as of.default.createElement)
 * - E(props)          — Ink Text component
 * - XA(props)         — Tool result wrapper (⎿ prefix + Box)
 * These are referenced in the replacement function bodies.
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
// Step 1: Find the render block to discover function names and
//         change userFacingName from "" to "ToolSearch"
//
// The unique anchor is userFacingName:()=>"" — ToolSearch is the
// only tool with an empty name.
// ============================================================

const renderBlockPattern =
  /renderToolUseMessage:([$\w]+),userFacingName:\(\)=>"",renderToolUseRejectedMessage:([$\w]+),renderToolUseErrorMessage:([$\w]+),renderToolUseProgressMessage:([$\w]+),renderToolResultMessage:([$\w]+)/;

const match = content.match(renderBlockPattern);

if (!match) {
  output.error('Could not find ToolSearch render block pattern', [
    'Expected: renderToolUseMessage:FUNC,userFacingName:()=>"",... in tool definition',
    'This might be an unsupported Claude Code version',
  ]);
  process.exit(1);
}

const useMessageFn = match[1];
const resultMessageFn = match[5];

output.discovery('ToolSearch render block', match[0].slice(0, 80) + '...', {
  renderToolUseMessage: useMessageFn,
  renderToolResultMessage: resultMessageFn,
});

// ============================================================
// Step 2: Replace the three targets
//
// a) userFacingName: ()=>"" → ()=>"ToolSearch"
//    (in the matched block — unique context)
//
// b) renderToolUseMessage function body:
//    function FUNC(){return null} → function FUNC(H){return H.query||""}
//    Returns a string — same pattern as Grep/Glob renderers.
//    TUI displays: ToolSearch(select:Read,Edit)
//
// c) renderToolResultMessage function body:
//    function FUNC(){return null} → function FUNC(H){...}
//    Must return a React element (Ink crashes on bare strings).
//    Uses of.default.createElement + XA (wrapper) + E (Text).
//    TUI displays:  ⎿  Loaded 3 tools
// ============================================================

let patched = content;
let patchCount = 0;

// (a) userFacingName
const nameFind = 'userFacingName:()=>""';
const nameReplace = 'userFacingName:()=>"ToolSearch"';
if (patched.includes(nameFind)) {
  // Only replace inside the ToolSearch block — verify context
  const idx = patched.indexOf(match[0]);
  if (idx !== -1) {
    patched = patched.replace(match[0], match[0].replace(nameFind, nameReplace));
    patchCount++;
    output.modification('userFacingName', '""', '"ToolSearch"');
  }
}

// (b) renderToolUseMessage function body
const useFnFind = `function ${useMessageFn}(){return null}`;
const useFnReplace = `function ${useMessageFn}(H){return H.query||""}`;
if (patched.includes(useFnFind)) {
  patched = patched.replace(useFnFind, useFnReplace);
  patchCount++;
  output.modification('renderToolUseMessage', useFnFind, useFnReplace);
} else {
  output.warning(`Could not find ${useMessageFn} function body`);
}

// (c) renderToolResultMessage function body
// Returns: of.default.createElement(XA,{height:1},of.default.createElement(E,null,"Loaded ",of.default.createElement(E,{bold:!0},n)," tool",n===1?"":"s"))
// Mirrors Read tool's result pattern: "Read **30** lines"
const resultFnFind = `function ${resultMessageFn}(){return null}`;
const resultFnReplace = `function ${resultMessageFn}(H){if(!H?.matches)return null;var n=H.matches.length;return of.default.createElement(XA,{height:1},of.default.createElement(E,null,n>0?"Loaded ":"No matches",n>0?of.default.createElement(E,{bold:!0},n):null,n>0?" tool"+(n===1?"":"s"):null))}`;
if (patched.includes(resultFnFind)) {
  patched = patched.replace(resultFnFind, resultFnReplace);
  patchCount++;
  output.modification('renderToolResultMessage',
    resultFnFind,
    resultFnReplace.slice(0, 60) + '...',
  );
} else {
  output.warning(`Could not find ${resultMessageFn} function body`);
}

if (patchCount === 0) {
  output.error('No patch points matched');
  process.exit(1);
}

if (dryRun) {
  output.result('dry_run', `${patchCount} patch point(s) found`);
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, patched);
  output.result('success', `Patched ${targetPath} (${patchCount} changes)`);
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

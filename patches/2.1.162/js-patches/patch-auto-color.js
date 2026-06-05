#!/usr/bin/env node
/**
 * Patch auto-color — give every plain session a stable random session color at
 * startup, so multiple concurrent sessions are visually distinguishable
 * without manually invoking `/color`.
 *
 * Why the obvious hook (the init path) does NOT work
 * ──────────────────────────────────────────────────
 * `/color` recolors the prompt banner by setting `standaloneAgentContext.color`
 * in app state. The tempting hook is the constructor that builds that context
 * on startup — but per CC's own source comment, `standaloneAgentContext` is
 * initialized in main.tsx via `initialState` for a cold launch and only flows
 * through the `computeStandaloneAgentContext` (UC$) helper on *resume/restore*.
 * A fresh `claude` launch never calls it, so patching UC$ is a no-op at cold
 * start. (Verified: an earlier UC$ build of this patch produced no color.)
 *
 * The reliable hook: the banner CONSUMER
 * ──────────────────────────────────────
 * `Mu8` (useSwarmBanner) is the single render path that turns the session color
 * into the visible banner. Its branch order is: teammate → swarm leader →
 * named/background agent → standalone (`/rename`/`/color`) → `--agent` flag →
 * `return null`. A genuinely plain session (no team, no agent, no manual color)
 * falls all the way through to the terminal `return null` — that's exactly the
 * case we want to colorize, and nothing else reaches it. So we replace that
 * `return null` with a banner carrying a random palette color.
 *
 * Anchor: the `--agent` fallback immediately preceding the terminal return:
 *
 *   if(q)return{text:q,bgColor:Ou8(j?.color,"promptBorder")};return null}
 *
 * captures the toThemeColor helper (`Ou8`) so the replacement adapts to
 * minifier renames. The palette array (`d3`) is captured separately from the
 * toThemeColor definition (anchored on its "cyan_FOR_SUBAGENTS_ONLY" default).
 *
 * The color is picked once and memoized on `globalThis.__autoColorBanner` so it
 * stays stable across the many re-renders of the banner hook (a fresh pick per
 * render would strobe). Empty banner text matches what `/color <name>` produces
 * for a session with no `/rename` name.
 *
 * In-memory only — not persisted to the session log. A resumed session that
 * never ran `/color` re-rolls a new color; one that did keeps its stored color
 * (that flows through the standalone branch above, which returns before this).
 *
 * Usage:
 *   node patch-auto-color.js <cli.js path>
 *   node patch-auto-color.js --check <cli.js path>
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-auto-color.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// ── Discovery: palette array via the toThemeColor helper ─────────────────
//
// function Ou8(H,$="cyan_FOR_SUBAGENTS_ONLY"){return H&&d3.includes(H)?g2[H]:$}
// The "cyan_FOR_SUBAGENTS_ONLY" default is a stable string anchor; capture the
// palette identifier (group 1).

const palettePattern = /function [$\w]+\([$\w]+,[$\w]+="cyan_FOR_SUBAGENTS_ONLY"\)\{return [$\w]+&&([$\w]+)\.includes\([$\w]+\)\?[$\w]+\[[$\w]+\]:[$\w]+\}/;
const paletteMatch = content.match(palettePattern);

if (!paletteMatch) {
  output.error('Could not find toThemeColor helper (palette array source)', [
    'Expected: function Ou8(H,$="cyan_FOR_SUBAGENTS_ONLY"){return H&&d3.includes(H)?g2[H]:$}',
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

const paletteVar = paletteMatch[1];
output.discovery('palette array', paletteVar);

// ── Patch: terminal return null of the banner hook (Mu8) ─────────────────
//
// if(q)return{text:q,bgColor:Ou8(j?.color,"promptBorder")};return null}
//   group1 = agent var (q), group2 = toThemeColor helper (Ou8)

const sitePattern = /(if\([$\w]+\)return\{text:[$\w]+,bgColor:([$\w]+)\([$\w]+\?\.color,"promptBorder"\)\};)return null\}/;
const siteMatch = content.match(sitePattern);

if (!siteMatch) {
  output.error('Could not find banner-hook terminal return (Mu8)', [
    'Expected: if(q)return{text:q,bgColor:Ou8(j?.color,"promptBorder")};return null}',
    'This might be an unsupported Claude Code version'
  ]);
  process.exit(1);
}

const agentFallback = siteMatch[1];
const toThemeColor = siteMatch[2];

output.discovery('toThemeColor helper', toThemeColor);
output.discovery('banner anchor', siteMatch[0].slice(0, 80) + '...');

const randomPick =
  `(globalThis.__autoColorBanner||` +
  `(globalThis.__autoColorBanner=${paletteVar}[Math.floor(Math.random()*${paletteVar}.length)]))`;

const siteOld = siteMatch[0];
const siteNew = `${agentFallback}return{text:"",bgColor:${toThemeColor}(${randomPick})}}`;

content = content.replace(siteOld, () => siteNew);

output.modification('Mu8: random color banner for plain sessions', siteOld, siteNew);

// ── Write ────────────────────────────────────────────────────────────────

if (dryRun) {
  output.result('dry_run', 'auto-color: 1/1 patches verified');
} else {
  fs.writeFileSync(targetPath, content, 'utf8');
  output.result('success', 'auto-color: 1/1 patches applied');
}

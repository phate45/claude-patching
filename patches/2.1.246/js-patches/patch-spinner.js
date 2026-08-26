#!/usr/bin/env node
/**
 * Patch to customize the Claude Code spinner animation (2.1.246)
 *
 * 2.1.246 rewrite: the old memoized closure
 *   VAR=MEMO(()=>{if(ghostty)return[...];return[...]},()=>process.env.TERM)
 * is gone. Frames are now built once at module init in `_285.js`:
 *   var R,g,l,m,A,b;
 *   ...=d(()=>{...R=["·",…],g=["·",…],l=["·",…],
 *              m=[...R,...R.toReversed()],A=[...g,...g.toReversed()],b=[...l,...l.toReversed()]});
 * with two pickers: M()/UD returns R (ghostty) / l (else) — a single-cycle set;
 * S()/VD returns m (ghostty) / b (else) — the mirrored set. The active thinking
 * spinner render (`as()`) imports S/VD, so it plays the mirror arrays m/b.
 *
 * This patch rewrites all six array literals at the init site to the custom
 * frames. In LOOP_MODE the arrays are the plain frames (forward cycle); in
 * mirror mode the base arrays are the frames and the m/A/b arrays are doubled
 * with `.toReversed()` (the native mirror behavior). The six var names are
 * captured (never hardcoded), and the frames are emitted as \uXXXX escapes so
 * no raw non-ASCII reaches the bundle.
 *
 * Usage:
 *   node patch-spinner.js <cli.js path>
 *   node patch-spinner.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../../lib/output');

// ============================================================
// CONFIGURATION - Edit this to customize your spinner
// ============================================================

const SPINNER_CHARS = ["·","·","✧","✦","✧","·"];

// Animation mode:
//   true  = loop (default): cycles forward continuously
//   false = mirror: cycles forward then backward
const LOOP_MODE = true;

// ============================================================
// PATCH IMPLEMENTATION
// ============================================================

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-spinner.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Emit each frame char as ASCII: \uXXXX for anything > U+007F (bundle encoding
// invariant — raw UTF-8 renders as mojibake and fails the apply check).
const escChar = (c) => {
  const n = c.codePointAt(0);
  return n > 127 ? '\\u' + n.toString(16).padStart(4, '0') : c;
};
const FRAMES = '[' + SPINNER_CHARS.map(c => '"' + [...c].map(escChar).join('') + '"').join(',') + ']';

// Match the module-init frame assignment:
//   R=[...],g=[...],l=[...],m=[...R,...R.toReversed()],A=[...g,...g.toReversed()],b=[...l,...l.toReversed()]
// Captures: 1=R(base1) 2=g(base2) 3=l(base3) 4=m(mirror1) 5=A(mirror2) 6=b(mirror3)
const pattern = new RegExp(
  '([$\\w]+)=\\[[^\\]]*\\],' +
  '([$\\w]+)=\\[[^\\]]*\\],' +
  '([$\\w]+)=\\[[^\\]]*\\],' +
  '([$\\w]+)=\\[\\.\\.\\.\\1,\\.\\.\\.\\1\\.toReversed\\(\\)\\],' +
  '([$\\w]+)=\\[\\.\\.\\.\\2,\\.\\.\\.\\2\\.toReversed\\(\\)\\],' +
  '([$\\w]+)=\\[\\.\\.\\.\\3,\\.\\.\\.\\3\\.toReversed\\(\\)\\]'
);

const match = content.match(pattern);

if (!match) {
  output.error('Could not find spinner frame init pattern', [
    'Expected: R=[…],g=[…],l=[…],m=[...R,...R.toReversed()],A=[...g,...],b=[...l,...]',
    'This might be an unsupported Claude Code version',
  ]);
  process.exit(1);
}

const [, R, g, l, m, A, b] = match;

output.discovery('spinner frame init', match[0].slice(0, 70) + '…', {
  'base arrays': `${R}, ${g}, ${l}`,
  'mirror arrays': `${m}, ${A}, ${b}`,
  'mode': LOOP_MODE ? 'loop' : 'mirror',
});

let replacement;
if (LOOP_MODE) {
  // Plain forward cycle — every set is the frames as-is.
  replacement =
    `${R}=${FRAMES},${g}=${FRAMES},${l}=${FRAMES},` +
    `${m}=${FRAMES},${A}=${FRAMES},${b}=${FRAMES}`;
} else {
  // Mirror — base = frames, mirror sets doubled with toReversed (native shape).
  replacement =
    `${R}=${FRAMES},${g}=${FRAMES},${l}=${FRAMES},` +
    `${m}=[...${R},...${R}.toReversed()],` +
    `${A}=[...${g},...${g}.toReversed()],` +
    `${b}=[...${l},...${l}.toReversed()]`;
}

output.modification('spinner frames',
  match[0].slice(0, 60) + '…',
  replacement.slice(0, 60) + '…');

if (dryRun) {
  output.result('dry_run', `Spinner frame init found — ready to patch (${LOOP_MODE ? 'loop' : 'mirror'} mode)`);
  process.exit(0);
}

const patched = content.replace(match[0], () => replacement);

try {
  fs.writeFileSync(targetPath, patched);
  output.result('success', `Patched spinner frames in ${targetPath}`);
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

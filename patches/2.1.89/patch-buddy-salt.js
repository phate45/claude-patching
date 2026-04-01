#!/usr/bin/env node
/**
 * Patch to replace the companion buddy salt with a custom value
 *
 * The /buddy companion system uses a deterministic PRNG seeded from
 * hash(userId + salt) to roll species, rarity, eyes, hat, and stats.
 * By replacing the salt, a specific companion configuration can be
 * selected without modifying the rolling logic.
 *
 * The salt is read from CLAUDE_BUDDY_CUSTOM_SALT at patch time.
 * If the env var is not set, this patch exits gracefully (no-op).
 *
 * Use the buddy-reroll tool (/tmp/buddy-reroll) to brute-force a
 * salt for a desired companion, then pass it via the env var.
 *
 * Usage:
 *   CLAUDE_BUDDY_CUSTOM_SALT="xxxxxxxxxxx1234" node patch-buddy-salt.js <cli.js path>
 *   node patch-buddy-salt.js --check <cli.js path>  (dry run)
 */

const fs = require('fs');
const output = require('../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-buddy-salt.js [--check] <cli.js path>');
  process.exit(1);
}

const ORIGINAL_SALT = 'friend-2026-401';
const customSalt = process.env.CLAUDE_BUDDY_CUSTOM_SALT;

if (!customSalt) {
  output.info('CLAUDE_BUDDY_CUSTOM_SALT not set — skipping buddy salt patch');
  output.result('skipped', 'No custom salt provided');
  process.exit(0);
}

if (customSalt.length !== ORIGINAL_SALT.length) {
  output.error(`Custom salt must be exactly ${ORIGINAL_SALT.length} characters`, [
    `Got ${customSalt.length}: "${customSalt}"`,
    'Salt length must match for safe binary replacement'
  ]);
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

// Find all occurrences of the original salt (or a previously patched salt
// of the same length). The salt appears as a string literal in the JS.
const pattern = new RegExp(ORIGINAL_SALT.replace(/[-]/g, '\\$&'), 'g');
const matches = [...content.matchAll(pattern)];

if (matches.length === 0) {
  output.error('Could not find buddy salt in target', [
    `Expected: "${ORIGINAL_SALT}"`,
    'The salt may have already been replaced with a different value'
  ]);
  process.exit(1);
}

output.discovery('buddy salt', `${matches.length} occurrence(s)`, {
  original: ORIGINAL_SALT,
  replacement: customSalt
});

if (dryRun) {
  output.result('dry_run', `Buddy salt found (${matches.length} occurrences) — ready to replace with custom salt`);
  process.exit(0);
}

content = content.replace(pattern, customSalt);

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Replaced buddy salt in ${matches.length} location(s)`);
  output.info(`New salt: ${customSalt}`);
  output.info('Clear companion data from config and run /buddy to hatch with new roll.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Trim noise from the "# Environment" preamble block (2.1.177)
 *
 * 2.1.280 fork adds Patch 4: the static env section builder (xVn) now has only
 * three bullets — the model-family paragraph, the IDE line, and the fast-mode
 * line. trim-context-bloat nulls the first, Patch 2 here drops the second, and
 * the fast-mode-info prompt patch nulls the third, so the builder returned a
 * bare "# Environment" heading with nothing under it (the live env details
 * moved to a separate attachment). Patch 4 makes the builder return null when
 * its bullet list is empty; the section assembler already filters nulls.
 * Anchored on the variable holding "# Environment" so the sibling
 * "# Environment update" join (same shape) is never touched. Only identifiers
 * already present at the site are reused.
 *
 * Forked from patches/2.1.162/js-patches/patch-env-block-trim.js — same two
 * removals, plus a third cut that rewords (rather than drops) a line:
 *
 *   1. `Platform: ${h$.platform}`  — shadowed by the adjacent `OS Version` line
 *      (e.g. "Platform: linux" vs "OS Version: Linux 6.19...-arch1-1"). Pure dup.
 *
 *   2. t5q()  — the "Shell: <$SHELL>" line. It reports the user's *login* shell,
 *      but the Bash tool never runs it: the persistent-shell selector (ab5())
 *      only ever resolves bash/zsh, falling back to a PATH scan when $SHELL is
 *      something exotic (fish, nu, ...). So a fish login shell yields
 *      "Shell: /usr/bin/fish" while the tool actually executes bash — and the
 *      model dutifully writes fish syntax that the executor rejects. The line is
 *      actively wrong, not just noisy. Bash tool is Bash, period.
 *
 *   3. "Claude Code is available as a CLI ... IDE extensions (VS Code, JetBrains)."
 *      — static marketing filler the model never needs.
 *
 *   4. "Assistant knowledge cutoff is ${X}." → "Your knowledge cutoff is ${X}."
 *      A tonal seam: every neighbouring env bullet is second-person ("You have
 *      been invoked...", "You are powered by the model ${X}."), then a lone
 *      third-person "Assistant knowledge cutoff" line. Swap "Assistant" → "Your"
 *      for voice coherence. Three sites — the full builder, the model-info
 *      builder, and the "Here is useful information" context builder (the last
 *      opens its template with leading newlines, so the phrase is matched on its
 *      trailing `${` token rather than a leading backtick).
 *
 * Sites:
 *   - Platform + shell: the comma-joined fragment `Platform: ${VAR.platform}`,FN(),
 *     immediately precedes the `OS Version` element. Appears in the full builder
 *     and the slim builder (2 sites, byte-identical).
 *   - IDE line: appears in the full builder and the model-info builder (2 sites).
 *     In both it is followed by `,$?null:<fast mode>`, so we drop the string plus
 *     its trailing comma and the fast-mode element stays attached.
 *   - Cutoff reword: 3 sites (see above).
 *
 * Removal replacements are empty strings — no minified identifiers are emitted,
 * so there is nothing to capture-and-reuse (the leading element separators are
 * preserved by construction). The cutoff reword preserves the `${X}` token via
 * a backreference, so no identifier is hardcoded.
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  console.error('Usage: node patch-env-block-trim.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  console.error(`Failed to read ${targetPath}:`, err.message);
  process.exit(1);
}

let patchedContent = content;
let patchCount = 0;
const missed = [];

// ============================================================
// PATCH 1: Drop Platform + Shell lines
// ============================================================
// Matches `Platform: ${h$.platform}`,t5q(), leaving the following
// `OS Version: ...` element attached to its preceding separator comma.

output.section('Platform + Shell lines', { index: 1 });
{
  // 2.1.260: both lines became formatted template fragments —
  //   `Platform: ${r(e.platform)}`,`Shell: ${r(e.shell)}`,
  // (was `Platform: ${VAR.platform}`,t5q(),). Drop both, leaving the
  // following `OS Version` element attached to its preceding separator comma.
  const platformShellPattern = /`Platform: \$\{([$\w]+)\(([$\w.]+)\)\}`,`Shell: \$\{[$\w]+\([$\w.]+\)\}`,/g;
  const matches = [...patchedContent.matchAll(platformShellPattern)];

  if (matches.length > 0) {
    output.discovery('platform/shell fragment', `${matches.length} site(s)`, {
      'formatter fn': matches[0][1],
      'platform arg': matches[0][2],
      'Sites': matches.length
    });
    output.modification('env block', 'Platform: ${...}, Shell: ${$SHELL}', '(removed — OS Version covers platform; Bash tool always runs bash/zsh)');

    patchedContent = patchedContent.replace(platformShellPattern, '');
    patchCount += matches.length;
  } else {
    output.warning('Could not find Platform + Shell fragment', [
      'May already be patched or pattern changed'
    ]);
    missed.push('platform-shell');
  }
}

// ============================================================
// PATCH 2: Drop IDE-integration filler line
// ============================================================
// Removes the string element plus its trailing comma. In both builders the
// element is followed by `,$?null:<fast mode>`, so the fast-mode element
// re-binds to the preceding separator cleanly.

output.section('IDE integration line', { index: 2 });
{
  const ideLinePattern = /"Claude Code is available as a CLI in the terminal, desktop app \(Mac\/Windows\), web app \(claude\.ai\/code\), and IDE extensions \(VS Code, JetBrains\)\.",/g;
  const matches = [...patchedContent.matchAll(ideLinePattern)];

  if (matches.length > 0) {
    output.discovery('IDE filler line', `${matches.length} site(s)`, {
      'Sites': matches.length
    });
    output.modification('env block', 'Claude Code is available as a CLI ... (VS Code, JetBrains).', '(removed — static filler)');

    patchedContent = patchedContent.replace(ideLinePattern, '');
    patchCount += matches.length;
  } else {
    output.warning('Could not find IDE integration line', [
      'May already be patched or pattern changed'
    ]);
    missed.push('ide-line');
  }
}

// ============================================================
// PATCH 3: Reword "Assistant knowledge cutoff" → "Your knowledge cutoff"
// ============================================================
// Voice coherence with the surrounding second-person env bullets. Matches the
// phrase plus its trailing `${...}` template token (captured + reused), so all
// three builder sites are caught regardless of how each opens its template.

output.section('Assistant → Your cutoff reword', { index: 3 });
{
  // 2.1.260: the token became a member expression — ${e.knowledgeCutoff}
  // (was a bare ${VAR}); allow a dot in the captured token.
  const cutoffPattern = /Assistant knowledge cutoff is (\$\{[$\w.]+\}\.)/g;
  const matches = [...patchedContent.matchAll(cutoffPattern)];

  if (matches.length > 0) {
    output.discovery('cutoff line', `${matches.length} site(s)`, {
      'Sites': matches.length
    });
    output.modification('env block', 'Assistant knowledge cutoff is ${X}.', 'Your knowledge cutoff is ${X}.');

    patchedContent = patchedContent.replace(cutoffPattern, 'Your knowledge cutoff is $1');
    patchCount += matches.length;
  } else {
    output.warning('Could not find Assistant knowledge cutoff line', [
      'May already be patched or pattern changed'
    ]);
    missed.push('cutoff-line');
  }
}

// ============================================================
// PATCH 4: Null the section when every bullet was trimmed
// ============================================================
// Form (2.1.280):
//   ].filter((r)=>r!==null);return[Dde,...ap(n)].join(`\n`)}
// where Dde is `var Dde="# Environment"`. Becomes
//   return n.length?[Dde,...ap(n)].join(`\n`):null

output.section('Empty section guard', { index: 4 });
{
  const headingVar = patchedContent.match(/var ([$\w]+)="# Environment",/);
  const joinPattern = headingVar && new RegExp(
    'return\\[(' + headingVar[1].replace(/\$/g, '\\$') + '),\\.\\.\\.([$\\w]+)\\(([$\\w]+)\\)\\]\\.join\\(`\\n`\\)',
    'g'
  );
  const matches = joinPattern ? [...patchedContent.matchAll(joinPattern)] : [];

  if (matches.length === 1) {
    const [site, heading, bulletFn, list] = matches[0];
    output.discovery('env section join', site, {
      'heading var': heading,
      'bullet fn': bulletFn,
      'list var': list
    });
    const guarded = `return ${list}.length?[${heading},...${bulletFn}(${list})].join(\`\\n\`):null`;
    output.modification('env section', site, guarded);

    patchedContent = patchedContent.replace(joinPattern, () => guarded);
    patchCount++;
  } else {
    output.warning('Could not find a unique "# Environment" section join', [
      headingVar ? `heading var ${headingVar[1]}, ${matches.length} join site(s)` : 'heading var not found',
      'May already be patched or pattern changed'
    ]);
    missed.push('empty-section-guard');
  }
}

// ============================================================
// Apply changes
// ============================================================

if (missed.length > 0) {
  output.result('failure', `Could not find pattern(s) for: ${missed.join(', ')}`);
  process.exit(1);
}

if (patchCount === 0) {
  output.result('failure', 'No patches applied');
  process.exit(1);
}

if (dryRun) {
  output.result('dry_run', `${patchCount} edit(s) would be applied`);
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, patchedContent);
  output.result('success', `Applied ${patchCount} edit(s) to ${targetPath}`);
  output.info('Restart Claude Code to apply changes.');
} catch (err) {
  output.error(`Failed to write patched file: ${err.message}`);
  process.exit(1);
}

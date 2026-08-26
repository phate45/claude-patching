#!/usr/bin/env node
/**
 * Patch: make the teammate / agent-swarm feature invisible unless the Workflow
 * tool is enabled. With workflows off, `name` degrades to a plain named,
 * resumable subagent and NO teammate vocabulary reaches the model's context.
 *
 * Background
 * ----------
 * The Agent tool has two dispatch paths (call() at ~513047 in the .pretty):
 *
 *   let S = Vc() ? g.teamContext : void 0, A = !!l.teammateContext;
 *   ...
 *   if (S && i && !M && !s && !a) { ...teammate spawn (Y0p)... }   // i = `name`
 *
 * `Vc()` @346359 is the swarm gate: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS (or
 * --agent-teams) plus the tengu_amber_flint flag. When it's on, ANY Agent call
 * carrying a `name` is routed to the full teammate machinery: a persistent
 * agent that never returns a tool result, parks in a mailbox poll loop, and
 * reports completion as an `idle_notification` JSON frame delivered to
 * "team-lead" via the InboxPoller (1s tick).
 *
 * That machinery exists to be driven by the Workflow tool. Without it, spawning
 * a "teammate" for ordinary delegation is pure overhead: no tool result, a
 * noisier reporting path, and coordination cost for one-and-done work.
 *
 * The nuisance case: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is commonly set in a
 * committed project-level settings `env` block, so `Vc()` is on for everyone on
 * the repo whether or not they run workflows, and there is no per-user opt-out
 * short of editing shared config.
 *
 * What we keep is the other thing `name` buys you: the normal subagent path
 * registers the name too (`registerName` ~513494), so a named agent stays
 * addressable via SendMessage({to: name}) and resumes with full context through
 * JTe(). It returns a real tool result and reports through the ordinary
 * task-notification queue.
 *
 * The predicate
 * -------------
 * `gx()` @115565 is CC's own Workflow-tool gate — literally the tool
 * definition's `isEnabled`. Zero-arg, synchronous, memoised; it folds together
 * the `disableWorkflows` setting, CLAUDE_CODE_DISABLE_WORKFLOWS, the
 * allow_workflows org policy, the tengu_workflows_enabled flag and the
 * plan-derived default. Keying off it means teammates are available exactly
 * when the thing that drives them is available — no new knob to learn.
 *
 * Why NOT patch Vc() itself
 * -------------------------
 * Tempting — one switch for every teammate surface — but fatal: `Fpb` (~498212)
 * maps the Agent tool to ["name","team_name","mode"] and `Upb`/`Bpb` DELETE
 * those properties from the published input schema when `!Vc()`. Neutering Vc()
 * would remove the `name` parameter, the very capability being preserved. So
 * Vc() stays true and we cut at the individual surfaces instead.
 *
 * Patch points
 * ------------
 *  1. Capture the Workflow predicate name, anchored on the unique
 *     `aliases:["RunWorkflow"]` literal (never hardcode `gx`).
 *  2. Capture the SendMessage description builder + its flag parameter.
 *  3. Dispatch:  S=Vc()?g.teamContext:void 0  ->  S=Vc()&&gx()?...
 *  4. Agent `name` param description: lead with reuse/resume, which is what it
 *     means on the fallback path (and is true in teammate mode too, so no gate).
 *  5. Schema strip call site:  if(!Vc())  ->  if(!Vc()||!gx())
 *  6. Schema strip list for the Agent tool: drop "name" so only the two inert
 *     "Deprecated; ignored" params (team_name, mode) are removed. ExitPlanMode's
 *     ["launchSwarm","teammateCount"] entry rides the widened condition for free.
 *  7. SendMessage prompt: $Hp(Vc()) -> $Hp(Vc()&&gx()), which drops the whole
 *     "Protocol responses (legacy)" block (team-lead, shutdown/plan-approval).
 *  8. SendMessage body: the `to` table row, gated on the same flag param.
 *  9. SendMessage body: the "Messages from teammates" sentence, likewise.
 * 10. SendMessage searchHint: drop "teammates" (static; accurate either way).
 * 11. SendMessage `to` param description: "teammate name" -> "agent name".
 *
 * Points 8/9 reuse $Hp's own flag parameter, which point 7 has already narrowed
 * to Vc()&&gx() — so the prose follows the gate automatically.
 *
 * Usage:
 *   node patch-teammate-workflow-gate.js <cli.js path>
 *   node patch-teammate-workflow-gate.js --check <cli.js path>  (dry run)
 *
 *   # to get the teammate machinery back, enable workflows:
 *   #   settings.json: "disableWorkflows": false   (or drop the key)
 */

const fs = require('fs');
const output = require('../../../lib/output');

const args = process.argv.slice(2);
const dryRun = args[0] === '--check';
const targetPath = dryRun ? args[1] : args[0];

if (!targetPath) {
  output.error('Usage: node patch-teammate-workflow-gate.js [--check] <cli.js path>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(targetPath, 'utf8');
} catch (err) {
  output.error(`Failed to read ${targetPath}`, [err.message]);
  process.exit(1);
}

let patchCount = 0;

/** Exact, single-occurrence string replacement with a house-style failure. */
function replaceExact(label, oldStr, newStr, hints) {
  const first = content.indexOf(oldStr);
  if (first === -1) {
    output.error(`Could not find ${label}`, [`Expected: ${oldStr.slice(0, 160)}`, ...(hints || [])]);
    process.exit(1);
  }
  if (content.indexOf(oldStr, first + oldStr.length) !== -1) {
    output.error(`Ambiguous match for ${label}`, ['Expected exactly one occurrence, found more than one']);
    process.exit(1);
  }
  output.modification(label, oldStr.slice(0, 70), newStr.slice(0, 70));
  content = content.slice(0, first) + newStr + content.slice(first + oldStr.length);
  patchCount++;
}

// ── Patch Point 1: capture the Workflow-enabled predicate ──
//
//   ms({name:BI,aliases:["RunWorkflow"],...,isEnabled:()=>gx(),...})
// `isEnabled` is the tool's own gate, so whatever it calls is by definition the
// answer to "is the Workflow tool enabled".

const workflowPredicateMatch = content.match(/aliases:\["RunWorkflow"\][^}]*?isEnabled:\(\)=>([$\w]+)\(\)/);

if (!workflowPredicateMatch) {
  output.error('Could not find the Workflow tool isEnabled predicate', [
    'Expected: aliases:["RunWorkflow"],...,isEnabled:()=>FN()',
    'The Workflow tool definition may have been restructured or removed'
  ]);
  process.exit(1);
}

const workflowFn = workflowPredicateMatch[1];
output.discovery('Workflow enabled predicate', `${workflowFn}()`, { 'anchor': 'aliases:["RunWorkflow"]' });

// ── Patch Point 2: capture the SendMessage description builder ──
//
// Since 2.1.246 the builder's body grew a large cross-session preamble (worker
// discovery, idle subscriptions) BEFORE the `return\`\n# SendMessage\n\`` line,
// so the old tight `function FN(FLAG){return...` regex no longer matches.
// Anchor on the unique `return\`\n# SendMessage\n` literal instead, then walk
// back to the nearest enclosing `function NAME(PARAM){` to recover the fn name
// + flag param (still captured, never hardcoded).

const sendMsgReturnAnchor = content.indexOf('return`\n# SendMessage\n');

if (sendMsgReturnAnchor === -1) {
  output.error('Could not find the SendMessage description builder', [
    'Expected: return`\\n# SendMessage\\n...',
    'The SendMessage prompt may have been restructured'
  ]);
  process.exit(1);
}

const funcDeclRegex = /function ([$\w]+)\(([$\w]+)\)\{/g;
let funcDeclMatch, sendMsgBuilderMatch = null;
while ((funcDeclMatch = funcDeclRegex.exec(content)) !== null) {
  if (funcDeclMatch.index > sendMsgReturnAnchor) break;
  sendMsgBuilderMatch = funcDeclMatch;
}

if (!sendMsgBuilderMatch) {
  output.error('Could not find the enclosing function for the SendMessage description builder', [
    'Expected: function FN(FLAG){ ... return`\\n# SendMessage\\n...',
    'The SendMessage prompt builder may have been restructured'
  ]);
  process.exit(1);
}

const sendMsgFn = sendMsgBuilderMatch[1];   // e.g. swr
const sendMsgFlag = sendMsgBuilderMatch[2]; // e.g. e

output.discovery('SendMessage description builder', `${sendMsgFn}(${sendMsgFlag})`, {
  'flag param': sendMsgFlag
});

// ── Patch Point 3: gate the teammate dispatch ──
//
//   S=Vc()?g.teamContext:void 0  ->  S=Vc()&&gx()?g.teamContext:void 0
// Unique in the bundle. `S` feeds nothing but the teammate branch condition.

const teamContextMatch = content.match(/([$\w]+)=([$\w]+)\(\)\?([$\w]+)\.teamContext:void 0/);

if (!teamContextMatch) {
  output.error('Could not find the teamContext dispatch ternary', [
    'Expected: VAR=SWARMGATE()?STATE.teamContext:void 0',
    'The Agent tool teammate branch may have been restructured'
  ]);
  process.exit(1);
}

const [teamCtxFull, teamVar, swarmGateFn, stateVar] = teamContextMatch;

output.discovery('teammate dispatch gate', teamCtxFull, {
  'team context var': teamVar,
  'swarm gate': `${swarmGateFn}()`,
  'app state var': stateVar
});

replaceExact('teammate dispatch gate',
  teamCtxFull,
  `${teamVar}=${swarmGateFn}()&&${workflowFn}()?${stateVar}.teamContext:void 0`);

// ── Patch Point 4: reframe the Agent `name` parameter description ──
//
// Stock copy sells `name` as a live-addressing handle. Its real value is
// resume/reuse. ASCII only (bundle encoding invariant, lib/shared.js).

replaceExact('Agent name param description',
  'Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running.',
  'Name for the spawned agent. Give it a name if you might want to reuse or resume it later: SendMessage({to: name}) then targets it, resuming it with its full context. Omit it for one-and-done work.',
  ['The Agent tool input schema copy may have changed']);

// ── Patch Point 5: widen the schema-strip condition ──
//
//   if(!Vc())f=Upb(e.name,f)  ->  if(!Vc()||!gx())f=Upb(e.name,f)
// Captured rather than hardcoded so a rename of the strip helper is tolerated.

const stripCallMatch = content.match(/if\(!([$\w]+)\(\)\)([$\w]+)=([$\w]+)\(([$\w]+)\.name,\4?[$\w]*\)/);

if (!stripCallMatch) {
  output.error('Could not find the tool-schema property strip call site', [
    'Expected: if(!SWARMGATE())SCHEMA=STRIPFN(TOOL.name,SCHEMA)',
    'The tool-schema publishing path may have changed'
  ]);
  process.exit(1);
}

output.discovery('schema strip call site', stripCallMatch[0], {
  'strip helper': `${stripCallMatch[3]}()`
});

replaceExact('schema strip condition',
  stripCallMatch[0],
  stripCallMatch[0].replace(
    `if(!${stripCallMatch[1]}())`,
    `if(!${stripCallMatch[1]}()||!${workflowFn}())`));

// ── Patch Point 6: keep `name` out of the strip list ──
//
//   Fpb = new Map([[LO,["launchSwarm","teammateCount"]],[ri,["name","team_name","mode"]]])
// Drop "name" so the widened condition removes only the two inert
// "Deprecated; ignored" params. Anchored on the literal list, tool var captured.

const stripListMatch = content.match(/\[([$\w]+),\["name","team_name","mode"\]\]/);

if (!stripListMatch) {
  output.error('Could not find the Agent tool schema-strip property list', [
    'Expected: [AGENTTOOL,["name","team_name","mode"]]',
    'The per-tool strip map (Fpb) may have changed shape'
  ]);
  process.exit(1);
}

output.discovery('Agent strip list', stripListMatch[0], { 'agent tool var': stripListMatch[1] });

replaceExact('Agent strip list',
  stripListMatch[0],
  `[${stripListMatch[1]},["team_name","mode"]]`);

// ── Patch Point 7: gate the SendMessage prompt's teams flag ──
//
//   async prompt(){return $Hp(Vc())}  ->  async prompt(){return $Hp(Vc()&&gx())}
// Drops the entire "Protocol responses (legacy)" section (team-lead, shutdown
// and plan-approval frames) and arms points 8/9.

replaceExact('SendMessage prompt flag',
  `return ${sendMsgFn}(${swarmGateFn}())`,
  `return ${sendMsgFn}(${swarmGateFn}()&&${workflowFn}())`,
  ['Expected the SendMessage prompt() to pass the swarm gate straight through']);

// ── Patch Point 8: the `to` table row ──

replaceExact('SendMessage to-table row',
  '| Teammate by name |',
  `| \${${sendMsgFlag}?"Teammate by name":"Named agent"} |`,
  ['The SendMessage recipient table may have changed shape']);

// ── Patch Point 9: the "Messages from teammates" sentence ──

replaceExact('SendMessage inbox sentence',
  "Messages from teammates are delivered automatically; you don't check an inbox. ",
  `\${${sendMsgFlag}?"Messages from teammates are delivered automatically; you don't check an inbox. ":"Replies arrive automatically; you don't check an inbox. "}`,
  ['The SendMessage body copy may have changed']);

// ── Patch Point 10: searchHint (the deferred-tool one-liner) ──
//
// Static rewording: accurate whether or not teammates are active.

replaceExact('SendMessage searchHint',
  'searchHint:"send messages to agent teammates"',
  'searchHint:"send messages to other agents"');

// ── Patch Point 11: the `to` parameter description ──
//
// Since 2.1.246 this description lives inside a ternary keyed on the
// (unrelated) cross-session flag: `e?"...cross-session copy...":"Recipient:
// teammate name"`. Only the plain-teammate fallback branch needs the reword;
// match the quoted string alone (still unique) rather than the old bare
// `.describe(...)` call.

replaceExact('SendMessage to param description',
  '"Recipient: teammate name"',
  '"Recipient: agent name"');

// ── Patch Point 12: TaskCreate description ──
//
//   function Ckp(){let e=Vc()?" and potentially assigned to teammates":"",t=Vc()?...
// Both strings are already Vc()-gated; widen the gate on the pair. The tool var
// names are captured so only the two gate calls are rewritten.

const taskCreateMatch = content.match(
  /(function [$\w]+\(\)\{let ([$\w]+)=)([$\w]+)\(\)(\?" and potentially assigned to teammates":"",([$\w]+)=)\3\(\)(\?)/);

if (!taskCreateMatch) {
  output.error('Could not find the TaskCreate teammate description gates', [
    'Expected: function FN(){let A=SWARMGATE()?" and potentially assigned to teammates":"",B=SWARMGATE()?...',
    'The TaskCreate prompt builder may have changed'
  ]);
  process.exit(1);
}

const taskCreateGate = taskCreateMatch[3];

output.discovery('TaskCreate teammate gates', taskCreateMatch[0].slice(0, 90), {
  'gate': `${taskCreateGate}()`
});

replaceExact('TaskCreate teammate gates',
  taskCreateMatch[0],
  `${taskCreateMatch[1]}(${taskCreateGate}()&&${workflowFn}())${taskCreateMatch[4]}(${taskCreateGate}()&&${workflowFn}())${taskCreateMatch[6]}`);

// ── Patch Point 13: TaskStop task_id description ──
//
// Unconditional teammate vocabulary in a published input schema. The named
// background agent half is the part that still applies once teammates are
// gated off, so keep that and drop the agent-team clause. Static: harmless
// wording in teammate mode too, since teammates are named background agents.

replaceExact('TaskStop task_id description',
  'The ID of the background task to stop. Agent-team teammates and named background agents are also accepted by agent ID or name.',
  'The ID of the background task to stop. Named background agents are also accepted by agent ID or name.');

// ── Patch Point 14: TaskList description — "Before assigning tasks to teammates" ──

const taskListLeadMatch = content.match(
  /(function ([$\w]+)\(\)\{let ([$\w]+)=)([$\w]+)\(\)(\?`- Before assigning tasks to teammates)/);

if (!taskListLeadMatch) {
  output.error('Could not find the TaskList teammate lead-in gate', [
    'Expected: function FN(){let A=SWARMGATE()?`- Before assigning tasks to teammates...',
    'The TaskList prompt builder may have changed'
  ]);
  process.exit(1);
}

output.discovery('TaskList teammate gates', taskListLeadMatch[0].slice(0, 80), {
  'gate': `${taskListLeadMatch[4]}()`
});

replaceExact('TaskList lead-in gate',
  taskListLeadMatch[0],
  `${taskListLeadMatch[1]}(${taskListLeadMatch[4]}()&&${workflowFn}())${taskListLeadMatch[5]}`);

// ── Patch Point 15: TaskList "## Teammate Workflow" section ──
//
// A whole gated section instructing the model how to behave as a teammate
// (claim pending tasks in ID order, notify the team lead when blocked...).

const taskListSectionMatch = content.match(/([$\w]+)=([$\w]+)\(\)(\?`\n## Teammate Workflow)/);

if (!taskListSectionMatch) {
  output.error('Could not find the TaskList Teammate Workflow section gate', [
    'Expected: VAR=SWARMGATE()?`\\n## Teammate Workflow...',
    'The TaskList prompt builder may have changed'
  ]);
  process.exit(1);
}

replaceExact('TaskList Teammate Workflow gate',
  taskListSectionMatch[0],
  `${taskListSectionMatch[1]}=(${taskListSectionMatch[2]}()&&${workflowFn}())${taskListSectionMatch[3]}`);

// ── Patch Point 16: TaskStop description bullet ──
//
// B1u is a plain `var X = \`...\`` const, not a builder function, so it is
// evaluated at module-init time — too early to call gx() safely (settings may
// not be loaded, and the value would freeze). Delete the bullet outright
// instead. Nothing is lost on the fallback path: the very next bullet already
// covers "a background agent spawned with a name". Teammate mode loses only
// the note about the "name@team" ID form.

// ORDER DEPENDENCY: prompt-slim's `killshell` patch runs earlier in the index
// and replaces TaskStop's WHOLE description block with a one-liner, taking this
// bullet with it. So the bullet may legitimately be gone already. Rather than
// hardcode "either literal", assert the invariant we actually care about: the
// phrase must not survive anywhere in the bundle.

const TASKSTOP_BULLET =
  '\n- To stop an agent-team teammate, pass its agent ID ("name@team") or bare teammate name as task_id';

if (content.includes(TASKSTOP_BULLET)) {
  replaceExact('TaskStop teammate bullet', TASKSTOP_BULLET, '');
} else if (!content.includes('agent-team teammate')) {
  output.discovery('TaskStop teammate bullet', 'already absent', {
    'reason': 'removed upstream in this run (prompt-slim killshell slims the whole TaskStop description)'
  });
} else {
  output.error('Could not find TaskStop teammate bullet', [
    `Expected: ${TASKSTOP_BULLET.trim()}`,
    'The phrase "agent-team teammate" is still in the bundle but not in the expected bullet form',
    'The TaskStop description bullets may have changed'
  ]);
  process.exit(1);
}

// ── Patch Point 17: /skillify execution-mode list ──
//
// kVv() IS a builder function, so a runtime gate is safe here. Offering a
// `Teammate` execution mode in a generated skill spec is wrong when teammates
// cannot be spawned at all.

replaceExact('skillify Teammate execution mode',
  '\\`Task agent\\` (straightforward subagents), \\`Teammate\\` (agent with true parallelism and inter-agent communication), or \\`[human]\\`',
  `\\\`Task agent\\\` (straightforward subagents), \${${workflowFn}()?"\\\`Teammate\\\` (agent with true parallelism and inter-agent communication), ":""}or \\\`[human]\\\``,
  ['The skillify step-annotation copy may have changed']);

// ── Write result ──

if (dryRun) {
  output.result('dry_run', `All ${patchCount} patch points found`);
  process.exit(0);
}

try {
  fs.writeFileSync(targetPath, content);
  output.result('success', `Applied ${patchCount} modifications to ${targetPath}`);
  output.info(`Teammate surfaces now require the Workflow tool (${workflowFn}()); otherwise \`name\` yields a resumable named subagent and no teammate vocabulary reaches the prompt.`);
  output.info('Restart Claude Code to apply the change.');
} catch (err) {
  output.error('Failed to write patched file', [err.message]);
  process.exit(1);
}

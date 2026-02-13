# Patch: Suppress Duplicate Background Agent Notifications

## Context

When a background agent (Task tool with `run_in_background: true`) completes, a notification is enqueued via `uq1()` BEFORE `TaskOutput` can read the output (due to 100ms polling in `fkY()`). When the model calls `TaskOutput` to read the agent's output during its turn, the notification has already been queued. After the turn ends, the notification is processed and creates a duplicate of the content already in context.

**Goal:** Suppress the post-turn notification when `TaskOutput` has already successfully retrieved the completed task's output.

## Architecture

Two notification consumption paths exist:
1. **`hD1` queue** (interactive mode) — consumed by a React `useEffect` that calls `executeQueuedInput`
2. **`queuedCommands`** (fallback) — consumed by the main streaming loop's `g$6()` dequeue

Both must be handled. A third path (`sn4()`) fires only during conversation compaction and is not a duplicate concern.

## Approach: `globalThis`-based suppression

Since `TaskOutput` and the notification consumers are in separate module scopes, use `globalThis.__taskOutputRead` (a `Set` of task IDs) as a synchronous cross-scope communication channel.

### Patch Point 1: TaskOutput — flag when output is read

**File:** `cli.js` (bare)
**Location:** `TaskOutput.call()` — two success return paths (non-blocking and blocking)

After the existing `Q5(...)` that sets `notified:!0`, insert code to add the task_id to the globalThis Set.

**Minified pattern (2 matches via `/g`):**
```
Q5(TASKID,STATE.setAppState,(VAR)=>({...VAR,notified:!0})),{data:{retrieval_status:"success",task:FN(VAR)}}
```

**Regex:**
```javascript
/([$\w]+)\(([$\w]+),([$\w]+)\.setAppState,\(([$\w]+)\)=>\(\{\.\.\.\4,notified:!0\}\)\),((\{data:\{retrieval_status:"success",task:[$\w]+\([$\w]+\)\}))/g
```

**Injection:** After the `Q5(...)` call (before the comma to `{data:...}`), chain the Set add:
```
$1($2,$3.setAppState,($4)=>({...$4,notified:!0})),(globalThis.__taskOutputRead=globalThis.__taskOutputRead||new Set).add($2),$6
```

### Patch Point 2: `hD1` consumer — check before processing

**File:** `cli.js` (bare)
**Location:** React `useEffect` that dequeues from `hD1` via `rQ7()`

**Minified pattern (1 match):**
```
let J=rQ7();if(!J)return;O.current=!0,$(!0),w(J,{}).catch(()=>{}).finally(()=>{O.current=!1,nQ7()})
```

**Regex:**
```javascript
/(let ([$\w]+)=([$\w]+)\(\);if\(!\2\)return;)([$\w]+\.current=!0,([$\w]+)\(!0\),([$\w]+)\(\2,\{\}\)\.catch\(\(\)=>\{\}\)\.finally\(\(\)=>\{[$\w]+\.current=!1,([$\w]+)\(\)\}\))/
```

**Injection:** Between the `if(!J)return;` and the processing code, insert the suppression check:
```javascript
let _tid=$2.match(/<task-id>([^<]+)<\/task-id>/);
if(_tid&&globalThis.__taskOutputRead?.has(_tid[1])){globalThis.__taskOutputRead.delete(_tid[1]);$7();return;}
```
(where `$7` is the `nQ7` function captured from the `.finally()`)

### Patch Point 3: Main loop consumer — check before enqueue

**File:** `cli.js` (bare)
**Location:** Main streaming loop `task-notification` handling

**Minified pattern (1 match):**
```
if(VAR.mode==="task-notification"){let VAR=typeof VAR.value==="string"?VAR.value:"",TASKID_VAR=VAR.match(/<task-id>...),...
```

**Regex:**
```javascript
/(if\(([$\w]+)\.mode==="task-notification"\)\{let ([$\w]+)=typeof \2\.value==="string"\?\2\.value:"",([$\w]+)=\3\.match\(\/<task-id>\(\[\^<\]\+\)<\\\/task-id>\/\))/
```

**Injection:** After the task_id extraction, insert suppression check:
```
$1;if($4&&globalThis.__taskOutputRead?.has($4[1])){globalThis.__taskOutputRead.delete($4[1]);continue}
```
(Append after the matched group, before the rest of the parsing)

## Implementation

Create `patches/2.1.41/bare/patch-quiet-notifications.js` following the structure of existing patches (`patch-no-collapse-reads.js` as template).

The patch applies three sequential regex replacements to the minified `cli.js`:
1. TaskOutput flag injection (2 matches via `/g`)
2. `hD1` consumer suppression check (1 match)
3. Main loop consumer suppression check (1 match)

Update `patches/2.1.41/index.json` to add the patch under `bare`.

## Files to Create/Modify

- **Create:** `patches/2.1.41/bare/patch-quiet-notifications.js`
- **Modify:** `patches/2.1.41/index.json` — add entry under `bare`
- **Create:** `TEST_PROMPT.md` — test prompt for verifying behavior in a fresh session

## Test Plan

1. `node claude-patching.js --bare --check` — verify all existing patches + new one pass
2. `node claude-patching.js --bare --apply` — apply patches
3. Use `TEST_PROMPT.md` in a fresh Claude Code session to:
   - Launch a background agent
   - Use TaskOutput to read its result
   - Verify no duplicate notification appears after the turn
4. Also verify a background agent that completes WITHOUT TaskOutput still shows the notification normally

## Scope

**Bare install only** for now. Native install uses different variable names and has structural differences in the notification path (e.g., no `continue` after task-notification in the streaming loop). Native patch can be ported separately once bare is verified.

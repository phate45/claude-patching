# Test: Background Agent Notification Suppression

Read this file fully, then execute all three tests below in order. After each test, report PASS or FAIL based on the expected behavior. Wait 10 seconds between tests to allow any pending notifications to arrive.

## Test 1: Suppressed notification (TaskOutput reads output → notification should NOT fire)

Do the following:
1. Launch a background Explore agent: search this codebase for files containing "TODO" comments. Use `run_in_background: true`.
2. Immediately call TaskOutput with `block: true` and `timeout: 60000` to wait for and read the agent's result.
3. Summarize what the agent found.
4. Then say: "Waiting 10 seconds for any stale notification..." and pause for 10 seconds (use Bash `sleep 10`).
5. After the sleep, report the result:
   - **PASS** if NO task completion notification appeared between your summary and this point
   - **FAIL** if a "Completed task #..." or "Task ... (status: completed)" notification appeared

## Test 2: Normal notification (no TaskOutput → notification SHOULD fire)

Do the following:
1. Launch a background Explore agent: count how many `.js` files exist in this project. Use `run_in_background: true`.
2. Do NOT call TaskOutput. Just say "Agent launched, waiting for notification..." and pause for 15 seconds (use Bash `sleep 15`).
3. After the sleep, report the result:
   - **PASS** if a task completion notification DID appear (the notification is expected here since TaskOutput was never called)
   - **FAIL** if no notification appeared (the patch may be over-suppressing)

## Test 3: Non-blocking TaskOutput (early read → notification should still fire)

Do the following:
1. Launch a background Explore agent: find all Python files in this project. Use `run_in_background: true`.
2. Immediately call TaskOutput with `block: false` (non-blocking check).
3. Report what TaskOutput returned (likely "not_ready" since the agent just started).
4. Do NOT call TaskOutput again. Say "Waiting for notification..." and pause for 15 seconds (use Bash `sleep 15`).
5. After the sleep, report the result:
   - **PASS** if a task completion notification DID appear (non-blocking "not_ready" should NOT suppress the notification)
   - **FAIL** if no notification appeared

## Final Summary

After all three tests, print a summary table:

```
| Test | Expected | Result |
|------|----------|--------|
| 1. TaskOutput read → suppress | No notification | PASS/FAIL |
| 2. No TaskOutput → normal     | Notification    | PASS/FAIL |
| 3. Non-blocking not_ready     | Notification    | PASS/FAIL |
```

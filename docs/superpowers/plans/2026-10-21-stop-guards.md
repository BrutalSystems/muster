# Bounded Stop Guards Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Attach Claude turn-end reminders with one shared continuation opportunity per launch, session and prompt.

**Architecture:** Extend version-1 bundles with Stop hooks, stage one dispatcher for all Stop policies, and atomically consume a private budget keyed by session/prompt hashes. Persist a content-free latest observation separately from the immutable attachment summary.

**Tech Stack:** TypeScript, Node filesystem/process APIs, Zod, Vitest.

**Spec:** The user-approved bounded contract: honour stop_hook_active; distinguish passed, unresolved, failed and exhausted; preserve profile hooks; Codex refused; no waking idle sessions. Runner failure cannot guarantee completion prevention.

## Global Constraints

- Existing PreToolUse manifests and digests remain compatible.
- Claude Stop requires the verified runtime floor 2.1.306; runtime input must supply session_id and prompt_id.
- Reasons are intentionally model-visible, bounded and non-secret. No reasons, input, scripts or source paths in launch records or audit logs.
- One continuation across all attached policies; profile hooks retain their own behavior.

## Review Focus

- Concurrent Stop invocations cannot each consume a continuation.
- Missing turn identity must not create an unbounded fallback budget.
- A script that exits while descendants hold stdout must still time out.
- Task cleanup must retain the final observation after deleting snapshots.
- Hook failure and exhausted budget must never be reported as passed.

### Task 1: Bundle and dispatcher

Files: src/guards.ts, src/stop-guard.ts, test/guards.test.ts, test/stop-guard.test.ts.

- [x] Add failing tests for Stop acceptance, matcher refusal, mixed summaries and single-dispatcher staging.
- [x] Add real child-process tests for pass, block then exhausted, stop_hook_active, concurrent calls, new prompts/sessions, malformed/oversized output, missing/crashing/timed-out children and missing turn identity.
- [x] Run focused tests and confirm missing behavior fails.
- [x] Implement manifest union and shared dispatcher; atomic exclusive budget claims; bounded child execution; strict Stop JSON output.
- [x] Run focused tests to green.

### Task 2: Observation and compatibility

Files: src/registry.ts, src/run.ts, src/mcp-selection.ts, test/guards.test.ts.

- [x] Test runtime floor before reservation and spawn, content-free status returned by run/list/wait and retained after cleanup, and peer status spoof exclusion.
- [x] Implement minimum-version parameter and durable latest stop_guard_status observations; initial unknown status for attached Stop policies.
- [x] Run focused tests then the full suite.

### Task 3: Documentation, live acceptance and review

Files: docs/cli.md, src/mcp-tools.ts, RELEASE_NOTES.md.

- [x] Explain output protocol, bounded behavior, profile-hook limits, unknown observations and runner failure.
- [x] Verify actual staged runner blocks once, continues and passes or reports exhaustion with a real Claude launch; keep raw evidence outside the repository.
- [x] Run typecheck, full tests, package/public checks; obtain independent code review and fix material findings.
- [x] Prepare reviewable branch/PR without merging or publishing this approval scope.

## Verification and review decisions

- Focused tests were observed failing before implementation; live Claude tasks verified pass after continuation, unresolved exhaustion and failed exhaustion, including durable observations after cleanup.
- Compatibility regression preserves the previous PreToolUse default-matcher digest.
- Termination regression verifies cleanup of the policy process group.
- Review ruling: human-format parity is part of exposing the result; added a failing formatter regression and the outcome line.
- Review ruling: arbitrary daemonizing policy descendants cannot be reliably contained by this command runner. Documented process-group cleanup and a no-daemonizing policy requirement rather than claiming complete process containment. Cost: such descendants can outlive the timeout; hooks remain trusted best-effort reminders.

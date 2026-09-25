# Test results

Date: 2026-09-25 (container environment; local execution).

Command: `npm test` (repository root)
Result: exit 0; 18 tests passed (controller 9, adapter 8, integration 1).

The integration test uses a real HTTP controller bound to a free localhost port, two real worker CLI child processes, and a temporary SQLite database. It submits independent nodes plus a dependent node; asserts all outputs and statuses, result events, and claims from both distinct worker IDs; and reopens SQLite to verify persisted success. It passed independently with `node --test test/*.test.js`.

Controller regression coverage includes per-workflow concurrency fairness, node-level maxAttempts on lease expiry, expiry processing during claim without nested transaction failure, and paused completion finalized on resume. Existing tests cover stale epoch fencing and persistence across reopen.

Not verified: DSH plugin boot/runtime, native UI (NOT ready), model-backed agent execution, full cluster readiness, load/security/network isolation, or adversarial request fuzzing. The worker CLI supports only deterministic tool nodes and rejects agent nodes without a DSH harness. Tests do not invoke a model or modify live DSH services. The parent independently reran `npm test` after the tool-definition fix: all 18 passed, and importing the adapter with installed peers succeeded. An isolated DSH web boot using `--profile web --patch ... --no-open --port 0` produced no readiness output before a 35-second timeout; this is NOT a successful boot verification. Development source is published as an incomplete prototype, not a completed cluster plugin.

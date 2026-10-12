# Standard Agent validation

The retired management tree, allocation, lease, budget, effects, and FormalPlan fixtures are deleted. There is no target test-count or compatibility bridge.

- `tests/unit/flow-controller.test.ts`: real controller/store with an injected native handle boundary, for ownership, current result versions, command idempotency, dependency scheduling, cancellation, and recovery.
- `tests/integration/native-member.test.ts`: real native preset, tools, permission behavior, persistence, and cancellation; only model generation is scripted.
- `tests/integration/native-browser.test.ts`: ordinary and Flow Agents actually navigate and read distinct test pages through the configured native Playwright MCP provider.
- `tests/integration/provider-settings.test.ts`: isolated native web settings create/edit/cold reload/delete; existing provider/default preserved, zero model calls.
- `tests/unit/reader-source.test.ts`: read-only native history observation and delayed availability.
- `tests/acceptance/native-live.ts`: explicit ordinary/team modes, same configured profile/preset/model, separate fresh workspaces, actual 2026-10-12 market data and native receipts. Every attempted run keeps its report; sources/build drift and failed/partial output remain visible.

Example after building and freezing the source tree:

```sh
node --import tsx tests/acceptance/native-live.ts --mode ordinary --profile-dir /path/to/configured/profile
node --import tsx tests/acceptance/native-live.ts --mode team --profile-dir /path/to/configured/profile
```

Provider credentials stay in protected local profile/environment inputs and are never printed. Each run creates its own `.artifacts/native-agent-simplification/` workspace. Mechanical file checks do not establish price correctness; inspect the saved raw responses, actual HTTP tool receipts, native model/usage, and final task acceptance. A performance claim requires both matched runs; it cannot be inferred from one successful team run.

The runner waits for the owner's latest matching native Turn end and two stable `running=false` observations. A completed execution with valid file structure is recorded as `AWAITING_SOURCE_REVIEW`, never `PASSED`. Independent source review must verify the actual fetch receipts and raw index prices before reporting task success. RPC and settings requests have bounded deadlines; timeout/error cleanup only cancels the newly created owner Session.

Team instructions ask for complementary business delegation and personal checking by the existing main Agent. They do not prescribe fetch/reviewer roles or two members. The harness verifies at least one actual child Session with persisted model responses and tool calls; it does not enforce this as a product runtime limit. Team-specific instructions are preserved separately beside the common task prompt. V2 used older fixed-two-member instructions and was intentionally stopped as a diagnostic pilot; preserve that limitation when comparing its artifacts with later runs.

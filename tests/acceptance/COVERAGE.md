# Standard Agent validation

The retired management tree, allocation, lease, budget, effects, and FormalPlan fixtures are deleted. There is no target test-count or compatibility bridge.

- `tests/unit/flow-controller.test.ts`: real controller/store with an injected native handle boundary, for ownership, current result versions, command idempotency, mechanical task dispatch, cancellation, and recovery. Independent work can reuse an idle member before the previous result is accepted; `ready` is a publication checkpoint, not a promise that the Agent stays idle.
- `tests/unit/collaboration-state-model.test.ts`: bounded checks against the actual controller and SQLite: 98 two-sibling cuts (seven reachable states in both construction orders), seven recursive completion traces, and one actor/version/current-result trace. Rejected operations leave all collaboration tables and command/event records unchanged; accepted root completion creates no self-review and does not close the native owner.
- `tests/unit/team-command-regression.test.ts`: command identity, attachment preservation, and controlled fault cuts after intent persistence, team commit, and native Inbox publication. SQLite is actually reopened; Session checkpoints and injected exceptions are test seams, not OS crashes or proof of native journal durability under torn writes.
- `tests/unit/queued-task-update.test.ts` and `same-member-order-regression.test.ts`: queued work can be revised without cancelling unrelated active work, roots are never automatically dispatched, and an Agent's membership restrictions apply to that team rather than a separate team it owns.
- `tests/integration/native-member.test.ts`: real native preset, tools, permission behavior, persistence, and cancellation; only model generation is scripted.
- `tests/integration/native-browser.test.ts`: ordinary and Flow Agents actually navigate and read distinct test pages through the configured native Playwright MCP provider.
- `tests/integration/team-command.test.ts`: real command RPC and native tools with scripted model generation. The minimal successful path records member `write` plus natural return and owner `flow_task → read → flow_review → flow_result`; there are three Flow calls, no create alias, no explicit member result, and no root self-review. It also checks concurrent/cold command replay, encoded PNG admission, member release, and the owner's final reply.
- `tests/integration/provider-settings.test.ts`: isolated native web settings create/edit/cold reload/delete; existing provider/default preserved, zero model calls.
- `tests/unit/reader-source.test.ts`: read-only native history observation and delayed availability.
- `tests/acceptance/native-live.ts`: explicit ordinary/team modes, same configured profile/preset/model, separate fresh workspaces, actual 2026-10-12 market data and native receipts. Every attempted run keeps its report; sources/build drift and failed/partial output remain visible.

The state cuts cover their declared finite bounds, not every asynchronous schedule or unbounded task tree. Controlled fault cuts establish collaboration replay behavior at specified API boundaries; the separate native integration covers the normal host path. The command integration does not exercise file-upload receipt admission. Passing artifacts apply to their recorded source/bundle identity. These checks establish protocol behavior and native integration, not business artifact correctness or model speed rankings.

Example after building and freezing the source tree:

```sh
node --import tsx tests/acceptance/native-live.ts --mode ordinary --profile-dir /path/to/configured/profile
node --import tsx tests/acceptance/native-live.ts --mode team --profile-dir /path/to/configured/profile
```

Provider credentials stay in protected local profile/environment inputs and are never printed. Each run creates its own `.artifacts/native-agent-simplification/` workspace. Mechanical file checks do not establish price correctness; inspect the saved raw responses, actual HTTP tool receipts, native model/usage, and final task acceptance. A performance claim requires both matched runs; it cannot be inferred from one successful team run.

The runner waits for the owner's latest matching native Turn end and two stable `running=false` observations. A completed execution with valid file structure is recorded as `AWAITING_SOURCE_REVIEW`, never `PASSED`. Independent source review must verify the actual fetch receipts and raw index prices before reporting task success. RPC and settings requests have bounded deadlines; timeout/error cleanup only cancels the newly created owner Session.

Team instructions ask for complementary business delegation and personal checking by the existing main Agent. They do not prescribe fetch/reviewer roles or two members. The harness verifies at least one actual child Session with persisted model responses and tool calls; it does not enforce this as a product runtime limit. Team-specific instructions are preserved separately beside the common task prompt. V2 used older fixed-two-member instructions and was intentionally stopped as a diagnostic pilot; preserve that limitation when comparing its artifacts with later runs.

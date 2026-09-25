# Test results

## Default suite — PASS

`npm test`: exit 0; **18 tests passed** (controller 9, adapter 8, integration 1).

The real HTTP/two-worker subprocess test now uses a test-only claim barrier to guarantee each worker receives a real lease before repeat claims. Without coordination, fast echo jobs sometimes let one process finish before its sibling starts; that was a flaky test expectation, not proof of a scheduler defect. The revised test passed **5/5 additional runs**. It verifies participation, dependency outputs, events and SQLite reopen persistence, not scheduling fairness or throughput.

Controller coverage includes graph validation, authentication, idempotency, epoch fencing, bounded retries, per-workflow concurrency, expiry during claim, and pause/resume/cancel. Agent lifecycle unit tests use test doubles.

## Installed DSH component integration — PASS

`node test/native-plugin.mjs` runs real installed Cordis Context, DSH SystemPrompt and ToolRuntime services plus the actual flow plugin. It exercises flow_submit/flow_read through the real tool execution pipeline against the HTTP controller, rejects invalid input, then runs a deterministic worker to persisted completion. No model calls.

Set DSH_INSTALL_PATH if the package root differs from /opt/dsh/app. Install adapter dependencies with `npm ci --prefix adapter` first. This is a component-runtime test, not a Web profile boot.

## Real Flash transport end-to-end — PASS

Opt-in command: `FLOW_LIVE_TEST=1 DEEPSEEK_API_KEY=<provided securely> node test/live-deepseek.mjs`.

Path: real HTTP controller → actual worker → installed DSH DeepSeekAdapter → official DeepSeek endpoint → worker result submission → SQLite → database reopen verification.

Actual provider receipt:
- Model: deepseek-v4-flash
- Paid requests: **1**
- Input tokens: **14**, cache read: **0**
- Output tokens: **3**
- Total tokens: **17**
- Result: FLOW_OK
- Workflow succeeded; output persisted after reopening database.

One earlier attempt failed locally before any network request because the test omitted the required prepareExtensions hook. After correcting this test setup, the single real request passed. No model output was fabricated.

Budget controls: at most 2 requests per invocation, 128 output tokens per request, serialized input under 2000 characters, thinking disabled, no tools, no retries, request timeout, official origin only, redirects disabled. Actual requests across this test session: **1**. These live tests are excluded from npm test and require explicit opt-in; repeated invocations incur separate costs. No keys or access URLs are committed.

## Remaining boundaries

Full DSH Agent loop, managed-agent isolation, supervisor planning, native UI, Web plugin lifecycle, distributed deployment, load/security hardening and exactly-once external effects remain unverified. Production workers are still deterministic-only. The live test directly invokes the real DSH provider adapter from a test worker; it does not establish that the production Agent worker has been enabled.

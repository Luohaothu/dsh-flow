# dsh-flow P0 (partial)

This repository implements a local flowd prototype and DSH server-side adapter. It is not production hardened. The native cluster UI and DSH plugin/native UI integration are NOT ready. A deterministic tool-only worker CLI and a local two-worker HTTP/SQLite integration test are implemented; these do not constitute a complete cluster.

## Controller

Requires Node.js >=22.13 (node:sqlite). Run `FLOW_TOKEN='use-a-long-random-secret' FLOW_DB=./flow.sqlite npm start --prefix controller`. flowd binds only 127.0.0.1:3090 by default; PORT overrides the port. Keep FLOW_TOKEN server-side; never expose it to browser code. `GET /health` is public; all other routes require `Authorization: Bearer <token>`. Workflow submit requires `Idempotency-Key`.

`npm test` runs controller, adapter, and real subprocess integration suites. `npm run test:integration` runs the root integration test. Example: `examples/sample-workflow.json`. Controller supports deterministic `echo`, `sum`, `fail`; it never executes shell input. SQLite is single-writer local state. Lease/result idempotency and epoch fencing are supported; exactly-once external effects are not.

## Worker CLI

Run `FLOW_URL=http://127.0.0.1:3090 FLOW_TOKEN=... npm run worker --prefix adapter`. `WORKER_ID` is optional and defaults to a unique random ID. The CLI runs deterministic tool nodes only; it rejects agent nodes because no DSH harness is present, and it never accepts arbitrary commands. SIGINT/SIGTERM stop polling and abort active work.

The integration test launches a real HTTP controller and two real worker CLI child processes on a free localhost port, checks claimed-worker identities, node outputs, events, and persistence after reopening SQLite.

## DSH adapter and status

Install `adapter/` dependencies using `npm ci --prefix adapter`. Set `FLOW_URL` and `FLOW_TOKEN` in the server environment before loading it as a DSH server plugin. Real Cordis and DSH ToolRuntime integration has passed using `node test/native-plugin.mjs`. A separately opted-in Flash test has passed through the installed DSH provider adapter, HTTP controller and SQLite. The full Agent loop and native UI remain unverified; production workers are deterministic-only.

Live model testing is deliberately excluded from `npm test`: `FLOW_LIVE_TEST=1 DEEPSEEK_API_KEY=<provided securely> node test/live-deepseek.mjs`. It enforces a per-invocation request budget, limited output, thinking off and no retries. `DSH_INSTALL_PATH` overrides the installed DSH package root (default `/opt/dsh/app`). Never commit credentials.

Native UI/RPC integration, full Web plugin lifecycle and managed Agent execution remain incomplete. Do not expose flowd/DSH to untrusted networks. `TEST-RESULTS.md` records commands, actual usage and limitations.

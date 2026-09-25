# dsh-flow P0 (partial)

This repository implements a local flowd prototype and DSH server-side adapter. It is not production hardened. The native cluster UI and DSH plugin/native UI integration are NOT ready. A deterministic tool-only worker CLI and a local two-worker HTTP/SQLite integration test are implemented; these do not constitute a complete cluster.

## Controller

Requires Node.js >=22.13 (node:sqlite). Run `FLOW_TOKEN='use-a-long-random-secret' FLOW_DB=./flow.sqlite npm start --prefix controller`. flowd binds only 127.0.0.1:3090 by default; PORT overrides the port. Keep FLOW_TOKEN server-side; never expose it to browser code. `GET /health` is public; all other routes require `Authorization: Bearer <token>`. Workflow submit requires `Idempotency-Key`.

`npm test` runs controller, adapter, and real subprocess integration suites. `npm run test:integration` runs the root integration test. Example: `examples/sample-workflow.json`. Controller supports deterministic `echo`, `sum`, `fail`; it never executes shell input. SQLite is single-writer local state. Lease/result idempotency and epoch fencing are supported; exactly-once external effects are not.

## Worker CLI

Run `FLOW_URL=http://127.0.0.1:3090 FLOW_TOKEN=... npm run worker --prefix adapter`. `WORKER_ID` is optional and defaults to a unique random ID. The CLI runs deterministic tool nodes only; it rejects agent nodes because no DSH harness is present, and it never accepts arbitrary commands. SIGINT/SIGTERM stop polling and abort active work.

The integration test launches a real HTTP controller and two real worker CLI child processes on a free localhost port, checks claimed-worker identities, node outputs, events, and persistence after reopening SQLite.

## DSH adapter and status

Install `adapter/` as a DSH server plugin package only after setting `FLOW_URL` and `FLOW_TOKEN` in the server environment. Adapter exports follow the installed Cordis plugin API. Integration boot against DSH and actual model execution were not performed. The DSH plugin is NOT verified/ready, and the native UI is NOT ready. Agent work must be opted into only for a trusted DSH worker/profile; loop/scoped capability guarantees require real integration review.

No native UI package interaction, authenticated UI RPC bridge, live DSH isolated boot, or real model run has been verified. No live DSH services were restarted. Do not expose flowd/DSH to untrusted networks. `TEST-RESULTS.md` records actual test status and limitations.

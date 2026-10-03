# Acceptance

Two suites live here, and they answer different questions.

* **Deterministic mock suite** (`npm run test:mock`) — the *current* functional
  verdict. A local OpenAI-compatible server (`src/host/mock-model.mjs`,
  bound to `127.0.0.1:0`) replaces only the model's generation; every run still
  boots a real DSH host, runs the real agent loop, executes real tools, writes
  real Sessions and a real SQLite ledger. The model's answers are fixed, so a
  failure can only come from the plugin, the host, or the fixture.
* **Live-model runs** — the same cases driven by a real endpoint. They remain
  useful history for provider compatibility, but a live-model result is *not*
  the functional verdict: the model's judgement is not the plugin's.

`tests/acceptance/COVERAGE.md` maps every currently declared action, query and
operator entry to the named behavioural test that proves it, and lists the
design actions that are **not** implemented.

## Deterministic mock suite

```bash
# From the repository root, after the preparation below:
FLOW_CHROMIUM_PATH=/usr/bin/chromium npm run test:mock
```

That runs, in order: the native host contracts
(`tests/acceptance/native/mock-runtime.test.mjs` — N0 plus the F-permission,
F-arguments, F-transport and F-budget negatives) and then
`tests/acceptance/suite.mjs --mock`, which executes smoke, recursion, recovery,
context, browser, panel and both scale tiers (16 and 64) in their own run
directories. Single-scenario diagnosis uses the same entry point:

```bash
npm run accept:mock -- --case recovery --run-id rec-diag-1
npm run accept:mock -- --case scale --run-id scale-diag-1 --dataset-limit 16
```

Mock mode refuses `--profile-patch`, `--budget-scale` and `--max-role-turns`:
the fixture is frozen, so a multiplier would make the verdict describe something
other than the scenario. Each report records `validation_mode: "mock-api"`, the
generated overlay, the scenario's name, every request (identity, script branch,
tool calls, barrier, usage) in `mock-requests.json`, and the fixture's own
incomplete-request verdict. A fixture that cannot answer a request, or that
holds one that never releases, fails the run as `FIXTURE` — it is never reported
as a plugin outcome.

## Preparation

Use Node 22.19+ or 24+ and install the published DSH packages from the repository
root. Browser scenarios also need the published browser providers and Playwright:

```bash
npm install --ignore-scripts --no-package-lock
npm install --no-save --ignore-scripts --no-package-lock \
  @deepseek-ai/dsh-browser-use@0.1.7-rc.2 \
  @deepseek-ai/dsh-experimental-browser-use-runtime@0.1.7-rc.2 \
  @deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.1.7-rc.2 \
  playwright@1.61.1
npm run build
npm test
```

The acceptance launcher automatically resolves `@deepseek-ai/dsh` from the
project's npm installation. Set `DSH_INSTALL_PATH` explicitly to select another
published package directory or a built harness checkout's `apps/cli` directory.
For a monorepo-based setup, `scripts/link-dsh.mjs` remains an idempotent alternative
that links the harness and capability packages into this project.

Set `FLOW_CHROMIUM_PATH` to the absolute path of an installed Chromium executable
(for example `/usr/bin/chromium`). It is forwarded through the isolated host's
allowlist to the browser provider and used by the panel and website checks. An
invalid explicit path fails rather than silently selecting another browser. If
unset, each Playwright installation uses its own managed browser; those binaries
must already be installed, since the commands above skip installation scripts.
Provider resolution supports both published npm packages and monorepo source
directories; no author-specific home directory is required for the mock suite.

## Live-model runs (historical compatibility evidence)

Every command in this section was run against a real endpoint on this machine:
the local Qwen service (`http://127.0.0.1:8000/v1`, model `Qwen3.8-27B-FP8`) and
the OpenAI-compatible Coding Plan endpoint. A live run boots the same isolated
DSH profile as a mock run; only the model's answers are not fixed. Its result is
kept as provider-compatibility history and as evidence that the harness wiring
still works against a real service — it is not the functional verdict.

### V1 — local Qwen protocol and tool round trip

```bash
FLOW_QWEN_BASE_URL=http://127.0.0.1:8000/v1 \
FLOW_QWEN_MODEL=Qwen3.8-27B-FP8 \
node tests/acceptance/qwen-smoke.mjs
```

Covers: exact model id in `/v1/models`; non-streaming short answer; streaming
termination with `stream_options.include_usage`; a native tool call in the
stream; no unexpected reasoning increment in the default mode; a `high`
thinking probe; mid-stream abort; two concurrent requests; an unknown model
failing loudly; then — through a full profile assembly — a real filesystem
write/read, an out-of-workspace write refusal, a real `web_fetch` of an official
page, cluster cancellation, and two parallel cluster agents.

## OpenAI-compatible Coding Plan validation through DSH

Configure DSH's existing `llm-pi-ai` provider with
`examples/openai-compatible.patch.yml` (`api: openai-completions`,
`baseURL: https://ark.cn-beijing.volces.com/api/coding/v3`,
`model: deepseek-v4.1-flash`). The cluster plugin contains no provider
implementation. To run any existing case in an interactive shell that
has loaded `~/.bashrc`:

```bash
FLOW_MODEL_PROVIDER=openai-compatible \
FLOW_MODEL_ID=deepseek-v4.1-flash \
FLOW_MODEL_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3 \
FLOW_MODEL_API_KEY="$ANTHROPIC_AUTH_TOKEN" \
  node tests/acceptance/run.mjs --case smoke --run-id smoke-openai-01 \
  --profile-patch examples/openai-compatible.patch.yml
```

The key is copied explicitly to `FLOW_MODEL_API_KEY` for the isolated host;
ambient `ANTHROPIC_*` variables never reach DSH. The profile refers to the
key by `apiKeyEnv` and contains no token value. Each run retains its existing
case assertions, workspace, budgets and build fingerprint; only DSH's
model configuration changes.

## Mechanism — unit suite

```bash
node --test tests/unit/*.test.js
```

Covers the management tree (mixed children, cycle rejection), the transaction
lifecycle and audit gate, role permissions and domain escapes, the correction
budget and escalation, command idempotency, the budget ledger (transfer,
settle, reclaim), communication across subtrees, the reparent safety point,
lease epochs, cancellation, lease expiry and restart recovery.

## Business cases

Each case writes `.artifacts/<run-id>/` with `report.json`, `events.jsonl`,
`usage.json`, `checks.json`, `sessions.json`, and case-specific evidence.

```bash
node tests/acceptance/run.mjs --case smoke     --run-id smoke-01          # three roles + workers + audit gate
node tests/acceptance/run.mjs --case panel     --run-id panel-01          # native panel + /api/flow auth
node tests/acceptance/run.mjs --case context   --run-id ctx-01            # forced low threshold: real compaction
node tests/acceptance/run.mjs --case browser   --run-id br-01             # browser capability in a real Chromium
node tests/acceptance/run.mjs --case recovery  --run-id rec-01            # kill + restart the host mid-flight
node tests/acceptance/run.mjs --case recursion --run-id rec-01 --timeout-ms 1500000
node tests/acceptance/run.mjs --case website   --run-id site-01 --mode all
node tests/acceptance/run.mjs --case research  --run-id res-01  --mode all
node tests/acceptance/run.mjs --case refactor  --run-id ref-01  --mode all
node tests/acceptance/run.mjs --case scale     --run-id scale-01 --dataset-limit 64
```

`context` and `browser` carry their own environment overrides in the case file
(`FLOW_CONTEXT_TRIGGER`, and the browser provider patch
`examples/cluster.web.patch.yml`). A case's `env` block is merged into the host
process environment by the runner, and the provider packages a patch names by
bare specifier are linked into the profile's `node_modules` automatically.

Or run a whole battery with `node tests/acceptance/suite.mjs [--only smoke,panel,scale]
[--parallel 2]`.

Two flags exist for the ladder: `--dataset-limit N` selects the first N corpus
files (and sizes the plan and budget to that tier) and
`--max-llm-concurrency N` changes exactly one knob at a time.

`--kill-on-event <event-type>` (or a case's `recovery.kill_on_event`) kills the
host as soon as the runner *observes* a named cluster event, so a crash can be
placed inside a specific window instead of on a wall clock. The harness arms it
on `delivery-flushed` — the boundary the plugin records after a recipient
session is durable and before the delivery is acked — and reports what it saw in
`kill_trigger` (`observed`, `polls`, `poll_error`). A trigger that never fires is
reported as such rather than silently killing on the clock.

`--mode all` runs the three control shapes in order, each in a fresh workspace:
`single` (one DSH agent, no cluster, same tools and budget), `flat` (root roles
plus direct workers, `max_depth=1`), and `hierarchical` (the asymmetric tree).

The `recovery` case kills the test host mid-flight (SIGKILL) and restarts it
against the same `DSH_HOME` and data directory; it never touches a user-owned
DSH or Qwen process.

The `scale` case generates a deterministic corpus **into the run directory**
(64 fixed `.js` files, four groups, one `export function fixtureSymbolNNN`
declaration each at line 3, plus a manifest of content hashes), then builds the
immutable `dataset.json` from it and runs one worker per file. The expected
symbol and line for every transaction are properties of the generated files, so
"this Worker really read this file and quoted this declaration" is a comparison
rather than a judgement. The tier is selected with `--dataset-limit N`
(16 or 64): the plan and the budget stay the function of N the case declares
(`65536*N` tokens, `12*N` requests, `16*N` tool calls), and
`scale_validation: VERIFIED` requires planned = executed = terminal = ACCEPTED
= N with every result matching its file exactly.

Before the tier runs, the runner holds exactly `max_llm_concurrency` Worker
requests open at once and watches the wire for a further one: the ceiling is
proven reached and enforced, not merely reported. The probe lands in
`report.concurrency_probe`.

## Reading a report

* `mechanism_pass` — a boolean (or `UNKNOWN`) recomputed from the durable
  ledger: duplicate accepts, duplicate usage charges, double leases, lost
  transactions, resident handles and in-flight requests over their configured
  limits.
* `scenario_status` — `PASSED | FAILED | BLOCKED` from the case's own checks.
* `failure_class` — `MECHANISM | MODEL_OUTPUT | ENVIRONMENT | LIMIT_REACHED`.
* `quality_checks` — per-criterion pass/fail with the raw evidence string.

A failing scenario does not by itself mean the mechanism failed: model output
that does not compile, an unreachable documentation page, or a spent budget are
reported as themselves.

## Known environment limits

* Node v24.0.1 here lacks `import.meta.main`, so the shipped DSH bin cannot be
  invoked directly; all runs go through `src/host/dsh-launch.mjs`.
* `web_fetch` uses the host's confined fetch: it only reaches public hosts and
  refuses cross-origin redirects. A redirect that fails is kept as evidence and
  the worker is expected to read the final official URL explicitly.
* The workspace sandbox is `workspace-write` with approval `never`. It bounds
  file effects, not hostile code: reads outside the workspace remain possible.
* Chromium needs permission to create local sockets. A shell sandbox that denies
  those sockets can block browser scenarios even when the binary and packages
  are present; use an approved execution environment that supports Chromium.

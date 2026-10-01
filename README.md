# dsh-flow

A hierarchical agent cluster for the [DeepSeek Harness](../deepseek-harness): one
management tree of three-role management nodes, durable transactions with an
independent audit gate, restart recovery, layered budgets, and a native panel.

Everything runs through the host's own machinery — `ctx.agents` for every turn,
`ctx.sessions` for durability, the host tool pipeline for tool calls, and the
authenticated `/api/flow` route for the panel. There is no second agent loop.

## What is in the box

| Module | Responsibility |
|---|---|
| `adapter/src/store.js` | SQLite state: one writer, `state + command receipt + events` in one transaction, injected clock, schema-versioned |
| `adapter/src/protocol.js` | Roles, actions, statuses, capability → host-tool mapping, input validation |
| `adapter/src/budget.js` | `limit / reserved / spent` ledger per scope, transfers of unused unreserved capacity, absolute wall deadlines |
| `adapter/src/communication.js` | Messages, multicast, groups, blackboard with revision fencing, subscriptions with a snapshot+cursor cut |
| `adapter/src/runtime.js` | One scheduled turn of a real DSH agent: tool policy, durable effect receipts, request accounting |
| `adapter/src/cluster.js` | Control loop, scheduler, leases, checkpoints, recovery, queries and the report |
| `adapter/src/actions.js` | The role action handlers (`flow_transaction`, `flow_allocation`, `flow_audit`) |
| `adapter/src/index.js` | Cordis plugin: `flow` service, host tools, tool-execution seam, `/api/flow`, IPC bridge |
| `ui/src/client.jsx` | The panel (`sidebar.panellist` + a `main` key), built to `lib/client.js` |

## Management model

* **Management node** — three independent agent identities: orchestrator (plan,
  decompose, dispatch, validate, aggregate), allocator (identities, write
  scopes, budgets, concurrency, scaling), auditor (plan and validation gates,
  corrections). They wake through durable events, never through a shared reply.
* **Worker node** — one agent identity with one allocation and one transaction.
* Roles do not consume child slots, but they do consume agent identities and
  active slots; the scheduler always keeps at least one slot for management.

Transaction lifecycle: `DRAFT → (plan audit) → READY → RUNNING → SUBMITTED →
VALIDATING → ACCEPTED`, with `REJECTED`, `BLOCKED`, `PAUSED`, `CANCELLED`,
`SUPERSEDED`, `FAILED` as first-class alternatives. A Worker result can only
reach `SUBMITTED`; only an auditor decision on that exact `result_revision`
reaches `ACCEPTED`. A completed Worker turn without an explicit
`submit_result` publishes its native effect receipts (including call identity,
write path/content, writer and native result) as the fallback proposal;
effects from older turns are excluded. A settled write is evidence to judge,
not automatic acceptance.

A role's `flow_query {what:"node",params:{id}}` may read only a node
inside its subtree. The answer and management-turn digest include a
topology-only root-to-parent `ancestors` chain, so a deep role can
distinguish its local two-node view from the whole management tree
without reading an ancestor's transactions or agents. An issue raised
after a durably incomplete Worker result cannot be dismissed as a
mistaken observation, even when no write tool was refused; a mere
plan edit cannot count as its correction. A fresh Worker grant or result
must supply evidence before the Auditor reviews whether it was repaired.
Delegation-owned `management_levels_remaining` survives write-scope
revisions and cannot be inflated by the child Orchestrator. An active
Worker grant is tied to the transaction plan at allocation time: a
later `adjust_transaction` requires the owning Allocator to release
and replace the old grant before that Worker can run the revised plan.

A plan rejection during a live Worker turn is recorded immediately, but its
`RUNNING` transaction stays submittable until that turn settles. The result and
effect receipts are retained; the rejected revision then returns to `DRAFT`
for correction, never straight to acceptance. An Orchestrator adjustment or
separate replan cannot replace the revision under a live Worker lease.
Recovery fences the old lease and restores a rejected revision to `DRAFT`,
not `READY`.

A parent publishes one aggregate after all delegated children are
`ACCEPTED`. While that result is `SUBMITTED` or `VALIDATING`, another
aggregate cannot replace its revision or stale the Auditor's pending
decision; a later change to the delegated work requires an explicit
replan before a new aggregate.

Accepted root transactions do not by themselves finish the cluster.
The root Orchestrator receives a final turn to fulfill remaining
cluster-objective work (including post-acceptance blackboard publication),
then calls `flow_transaction finish_cluster`. Its durable request permits
the root's resource return, aggregate summary, and final health record;
recovery preserves an unfinished request as pending work. Delegated
management nodes still close once their subtree and parent report are
accepted.

`effect.node_id` identifies the physical child Worker node; the effect's
`owner_management_id` identifies the management node that allocated
that Worker. Auditor decisions about which management domain produced a
file use the latter alongside the settled write receipt.

## Running it

### Cluster mode (集群模式)

The bundle inserts a **集群模式** entry into the composer's mode menu, beside the
shipped ones (标准模式 / 最小模式 / …). A preset is a *composition* — choosing it
decides which tools and prompt the session's agent runs with — which is what
"mode" means in this harness: there is no separate named-mode registry.

```yaml
# cordis.patch.yml, this plugin's bundle patch
- insert:
    - id: preset-cluster
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: cluster
        name: 集群模式
        order: 3
        plugins: [persona, compaction, tool-ask-user, tool-todo]
```

In that mode the agent's job is to **run the cluster**, not to do the work itself.
Its persona says the user's request is a cluster objective; the `flow_*` host tools
start, read and steer that cluster (`flow_start`, `flow_read`, `flow_control`), and
the cluster's own Workers keep the file/shell capabilities the cluster grants them —
so the task is still executed with real tools, on the cluster's management tree,
under its own Auditor gates.

`flow_start` fills in what a session cannot know: workspace from `FLOW_WORKSPACE`,
capabilities `fs_read,fs_write`, and — for any envelope field the caller omits — the
interactive budget/limits (`INTERACTIVE_BUDGET`/`INTERACTIVE_LIMITS` in
`adapter/src/index.js`). A cluster started with `budget: {}` and the default
`worker_model_requests: 0` blocks on its first request; these defaults keep a
prompt-shaped start usable while an explicit value always wins.

### Installing it into a DSH instance

Install the plugin as a profile **bundle** (its own `cordis.patch.yml` then supplies
both the plugin row and the 集群模式 preset):

```bash
node scripts/build.mjs
mkdir -p ~/.dsh/profiles/flow/node_modules
ln -sfn "$PWD" ~/.dsh/profiles/flow/node_modules/dsh-flow
cat > ~/.dsh/profiles/flow/package.json <<'JSON'
{ "name": "dsh-profile-flow", "private": true,
  "dependencies": { "dsh-flow": "link:." },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-flow"] } } }
JSON

DSH_INSTALL_PATH=/home/leo/projects/deepseek-harness/apps/cli \
FLOW_DATA_DIR=~/.dsh-flow-instance/data FLOW_WORKSPACE=~/.dsh-flow-instance/workspace \
FLOW_QWEN_BASE_URL=http://127.0.0.1:8000/v1 FLOW_QWEN_MODEL=Qwen3.8-27B-FP8 \
node acceptance/lib/dsh-launch.mjs --profile flow --patch examples/instance.patch.yml \
  --host 127.0.0.1 --port 8791 --no-open
# → prints the authenticated URL (dsh web: http://127.0.0.1:8791/?token=…)
```

`examples/instance.patch.yml` carries only the deployment policy (model route,
sandbox, compaction); it must not insert `dsh-flow` again. `examples/cluster.patch.yml`
is the *acceptance* overlay — its profile does not depend on the package, so there it
inserts the row explicitly.

The harness webserver refuses `--host 0.0.0.0` ("would expose remote code execution
to the network") and its schema accepts loopback only, so reaching the instance from
another machine is an explicit operator decision: bind loopback, add
`--trusted-host <the address you reach it as>`, and put a forwarder of your own in
front. The token in the URL is the whole authorization — anyone holding it drives the
agent.

```bash
# one-time: link this project to a DSH installation (dev + tests)
DSH_INSTALL_PATH=/home/leo/projects/deepseek-harness/apps/cli node scripts/link-dsh.mjs
node scripts/build.mjs

# unit tests (mechanism, no model)
node --test adapter/test/*.test.js

# the functional verdict: native host contracts + every scenario, deterministic model
DSH_INSTALL_PATH=/home/leo/projects/deepseek-harness/apps/cli npm run test:mock

# one deterministic scenario, for diagnosis
npm run accept:mock -- --case recovery --run-id rec-diag-01
npm run accept:mock -- --case scale --run-id scale-diag-01 --dataset-limit 16

# local Qwen protocol + tool round trip
FLOW_QWEN_BASE_URL=http://127.0.0.1:8000/v1 FLOW_QWEN_MODEL=Qwen3.8-27B-FP8 node acceptance/qwen-smoke.mjs

# one acceptance case through a real, isolated DSH profile
node acceptance/run.mjs --case smoke --run-id smoke-01
node acceptance/run.mjs --case panel --run-id panel-01
node acceptance/run.mjs --case website --run-id site-01 --mode all
node acceptance/run.mjs --case recursion --run-id recursion-generous-01 --budget-scale 4 --max-role-turns 64

# The same case through DSH's existing OpenAI-compatible provider configuration.
# In a shell loaded from ~/.bashrc, transfer only the key, not ANTHROPIC_* routing:
FLOW_MODEL_PROVIDER=openai-compatible \
FLOW_MODEL_ID=deepseek-v4.1-flash \
FLOW_MODEL_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3 \
FLOW_MODEL_API_KEY="$ANTHROPIC_AUTH_TOKEN" \
  node acceptance/run.mjs --case smoke --run-id smoke-openai-01 \
  --profile-patch examples/openai-compatible.patch.yml
```

The profile patch configures **DSH's** `llm-pi-ai` `openai-completions`
provider and default model. It is not an adapter backend. `--profile-patch`
appends this DSH configuration after the case's existing patch, including
the browser patch where applicable. The acceptance runner passes the selected
provider/model and only `FLOW_MODEL_API_KEY` into its isolated host; the
ambient `ANTHROPIC_*` variables are never inherited. The committed patch
stores `apiKeyEnv: FLOW_MODEL_API_KEY`, not the token value.

Artifacts land in `.artifacts/<run-id>/`: `report.json`, `events.jsonl`,
`usage.json`, `checks.json`, `sessions.json`, `state.json`, plus case-specific
outputs. The runner always boots a real DSH profile; it never drives the
cluster through model text.

`--budget-scale N` multiplies only tokens, model requests, tool calls and the
wall allowance; it also lengthens the host's settle timeout. The optional
`--max-role-turns N` widens the per-role turn ceiling separately. Use a new
run ID for each experiment: the original case file stays unchanged, while
`report.json` records the effective spec and explicit experiment overrides.
Neither option changes the acceptance checks, identity limits or concurrency.
An unresolved issue, a repeated wrong write scope or a stagnant role is a
mechanism to repair, not evidence that the result needs only a larger budget.

### Deterministic runs (`--mock`)

`acceptance/lib/mock-model.mjs` is a local OpenAI-compatible endpoint bound to
`127.0.0.1:0`; it replaces only the model's generation. Every run still boots a
real DSH profile, drives the real agent loop, executes real tools and writes a
real Session and SQLite ledger. The run's own `llm-pi-ai` overlay is written
into the run directory, so the case patches stay untouched and no ambient
credential is read. `acceptance/lib/mock-scenarios.mjs` answers each request
from the identity and state the request itself carries — the role line, the
domain digest, the newest tool result — so concurrent Workers interleave freely
and each still gets the answer its own transaction owes.

Mock mode refuses `--profile-patch`, `--budget-scale` and `--max-role-turns`:
the fixture is frozen, so a multiplier would make the verdict describe
something other than the scenario. A request the script cannot classify, or a
barrier that never releases, fails the run with `failure_class: "FIXTURE"` —
it is never reported as a plugin outcome. Reports carry
`validation_mode: "mock-api"`, the scenario name, and `mock-requests.json`;
`acceptance/COVERAGE.md` maps every declared action and query to its test.

## Environment facts this build depends on

These were observed on the target machine and are load-bearing:

* **Node v24.0.1 does not implement `import.meta.main`.** The shipped
  `apps/cli/lib/bin.js` guards its entry point with it, so invoking the built
  bin directly exits silently with status 0. `acceptance/lib/dsh-launch.mjs`
  therefore imports the exported `runCli` and calls it.
* **`DSH_INSTALL_PATH` is a convention of this project, not a DSH variable.**
  DSH anchors module resolution on the running launcher's own `package.json`.
  The variable is used by `scripts/link-dsh.mjs` and the acceptance runner to
  find the installation to link against.
* **Plugin resolution goes through the profile.** `acceptance/lib/host.mjs`
  creates `$DSH_HOME/profiles/<name>/node_modules/dsh-flow` as a symlink to this
  project, exactly how a profile-installed bundle is resolved.
* **Capability tool packages must be resolvable by this package.**
  `@deepseek-ai/dsh-tool-fs`, `-fs-search`, `-bash`, `-jobs` and `-web` are
  declared dependencies and are linked into `node_modules/` by
  `scripts/link-dsh.mjs`. They are mounted into each agent's own scope; a
  package that cannot be mounted is reported, never silently skipped.
* **`llm/stream` is bound to the LLM runtime, not to an agent scope.** The
  request-accounting listener therefore filters by `options.sessionId`, or
  concurrent agents would settle the same response more than once.
* **The web bundle disables host-plane compaction.** It mounts the compaction
  backend inside the agent preset, which a cluster agent never mounts, so
  `examples/cluster.patch.yml` re-enables the host-plane backend for the
  sessions this plugin drives. Without it a long management session can only
  grow until the provider rejects the request outright.
* **`tokenMeter` measures the durable session surface.** The plugin checks
  each model request against the provider's sending ceiling and compacts when
  the measured surface crosses the role's context budget. Compaction can lower
  that measurement: the previous floor taken from the last settled request
  was removed because it made effective compaction appear ineffective.
* **Approval preset.** A cluster session cannot answer an approval prompt, so
  `examples/cluster.patch.yml` pins an extra `workspace-write-unattended`
  (sandbox `workspace-write`, approval `never`) preset as the deployment
  default. The sandbox still permits reads outside the workspace: the tool
  allowlist is not a security boundary for hostile code.
* **The Coding Plan's OpenAI route thinks by default.** Measured against
  `https://ark.cn-beijing.volces.com/api/coding/v3`: `POST /chat/completions`
  without a `thinking` field returns `completion_tokens_details.reasoning_tokens`
  above zero, `thinking: {type: "enabled"}` produces reasoning deltas, and
  `thinking: {type: "disabled"}` returns none. `examples/openai-compatible.patch.yml`
  therefore pins `thinkingFormat: deepseek` and declares an `off` level, which
  is what makes `FLOW_REASONING_EFFORT=off` reach the wire as that switch. The
  endpoint accepts `max_tokens`, streams `usage` under
  `stream_options.include_usage`, and serves the family id `deepseek-v4-1-flash`
  (with `[1m]` selecting the long-context variant); a 96,040-token prompt was
  accepted, and the profile declares a 131,072-token window.

## Configuration

The plugin reads its configuration from the environment of the host process:

| Variable | Default | Meaning |
|---|---|---|
| `FLOW_DATA_DIR` | `<cwd>/.dsh-flow` | directory holding `cluster.sqlite` |
| `FLOW_MODEL_PROVIDER` | `local-sglang` | provider route every cluster agent uses |
| `FLOW_QWEN_MODEL` | `Qwen3.8-27B-FP8` | plugin model id; the acceptance runner also accepts `FLOW_MODEL_ID` and forwards it under this key |
| `FLOW_QWEN_BASE_URL` | `http://127.0.0.1:8000/v1` | plugin route URL; the acceptance runner also accepts `FLOW_MODEL_BASE_URL` and forwards it under this key |
| `FLOW_MODEL_API_KEY` | unset | optional explicit key passed only to the isolated DSH host, referenced by the OpenAI profile patch |
| `--profile-patch` | unset | acceptance CLI option: append a DSH profile patch for this run |
| `FLOW_REASONING_EFFORT` | `off` | reasoning effort passed in every agent's options |
| `FLOW_MAX_TOKENS` | `4096` | per-request output cap |
| `FLOW_CONTEXT_ROLE` | `8192` | declared context budget of a management role (the compaction window) |
| `FLOW_CONTEXT_WORKER` | `16384` | declared context budget of a Worker |
| `FLOW_CONTEXT_MODEL` | `131072` | the served model's declared window (the outer sending ceiling) |
| `FLOW_CONTEXT_SERVER_INPUT` | `142074` | the deployment's own input cap (`max_req_input_len`) |
| `FLOW_STALE_MS` | `120000` | how long unhandled work may sit unchanged before it is reported stale; a parent waiting on unfinished delegated children is progressing, not stale |
| `FLOW_IPC` | unset | `1` enables the host IPC bridge used by the acceptance runner |

An Allocator may override the context budget of one identity with
`flow_allocation set_context_budget`; the override lives in `agents.meta.context`
and is what that identity's turns measure against. The provider's own window and
the deployment's input cap are the hard sending ceiling and are never raised by
an override.

There is deliberately no second cluster control port and no separate token: the
panel talks to the host over the authenticated `/api/flow` route, and the
model-facing tools call `ctx.flow` in-process.

The panel queries each management level on expansion. Child and root pages
carry `total`/`next_offset`, so a node with more than 50 children can be
expanded completely without rendering the whole tree at once. Transaction
detail shows the saved result, validation checks and evidence, and both
pending and decided plan/validation audits; an independent audit may still be
pending if the user cancels the cluster. Closing or reopening the browser
does not cancel a cluster, and the event view resumes from its durable cursor.
The authenticated browser route refuses internal host operations such as
`dispose` and `recover`; those remain IPC-only.

Management-node delegation fixes its output and acceptance contract when the
parent spawns the node. Its Orchestrator may widen a faulty execution
`inputs.write_scope` and add stricter checks, but `adjust_transaction` cannot
replace the delegated output or remove inherited acceptance criteria. A denied
write to the required artifact is not corrected by asking the child to write
another file instead.

An Allocator cannot replace, reassign or release a Worker whose turn or lease
is still live. Replacement after that safe point returns the retired identity's
unspent grant to its management node before funding the new identity; it does
not take a second Worker slot. `flow_query {what:"agents"}` lets a Worker find
the Orchestrator, Allocator and Auditor responsible for its allocation without
exposing sibling Workers.

Budget rebalance hints are tied to work a management node can actually run,
not a zero balance on a parent still waiting for its child. A Worker that has
submitted its result or reached its declared request allowance is not offered
another funding hint.

Compaction requests prefer the separately funded summary pool, then their
owning management grant. Ordinary role and Worker requests prefer their
management grant, then their identity grant; they borrow from the pool only
when neither can cover the whole request. Each request reserves all its tokens
and one model request against one scope; an empty chain never sends for free.
The summary pool's initial grant scales with the declared tier: normally 10%
of tokens and 20% of model requests, transferred out of (not added to) the
root grant. A small tier's minimum compaction envelope never takes more than
25% of either dimension; if it cannot fit, that earmark is omitted. There is
no fixed 400k-token ceiling that strands a larger tier after its first batch.

When a delegated management node completes, its idle identity grants and
remaining node grant return to its parent exactly once. If a live child's
measured request needs more than its node holds, the funder first reclaims
idle role grants in its ancestor nodes, then moves only the measured gap down
the node-ancestor ownership path. It never takes a sibling node's grant
without an explicit Allocator rebalance.

An accepted delegated node waits for its live approving role turn to end,
then finalizes before scheduling another turn against that subtree. A root
budget refusal stops that root's own new turns, not independently funded
delegated work: a child can finish and return unspent capacity for a measured
retry. If no delegated work remains and the request is still unaffordable,
the cluster stops with the original budget code. A cluster explicitly in
`BLOCKED` admits no new turns.

An explicitly incomplete Worker submission (`completed: false`, a blocked
`status`, or a blocked `outcome`) retains its original revision for independent
Auditor correction even if the Orchestrator edits the plan first. A model
request refused by the local budget ledger is not misreported as a provider
anomaly. Ancestor Allocators can rebalance for a child's recorded refused
request envelope even when that child still has a positive but insufficient
balance.

Only a measured budget stop wakes an ancestor to rebalance; an empty
node balance alone cannot supply a useful transfer amount. Stale READY
transactions and budget notifications remain durable inbox entries but
do not start a model turn for a role that cannot make the required
allocation or cross-subtree transfer.

### Explicit deviations from design V1.0

| Design section | Deviation | Why |
|---|---|---|
| §15 budget dimensions | CPU/GPU and Memory are **not implemented** | A single local inference deployment exposes no trustworthy per-scope sensor for them; a ledger column fed by a guess would read as a measurement. Nothing in this build consumes them. |
| §15 API Cost | Derivable field, **not a ledger dimension** | `usageSummary` returns `api_cost: {amount: 0, currency: 'USD', pricing: 'local-unpriced'}`. This deployment is locally served, so there is no price to multiply tokens by. Promoting it to a real dimension needs a priced deployment and a rate table, not a column. |
| §18 health | `health` table + `query {what:'health'}` + `evaluate_health` are the surface; the eight metrics are derived from the ledger on demand | A materialized health *history* would be a second source of truth for numbers the ledger already holds, and the two would drift. The §18 signals are reported per node in `report()` and per cluster in `query`. |
| §16 scale ladder | The 16- and 64-transaction tiers are recorded as `scale_validation: "INCOMPLETE"` with their measured bottleneck | Both tiers spend their approved budget on management traffic before the worker frontier moves (16: 976,048 of 1,048,576 tokens for 8 workers; 64: 3,136,768 of 4,194,304 for 9). The tiers are reported as incomplete rather than passed by lowering N, and the runs stay in `TEST-RESULTS.md` with their refusals. |
| §6 Auditor actions | 7 of 19 implemented (`inspect_plan`, `inspect_validation`, `request_correction`, `request_replan`, `request_revalidation`, `verify_correction`, `escalate`), plus `notify`, `recommend`, `evaluate_health` | The five `inspect_*` and five `detect_*` actions are finer-grained aliases of `inspect_plan`/`inspect_validation`; they change no mechanism this build relies on. The three implemented additions are the ones §18 needs. |
| §3 Orchestrator actions | 14 of 17 | `merge_transaction`, `set_requirements` and `request_review` are not implemented; `pause_transaction`, `resume_transaction` and `cancel_transaction` (scoped to one subtree) are. |
| §5 Allocator actions | 17 of 18 | `route_capability` is not implemented; capability matching already happens in `allocate_agent`. `set_context_budget` is. |
| §16 lifecycle | `CREATED` and `WAITING` never assigned; `COMPLETED` is | An identity is created READY (there is no queue state before its first turn), and a management node reaches `COMPLETED` through the closing sequence introduced here. `WAITING` would be a natural state for "queued for a model slot"; it is not used yet. |
| §6 Auditor role | Supervisor, not a gate | A plan audit is recorded and routed, but it does not block dispatch: the Orchestrator makes its own revision dispatchable, and the Auditor keeps its after-the-fact corrective authority (rejection pulls the transaction back to DRAFT). A silent Auditor must not be able to freeze a subtree. |
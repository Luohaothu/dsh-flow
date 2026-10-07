# dsh-flow

A hierarchical agent team for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with durable transactions, independent result review, layered budgets and native agent conversations.

The main Agent manages a team's lifecycle through a skill and tools. Each management node has its own Orchestrator, Allocator and Auditor; Workers execute allocated transactions. Every turn uses the host's agent loop, tool pipeline and Session persistence.

## Documentation

The Chinese [documentation](docs/design/index.md) covers usage, architecture and development:

- [Quick start](docs/design/quick-start.md) and [advanced usage](docs/design/advanced.md)
- [Agent roles](docs/design/agents.md), [hierarchy](docs/design/hierarchy.md), [dispatch](docs/design/dispatch.md) and [communication](docs/design/communication.md)
- [Development setup](docs/design/development/setup.md) and [code structure](docs/design/development/code-structure.md)
- [Interface behavior](docs/design/development/interface.md), [API](docs/design/development/api.md) and [provider interfaces](docs/design/development/provider-interfaces.md)
- [Validation](docs/design/development/validation.md) and [acceptance coverage](tests/acceptance/COVERAGE.md)

```bash
pnpm run docs:dev
pnpm run docs:build
pnpm run docs:preview
```

## Using a team

Enter `/agent-team <objective>` in the main conversation. The command submits a user prompt and loads the `agent-team` skill. The main Agent assesses the work, carries relevant context into a self-contained objective and calls `agent_team_create`. It confirms startup and polls with `agent_team_read`, sends further instructions through `agent_team_message`, and handles explicit pause, resume or cancel requests through `agent_team_control`. After a terminal result, `agent_team_finalize` releases resources while retaining results, reviews and conversations.

The main Agent and the team's root Orchestrator have independent Sessions. The main conversation remains the user's ordinary dialogue; the team header and **智能体** tab show the bound team's topology, hierarchy and read-only details.

Selecting a member opens its complete native conversation, including dialogue, trajectory and navigation back to the main Session. Available members accept text through the native composer. Reclaimed members retain their records with input disabled. The right-side button opens a read-only conversation in the sidebar. Conversation retention alone does not start an Agent.

The first task is a user prompt. Subsequent team messages use classified communication cards, collapsed to a summary by default and expandable in place. Flow routes these messages through the recipient's native inbox while retaining delivery evidence.

The plugin settings expose deployment defaults for model selection, reasoning, dispatch, hierarchy limits, concurrency, duration and budgets. Display preferences control the team view and reading behavior independently of execution settings.

## Installation

Requirements: Node `^22.19.0 || >=24.0.0` and pnpm `12.9.1`. The supported Harness baseline is `0.1.7-rc.2` with the public interface patches declared in `pnpm-workspace.yaml`. A standalone unpatched host of that version does not provide all required interfaces.

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm --dir packages/dsh-flow pack --pack-destination /tmp
```

Follow the [isolated-profile installation guide](docs/design/development/setup.md) to install the archive and configure the model route. The workspace launcher resolves the installed Harness package and calls its exported CLI entry:

```bash
# Use the isolated DSH_HOME configured in the installation guide.
node --import tsx src/host/dsh-launch.ts plugin --profile web add /tmp/dsh-flow-0.1.0.tgz
node --import tsx src/host/dsh-launch.ts --profile web --patch examples/instance.patch.yml --dump-config
```

`examples/instance.patch.yml` configures a profile with the package already installed. `examples/cluster.patch.yml` inserts services into an acceptance profile. Both map deployment variables into ordinary Cordis configuration; the plugin core reads its configuration from the schema in `packages/dsh-flow/src/config.ts`.

The standard bundle provides the service, observing Remote API and `/agent-team` command. Its capability tools are mounted inside each agent's scope. The host owns authentication, sandbox policy, model transport, conversation rendering and navigation. See [patches](patches/README.md) for the required provider contracts and their maintenance workflow.

## Execution model

Transactions progress through `DRAFT`, `READY`, `RUNNING`, `SUBMITTED`, `VALIDATING` and `ACCEPTED`, with explicit rejection, blocking, pause, failure and cancellation paths. A Worker submits evidence; acceptance requires an independent Auditor decision matching the exact result revision. Plan audits supervise planning and can request correction; they do not gate dispatch.

A parent aggregates only accepted children. Accepted root transactions still require the root Orchestrator's `finish_cluster` action before the cluster completes. Resource reclamation and task success are distinct states.

Budgets account for tokens, model requests, tool calls, wall time, agent identities and active concurrency. Usage comes from request receipts; unknown usage is not presented as zero. Shared grants are not summed once per agent. Declared write scopes support allocation checks and managed-tool authorization; filesystem access also depends on the host's sandbox and permission policy.

SQLite stores state changes, command receipts and events atomically. Recovery fences expired leases, checks durable Session evidence and reconciles in-flight effects before execution is admitted. Native Session drivers keep continued member input under Flow's role, model, budget and permission controls.

## Workspace

| Path | Responsibility |
|---|---|
| `packages/dsh-flow` | Published Cordis plugin, Host and Client TypeScript programs, team skill and bundle configuration |
| `packages/dsh-flow/src/core` | Scheduling, transactions, allocations, audit, communication, budgets and persistence |
| `packages/dsh-flow/src/client` | Team observation, native session navigation, inspectors and settings |
| `packages/typert-protocol` | Private declaration face used by Typert generation; runtime resolves the published protocol |
| `src/host` | Development launcher, isolated acceptance host, deterministic model and evidence readers |
| `tests/unit` | In-process service and component contracts |
| `tests/acceptance` | Native host contracts, scenarios, checks and standalone website seed |
| `patches` | Pinned Harness public interface extensions |
| `docs/design` | VitePress documentation |

The build emits package entry points, declarations and generated Typert host/client descriptors under `packages/dsh-flow/lib`. Host and Client have separate TypeScript programs; the browser bundle includes its generated Remote codecs.

## Validation

```bash
pnpm run typecheck
pnpm run build
pnpm test
pnpm run test:mock
pnpm run docs:build
```

The deterministic suite replaces only model generation. It starts real isolated Harness profiles, executes native tools and records Sessions and SQLite state. A case passes only when its process exits successfully, its scenario reports `PASSED` and any mechanism verdict is `PASS`. Fixture failures are reported separately from product failures. Browser checks need Playwright Chromium; `FLOW_CHROMIUM_PATH` selects an installed executable.

```bash
# Individual deterministic scenarios
pnpm run accept:mock --case recovery --run-id recovery-check
pnpm run accept:mock --case scale --run-id scale-check --dataset-limit 16

# Live model verification using the configured provider
pnpm run accept --case smoke --run-id smoke-live
pnpm run accept --case website --run-id website-live --mode all
```

Reports, checks, events, usage, Session evidence and scenario outputs are written to `.artifacts/<run-id>/` and are excluded from Git. A deterministic result verifies its scripted contract; a live-model result applies to the recorded provider, configuration and workload. Commands, verdict rules and evidence boundaries are documented in the [validation guide](docs/design/development/validation.md).

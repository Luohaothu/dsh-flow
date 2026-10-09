# dsh-flow

A hierarchical agent team for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), coordinated from the main conversation. The main Agent assesses the task, creates and monitors a team, sends instructions and finalizes completed runs. Each management node has an Orchestrator, Allocator and Auditor; Workers execute durable transactions under layered budgets and independent result review.

The main conversation provides a team tree and topology view. Selecting an Agent opens its complete native conversation and trace. Active Agents accept messages through Flow scheduling; reclaimed Agents and terminal teams retain their records with input disabled. Inspectors and the sidebar provide read-only conversation views.

See the repository [README](../../README.md) and [developer guide](../../docs/design/index.md) for the control model, deployment and validation.

## Exports

| Subpath | Purpose |
|---|---|
| `dsh-flow` | Cordis plugin: `name`, `inject`, `Config` and `apply`; the `ctx.flow` service contract and DTO types. |
| `dsh-flow/command` | The `/agent-team` skill command and main-Agent create/read/message/control/finalize tools. |
| `dsh-flow/web` | Read-only `@Remote` methods over `ctx.flow`. |
| `dsh-flow/types` | Client-safe wire types shared by Host and browser. |
| `dsh-flow/client` | Browser assembly: generated Remote contribution, team views, native session navigation, communication cards and settings. |
| `dsh-flow/typert` | Generated Host descriptors. |
| `dsh-flow/remote` | Generated Client contribution and type merges. |
| `dsh-flow/cordis.patch.yml` | Bundle configuration: control plane, Remote face and `/agent-team` command. |

## Build and validation

Run these commands from the workspace root:

```sh
pnpm run build      # Host, Remote generation, Client, website seed and bundles
pnpm run typecheck  # Type graph and generated Remote contracts
pnpm test           # Unit and acceptance-harness contract suites, no model
pnpm run test:mock  # Native host contracts and deterministic scenarios
```

The build emits `lib/index.js`, `lib/web.js`, `lib/command.js`, `lib/client.js`, declarations under `lib/types/`, and the generated Typert artifacts. Host and Client are separate TypeScript programs. The browser bundle inlines the generated Remote contribution and its zod codec while using provider-owned UI modules from the host.

## Configuration

Deployment parameters are validated by the schemastery schema in `src/config.ts`. Production code reads no environment variables. The bundle derives model defaults from the host's default-model provider; the main Agent can carry the active conversation's model into a team. Execution settings apply to newly created teams, while display preferences belong to the current browser user.

DSH owns model resolution, context capacity, output limits and official default compaction. Flow budgets cover tool calls, elapsed time, Agent identities and active execution capacity. Token statistics consume durable native Session events and preserve missing values and observation completeness. The UI distinguishes configured routes from the latest actual model request. Agent scheduling permits do not imply precise concurrency measurements for host auxiliary requests.

The current data contract uses schema 4, including immutable task plans, published result snapshots, validation records and member input delivery identities. Use an empty database or a current schema database; old databases and retired configuration fields are rejected without migration or deletion. Select a new `dataDir` for old installations.

The pinned host requires the public provider API patches included in this workspace. Use the frozen workspace install and its launcher. The [provider interface guide](../../docs/design/development/provider-interfaces.md) describes these dependencies, and the [validation guide](../../docs/design/development/validation.md) describes the checks.

# dsh-flow

A hierarchical agent cluster for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
one management tree of three-role management nodes, durable transactions with an
independent audit gate, restart recovery, layered budgets, and a browser panel.

This package is the published half of the plugin. The repository that contains it
also holds the development and acceptance chain; the full documentation —
management model, configuration table, acceptance commands and the migration
notes for this cutover — lives in the repository's top-level `README.md`.

## Exports

| Subpath | What it is |
|---|---|
| `dsh-flow` | The Cordis plugin: `name`, `inject`, `Config` and `apply`. Publishes the `ctx.flow` service contract and the DTO types; it does **not** export the runtime class. |
| `dsh-flow/tools` | The user-facing consumer: `flow_start`, `flow_read`, `flow_control`. Mounted inside the cluster preset so a normal Session never sees a command surface it cannot use. |
| `dsh-flow/web` | The standard Remote face: seven `@Remote` methods over `ctx.flow`. |
| `dsh-flow/types` | The Client-safe wire vocabulary, shared by Host and browser. |
| `dsh-flow/client` | The browser assembly: mounts the generated Remote contribution, then the panel. |
| `dsh-flow/typert` | Generated Host descriptors (build artifact). |
| `dsh-flow/remote` | Generated Client contribution and type merges (build artifact). |
| `dsh-flow/cordis.patch.yml` | The bundle patch: the control plane, the Remote face, and the 集群模式 preset. |

## Running it

```sh
pnpm run build      # Host program, Remote generation, Client program, website seed, bundles
pnpm test           # unit suites, no model
pnpm run test:mock  # native host contracts plus every deterministic scenario
```

`pnpm run build` emits `lib/index.js`, `lib/tools.js`, `lib/web.js` and
`lib/client.js`, the declarations under `lib/types/`, and both generated Typert
artifact pairs. The Host and Client halves are separate TypeScript programs; the
browser bundle is built last, from the Client program, with the generated Remote
contribution and its zod codec inlined.

## Configuration

Every deployment parameter is configuration, validated by a schemastery schema in
`src/config.ts`. The plugin reads no environment variable. The bundle's own row
derives `provider`/`model`/`reasoningEffort` from the host's default-model
provider, so the plugin routes wherever the deployment routes; the acceptance
overlay is the only place `FLOW_*` variables are turned into configuration.
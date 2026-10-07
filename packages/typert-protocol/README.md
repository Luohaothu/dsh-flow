# @deepseek-ai/dsh-typert-protocol

This private workspace package provides the Typert protocol declarations used by the dsh-flow build. Its package name and version match the installed DeepSeek Harness protocol dependency, allowing the generator to associate Remote decorators and wire types with a workspace package.

The protocol defines `@Remote`, service bindings, invocation descriptors, codecs, provider contracts and the shared `RemoteError` vocabulary. It registers no Cordis service and performs no TypeScript analysis.

## Layout

| Path | Purpose |
|---|---|
| `lib/index.js` | Protocol runtime consumed by package resolution. |
| `lib/types/` | Runtime modules and declarations used by the compiler and generator. |
| `src/index.ts` | Workspace entry forwarding the protocol declarations. |
| `src/types.ts` | Workspace entry forwarding the protocol type vocabulary. |
| `tsconfig.host.json` | Host program for the workspace protocol face. |

The root TypeScript configuration maps the protocol package and its `/types` subpath to these declarations. Runtime hosts resolve their installed protocol package. Keep this package aligned with the pinned host dependency when updating the workspace.

See the [interface guide](../../docs/design/development/interface.md) for dsh-flow's Host, Client and generated Remote boundaries.

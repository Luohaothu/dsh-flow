import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';

const require = createRequire(import.meta.url);
const workspace = join(dirname(new URL(import.meta.url).pathname), '../..');
function clientFile(name: string): string {
  const packageName = name.replace(/\/client$/, '');
  const root = join(workspace, 'node_modules/.pnpm');
  const prefix = packageName.replace('/', '+') + '@0.2.0-rc.2';
  try { return require.resolve(name); } catch {
    const directory = readdirSync(root).find(entry => entry.startsWith(prefix) && !entry.includes('patch_hash'));
    if (!directory) throw new Error(`Missing client runtime ${name}`);
    return join(root, directory, 'node_modules', packageName, 'lib/client.js');
  }
}
/** Public ModuleLoader graph; explicit overrides probe pristine-npm scratch before installation. */
export function createNativeClientLoader(overrides: Readonly<Record<string, string>> = {}, externals: Readonly<Record<string, unknown>> = {}) {
  const factories = new Map<string, (require: (name: string) => unknown) => unknown>(), cache = new Map<string, unknown>();
  const load = (name: string): Record<string, unknown> => {
    if (Object.hasOwn(externals, name)) return externals[name] as Record<string, unknown>;
    if (cache.has(name)) return cache.get(name) as Record<string, unknown>;
    if (!name.startsWith('@deepseek-ai/') || !name.endsWith('/client')) { const value: unknown = require(name); cache.set(name, value); return value as Record<string, unknown>; }
    const packageName = name.replace(/\/client$/, '');
    const source = readFileSync(overrides[packageName] ?? clientFile(name), 'utf8');
    const window = { __ModuleLoader__: { load(value: { id: string; factory: (require: (name: string) => unknown) => unknown }) { factories.set(value.id, value.factory); } } };
    new Function('window', source)(window);
    const factory = factories.get(packageName);
    if (!factory) throw new Error(`Client runtime did not register ${name}`);
    const value = factory(dependency => load(dependency)); cache.set(name, value); return value as Record<string, unknown>;
  };
  return load;
}
export const loadNativeClient = createNativeClientLoader();
function physicalStream(options: { open(signal: AbortSignal): AsyncIterable<unknown> }) {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    restart() { throw new Error('This fixture has one physical carrier generation'); },
    async dispose() { controller.abort(); },
    async *[Symbol.asyncIterator]() {
      for await (const value of options.open(controller.signal)) yield { value, generation: 1, signal: controller.signal, accept() {} };
    },
  };
}
export function managedSessions(load = loadNativeClient, follow?: (request: unknown, signal: AbortSignal) => AsyncIterable<unknown>): { ctx: Context; sessions: ISessions; writes: { count: number }; emitRemote(event: string, ...args: unknown[]): void } {
  const api = load('@deepseek-ai/dsh-api-session-controller/client');
  const writes = { count: 0 }, ctx = new Context();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const write = async () => { writes.count++; throw new Error('Unexpected normal transport'); };
  const remote = { $stream: physicalStream, $on: (event: string, listener: (...args: unknown[]) => void) => { const bucket = listeners.get(event) ?? new Set(); listeners.set(event, bucket); bucket.add(listener); return () => bucket.delete(listener); }, session: new Proxy({}, { get: (_target, name) => name === 'follow' && follow ? follow : write }), commands: { execute: write }, subagents: { prompt: write, interruptByParent: write } };
  ctx.reflect.provide('remote', remote, undefined);
  ctx.reflect.provide('connection', { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } }, undefined);
  ctx.reflect.provide('typert', { contexts: { registerClient: () => () => {} } }, undefined);
  const apply = api.apply as (ctx: Context) => void;
  apply(ctx);
  return { ctx, sessions: ctx.sessions, writes, emitRemote(event, ...args) { for (const listener of listeners.get(event) ?? []) listener(...args); } };
}

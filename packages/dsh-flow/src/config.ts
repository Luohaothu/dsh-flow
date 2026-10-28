import Schema from '@deepseek-ai/schemastery';
import { resolve } from 'node:path';
import { assertJson } from './assignments/schema.js';
import type { RunDefaults } from './run/types.js';
import type { PriceTable } from './dashboard/protocol.js';

export interface CleanupConfig { gracefulTimeoutMs: number; immediateTimeoutMs: number }
export interface ConnectionConfig { port?: number; staticDirectory?: string; allowedOrigins?: string[]; prices?: PriceTable }
export interface PlainConfig {
  stateDirectory?: string;
  defaults?: RunDefaults;
  cwd?: string;
  rootRole?: string;
  patternSources?: string[];
  maxConcurrentAgents?: number;
  cleanup?: Partial<CleanupConfig>;
  connection?: ConnectionConfig;
}
export interface ResolvedConfig {
  stateDirectory: string; defaults: RunDefaults; cwd?: string; rootRole?: string;
  patternSources: string[]; maxConcurrentAgents: number; cleanup: CleanupConfig; connection: ConnectionConfig;
}

function positiveCleanupTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('Cleanup timeout must be finite and positive');
  return value;
}


/** Native caller settings supply inherited values; only explicit defaults override them. */
export function createPlainConfigSchema(): Schema<PlainConfig> {
  const cleanupTimeout = Schema.transform(Schema.number(), positiveCleanupTimeout);
  return Schema.object({
  stateDirectory: Schema.string().default('.dsh-flow'),
  defaults: Schema.dict(Schema.any()).default({}),
  cwd: Schema.string(), rootRole: Schema.string(),
  patternSources: Schema.array(Schema.string()).default([]),
  maxConcurrentAgents: Schema.number().step(1).min(1).default(4),
  cleanup: Schema.object({ gracefulTimeoutMs: cleanupTimeout.default(120_000), immediateTimeoutMs: cleanupTimeout.default(10_000) }).default({}),
  connection: Schema.object({ port: Schema.number().step(1).min(0).max(65535), staticDirectory: Schema.string(),
    allowedOrigins: Schema.array(Schema.string()).default(['http://127.0.0.1:3080', 'http://localhost:3080']), prices: Schema.array(Schema.object({
      model: Schema.object({ provider: Schema.string().required(), id: Schema.string().required() }).required(),
      currency: Schema.string().required(), input: Schema.number().min(0).required(), output: Schema.number().min(0).required(),
      cacheRead: Schema.number().min(0), cacheWrite: Schema.number().min(0),
    })) }).default({}),
  });
}
export const PlainConfigSchema = createPlainConfigSchema();
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`Unsupported ${path} field: ${key}`);
}
function text(value: unknown, path: string): void { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${path} must be a nonempty string`); }
function strings(value: unknown, path: string): void { if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`); for (const item of value) text(item, path); }
function numeric(value: unknown, path: string, integer = false): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) throw new TypeError(`${path} must be a finite ${integer ? 'integer' : 'number'}`);
}
function validateDefaults(defaults: RunDefaults): void {
  const value = object(defaults, 'defaults');
  keys(value, ['model', 'params', 'permission', 'hostExtras', 'preset', 'skills'], 'defaults');
  if (value.model !== undefined) { const model = object(value.model, 'defaults.model'); keys(model, ['provider', 'id'], 'defaults.model'); text(model.provider, 'defaults.model.provider'); text(model.id, 'defaults.model.id'); }
  if (value.params !== undefined) {
    const params = object(value.params, 'defaults.params'); keys(params, ['version', 'temperature', 'maxTokens', 'reasoningEffort'], 'defaults.params');
    if (params.version !== 1) throw new TypeError('defaults.params.version must be 1');
    if (params.temperature !== undefined) numeric(params.temperature, 'defaults.params.temperature');
    if (params.maxTokens !== undefined) { numeric(params.maxTokens, 'defaults.params.maxTokens', true); if ((params.maxTokens as number) <= 0) throw new TypeError('maxTokens must be positive'); }
    if (params.reasoningEffort !== undefined) text(params.reasoningEffort, 'defaults.params.reasoningEffort');
  }
  if (value.permission !== undefined && !['read-only', 'workspace-write', 'full-access'].includes(value.permission as string)) throw new TypeError('Invalid defaults.permission');
  if (value.preset !== undefined) text(value.preset, 'defaults.preset');
  if (value.skills !== undefined) strings(value.skills, 'defaults.skills');
  if (value.hostExtras !== undefined) {
    const extras = object(value.hostExtras, 'defaults.hostExtras'); keys(extras, ['dsh'], 'defaults.hostExtras');
    if (extras.dsh !== undefined) { const dsh = object(extras.dsh, 'defaults.hostExtras.dsh'); keys(dsh, ['stop'], 'defaults.hostExtras.dsh'); if (dsh.stop !== undefined) strings(dsh.stop, 'defaults.hostExtras.dsh.stop'); }
  }
}
export function resolveConfig(input: PlainConfig = {}): ResolvedConfig {
  keys(object(input, 'Flow configuration'), ['stateDirectory', 'defaults', 'cwd', 'rootRole', 'patternSources', 'maxConcurrentAgents', 'cleanup', 'connection'], 'Flow configuration');
  if (input.cleanup) keys(object(input.cleanup, 'cleanup'), ['gracefulTimeoutMs', 'immediateTimeoutMs'], 'cleanup');
  if (input.connection) keys(object(input.connection, 'connection'), ['port', 'staticDirectory', 'allowedOrigins', 'prices'], 'connection');
  const parsed = PlainConfigSchema(input);
  const defaults = structuredClone(parsed.defaults ?? {}); assertJson(defaults); validateDefaults(defaults);
  text(parsed.stateDirectory, 'stateDirectory');
  if (parsed.cwd !== undefined) text(parsed.cwd, 'cwd');
  if (parsed.rootRole !== undefined) text(parsed.rootRole, 'rootRole');
  strings(parsed.patternSources ?? [], 'patternSources');
  const cleanup = { gracefulTimeoutMs: parsed.cleanup?.gracefulTimeoutMs ?? 120_000, immediateTimeoutMs: parsed.cleanup?.immediateTimeoutMs ?? 10_000 };
  for (const value of Object.values(cleanup)) positiveCleanupTimeout(value);
  const connection = structuredClone(parsed.connection ?? {});
  if (connection.staticDirectory !== undefined) { text(connection.staticDirectory, 'connection.staticDirectory'); connection.staticDirectory = resolve(connection.staticDirectory); }
  if (connection.allowedOrigins) {
    strings(connection.allowedOrigins, 'connection.allowedOrigins');
    for (const origin of connection.allowedOrigins) {
      if (origin === 'dsh-app://app') continue;
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new TypeError('Expected an exact allowed origin');
    }
  }
  if (connection.prices !== undefined) {
    if (!Array.isArray(connection.prices)) throw new TypeError('connection.prices must be an array');
    const models = new Set<string>();
    for (const [index, price] of connection.prices.entries()) {
      const path = `connection.prices[${index}]`;
      keys(object(price, path), ['model', 'currency', 'input', 'output', 'cacheRead', 'cacheWrite'], path);
      const model = object(price.model, `${path}.model`); keys(model, ['provider', 'id'], `${path}.model`);
      text(model.provider, `${path}.model.provider`); text(model.id, `${path}.model.id`); text(price.currency, `${path}.currency`);
      const identity = JSON.stringify([model.provider, model.id]);
      if (models.has(identity)) throw new TypeError('Model prices must be unique');
      models.add(identity);
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
        if ((field === 'cacheRead' || field === 'cacheWrite') && price[field] === undefined) continue;
        const value = price[field]; numeric(value, `${path}.${field}`);
        if (typeof value !== 'number' || value < 0) throw new TypeError('Price must be nonnegative');
      }
    }
  }
  return { stateDirectory: resolve(parsed.stateDirectory ?? '.dsh-flow'), defaults,
    ...(parsed.cwd === undefined ? {} : { cwd: resolve(parsed.cwd) }), ...(parsed.rootRole === undefined ? {} : { rootRole: parsed.rootRole }),
    patternSources: (parsed.patternSources ?? []).map(path => resolve(path)), maxConcurrentAgents: parsed.maxConcurrentAgents ?? 4, cleanup, connection };
}

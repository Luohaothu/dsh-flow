/** Initialize editable model settings in the profile, never in CLI overlays. */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, isMap, isSeq, isScalar, isAlias, type YAMLMap } from 'yaml';

export interface OmlxProfileOptions {
  baseURL: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
  reasoningEffort: 'off' | 'high';
}

/** Resolve only the documented deployment variables; no JavaScript is evaluated. */
export function omlxProfileOptions(env: Record<string, string | undefined>): OmlxProfileOptions {
  const options = {
    baseURL: env.FLOW_QWEN_BASE_URL ?? 'http://127.0.0.1:8000/v1',
    model: env.FLOW_QWEN_MODEL ?? 'Qwen3.8-27B-4bit',
    contextWindow: Number(env.FLOW_CONTEXT_MODEL ?? 500_000),
    maxTokens: Number(env.FLOW_MAX_TOKENS ?? 8192),
    reasoningEffort: env.FLOW_MODEL_REASONING_EFFORT ?? 'off',
  };
  const url = new URL(options.baseURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Model baseURL must be an HTTP(S) URL without credentials');
  if (!options.model.trim()) throw new TypeError('Model id must not be empty');
  for (const field of ['contextWindow', 'maxTokens'] as const) {
    if (!Number.isSafeInteger(options[field]) || options[field] <= 0) throw new TypeError(`${field} must be a positive integer`);
  }
  if (options.maxTokens > options.contextWindow) throw new TypeError('maxTokens must not exceed contextWindow');
  if (options.reasoningEffort !== 'off' && options.reasoningEffort !== 'high') throw new TypeError('reasoningEffort must be off or high');
  return { ...options, reasoningEffort: options.reasoningEffort };
}

/**
 * Run only while this profile is stopped. Add missing oMLX/default-model settings and materialize only our known !!js
 * expressions. Existing literal values, other providers and unrelated profile
 * rows remain intact. Credentials stay an environment reference.
 */
export function initializeOmlxProfile(profileDir: string, options: OmlxProfileOptions): { path: string; changed: boolean } {
  // Also validate callers which construct the typed options directly.
  omlxProfileOptions({ FLOW_QWEN_BASE_URL: options.baseURL, FLOW_QWEN_MODEL: options.model,
    FLOW_CONTEXT_MODEL: String(options.contextWindow), FLOW_MAX_TOKENS: String(options.maxTokens),
    FLOW_MODEL_REASONING_EFFORT: options.reasoningEffort });
  const path = join(profileDir, 'cordis.patch.yml');
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '[]\n';
  const document = parseDocument(before, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] });
  if (document.errors.length) throw document.errors[0];
  if (!isSeq(document.contents)) throw new TypeError('Profile patch must be a YAML sequence');
  const sequence = document.contents;
  const expressions = new Map<string, string | number>([
    ["process.env.FLOW_QWEN_BASE_URL ?? 'http://127.0.0.1:8000/v1'", options.baseURL],
    ["process.env.FLOW_QWEN_MODEL ?? 'Qwen3.8-27B-4bit'", options.model],
    ['Number(process.env.FLOW_CONTEXT_MODEL ?? 500000)', options.contextWindow],
    ['Number(process.env.FLOW_MAX_TOKENS ?? 8192)', options.maxTokens],
    ["process.env.FLOW_MODEL_REASONING_EFFORT ?? 'off'", options.reasoningEffort],
  ]);
  const rowFor = (id: string): YAMLMap | undefined => {
    const rows = sequence.items.filter(row => isMap(row) && String(row.get('id')) === id);
    if (rows.length > 1) throw new TypeError(`Profile has multiple ${id} rows; consolidate them before initialization`);
    const existing = rows[0];
    if (existing && !isMap(existing)) throw new TypeError('Profile row must be a mapping');
    return existing;
  };
  // Restrict migration to the known model namespaces. Unknown expressions fail
  // before any write instead of being evaluated or silently frozen.
  const materialize = (node: unknown): void => {
    if (isAlias(node)) throw new TypeError('Model configuration aliases must be replaced with explicit values before initialization');
    if (isScalar(node) && node.tag === 'tag:yaml.org,2002:js') {
      const value = typeof node.value === 'string' ? expressions.get(node.value.trim()) : undefined;
      if (value === undefined) throw new TypeError('Unsupported model expression; replace it with an explicit value in the profile');
      node.value = value;
      delete node.tag;
    } else if (isMap(node)) {
      if (node.has('__jsExpr')) throw new TypeError('Serialized model expressions must be explicit scalar values');
      for (const pair of node.items) materialize(pair.value);
    } else if (isSeq(node)) for (const item of node.items) materialize(item);
  };
  let providerRow = rowFor('llm-pi-ai');
  const defaultRow = rowFor('agent-default-model');
  materialize(providerRow); materialize(defaultRow);
  if (!providerRow) {
    providerRow = document.createNode({ id: 'llm-pi-ai', config: { providers: {} } });
    document.add(providerRow);
  }
  if (!providerRow.hasIn(['config', 'providers', 'omlx'])) {
    providerRow.setIn(['config', 'providers', 'omlx'], document.createNode({
      displayName: 'Local oMLX', api: 'openai-completions', baseURL: options.baseURL,
      apiKeyEnv: 'FLOW_MODEL_API_KEY', timeoutMs: 360_000, streamIdleTimeoutMs: 300_000,
      retryPolicy: { mode: 'normal', maxRetries: 0 },
      compat: { thinkingFormat: 'qwen-chat-template', supportsStore: false, supportsDeveloperRole: false,
        supportsReasoningEffort: false, supportsStrictMode: false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens' },
      models: [{ id: options.model, contextWindow: options.contextWindow, maxTokens: options.maxTokens,
        input: ['text'], reasoningEfforts: { off: null, high: 'high' } }],
    }));
  }
  if (!defaultRow) {
    const models = providerRow.getIn(['config', 'providers', 'omlx', 'models']);
    const firstModel = isSeq(models) ? models.items.find(item => isMap(item) && typeof item.get('id') === 'string' && String(item.get('id')).trim()) : undefined;
    if (!isMap(firstModel)) throw new TypeError('Existing oMLX has no declared model; select an explicit default model before initialization');
    document.add({ id: 'agent-default-model', config: { provider: 'omlx', model: String(firstModel.get('id')), reasoningEffort: options.reasoningEffort } });
  }
  const after = String(document);
  if (after === before) return { path, changed: false };
  if ((existsSync(path) ? readFileSync(path, 'utf8') : '[]\n') !== before) throw new Error('Profile changed during initialization; retry after settings edits finish');
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, after, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  return { path, changed: true };
}

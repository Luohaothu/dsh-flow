import type { Usage } from '../core/types.js';

const MODELS_URL = 'https://models.dev/api.json';
const EXCHANGE_URL = 'https://api.frankfurter.dev/v2/rate/USD/CNY';
const REFRESH_INTERVAL = 24 * 60 * 60 * 1_000;
const RETRY_INTERVAL = 60 * 1_000;
const REQUEST_TIMEOUT = 5_000;

const providerAliases = new Map([
  ['deepseek-official', 'deepseek'],
  ['deepseek-account', 'deepseek'],
]);
const chineseLabs = new Set([
  '01-ai', '01ai', 'alibaba', 'baai', 'baichuan', 'baidu', 'bytedance', 'bytedance-seed', 'deepseek', 'deepseek-ai', 'huawei',
  'inclusionai', 'meituan', 'minimax', 'moonshotai', 'openbmb', 'opendatalab', 'paddlepaddle',
  'qwen', 'sensenova', 'sensetime', 'stepfun', 'stepfun-ai', 'tencent', 'xiaomi', 'z-ai', 'zhipuai',
]);
const chineseModelId = /^(?:baichuan|deepseek|doubao|ernie|glm|hunyuan|kimi|minicpm|minimax|mimo|qwen|sensenova)(?=[0-9._-]|$)/;
const chineseStandaloneId = /^(?:step|yi)(?=[0-9._-]|$)/;

type Currency = 'CNY' | 'USD';
type Estimate = { amount: number; currency: Currency } | { amount: null; currency: null };
type Catalog = Map<string, Map<string, ModelPrice>>;

interface TokenRates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

interface ContextPriceTier extends TokenRates {
  aboveInputTokens: number;
}

interface ModelPrice {
  rates: TokenRates;
  tiers: ContextPriceTier[];
  currency: Currency;
}

function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function modelCurrency(modelId: string, canonicalId: unknown): Currency {
  const lab = typeof canonicalId === 'string' ? /^([^/]+)\/.+/.exec(canonicalId)?.[1] : undefined;
  if (lab) return chineseLabs.has(lab.toLowerCase()) ? 'CNY' : 'USD';
  const qualifiedId = modelId.toLowerCase().split('/');
  const name = qualifiedId.at(-1) ?? '';
  const chinese = chineseLabs.has(qualifiedId[0] ?? '') || chineseModelId.test(name)
    || (qualifiedId.length === 1 && chineseStandaloneId.test(name));
  return chinese ? 'CNY' : 'USD';
}

function parseRates(value: unknown): TokenRates | undefined {
  if (!isRecord(value) || !isAmount(value.input) || !isAmount(value.output)) return undefined;
  return {
    input: value.input,
    output: value.output,
    ...(isAmount(value.cache_read) ? { cacheRead: value.cache_read } : {}),
    ...(isAmount(value.cache_write) ? { cacheWrite: value.cache_write } : {}),
    ...(isAmount(value.reasoning) ? { reasoning: value.reasoning } : {}),
  };
}

function parseModelPrice(id: string, model: unknown): ModelPrice | undefined {
  if (!isRecord(model) || !isRecord(model.cost)) return undefined;
  const rates = parseRates(model.cost);
  if (!rates) return undefined;
  const tiers: ContextPriceTier[] = [];
  if (Array.isArray(model.cost.tiers)) {
    for (const tier of model.cost.tiers) {
      if (!isRecord(tier) || !isRecord(tier.tier) || tier.tier.type !== 'context') continue;
      const aboveInputTokens = tier.tier.size;
      const tierRates = parseRates(tier);
      if (isAmount(aboveInputTokens) && Number.isSafeInteger(aboveInputTokens) && tierRates) {
        tiers.push({ ...tierRates, aboveInputTokens });
      }
    }
  }
  tiers.sort((a, b) => b.aboveInputTokens - a.aboveInputTokens);
  return { rates, tiers, currency: modelCurrency(id, model.canonical_model_id) };
}

function parseCatalog(value: unknown): Catalog | undefined {
  if (!isRecord(value)) return undefined;
  const catalog: Catalog = new Map();
  for (const [provider, entry] of Object.entries(value)) {
    if (!isRecord(entry) || !isRecord(entry.models)) continue;
    const prices = new Map<string, ModelPrice>();
    for (const [id, model] of Object.entries(entry.models)) {
      const price = parseModelPrice(id, model);
      if (price) prices.set(id, price);
    }
    if (prices.size) catalog.set(provider, prices);
  }
  return catalog.size ? catalog : undefined;
}

function parseExchangeRate(value: unknown): number | undefined {
  if (!isRecord(value) || value.base !== 'USD' || value.quote !== 'CNY') return undefined;
  return isAmount(value.rate) && value.rate > 0 ? value.rate : undefined;
}

function refreshable<T>(load: () => Promise<T | undefined>) {
  let value: T | undefined;
  let revision = 0;
  let refreshAfter = 0;
  let inFlight: Promise<number> | undefined;
  return {
    get value() { return value; },
    refresh(): Promise<number> {
      if (Date.now() < refreshAfter) return Promise.resolve(revision);
      return inFlight ??= load().catch(() => undefined).then(next => {
        if (next !== undefined && next !== value) {
          value = next;
          revision++;
        }
        refreshAfter = Date.now() + (next === undefined ? RETRY_INTERVAL : REFRESH_INTERVAL);
        return revision;
      }).finally(() => { inFlight = undefined; });
    },
  };
}

export class PricingCatalog {
  private readonly models;
  private readonly exchange;

  constructor(fetcher: typeof fetch = fetch) {
    const get = async (url: string): Promise<unknown> => {
      const response = await fetcher(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
      return response.ok ? response.json() : undefined;
    };
    this.models = refreshable(async () => parseCatalog(await get(MODELS_URL)));
    this.exchange = refreshable(async () => parseExchangeRate(await get(EXCHANGE_URL)));
  }

  async refresh(): Promise<number> {
    const [models, exchange] = await Promise.all([this.models.refresh(), this.exchange.refresh()]);
    return models + exchange;
  }

  estimate(usage: Usage): Estimate {
    const { model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0, reasoningTokens = 0 } = usage;
    const catalog = this.models.value;
    const alias = providerAliases.get(model.provider);
    const price = catalog?.get(model.provider)?.get(model.id) ?? (alias && catalog?.get(alias)?.get(model.id));
    if (!price || !isAmount(inputTokens) || !isAmount(outputTokens) || !isAmount(cacheReadTokens)
      || !isAmount(cacheWriteTokens) || !isAmount(reasoningTokens) || reasoningTokens > outputTokens) {
      return { amount: null, currency: null };
    }
    const fresh = inputTokens - cacheReadTokens - cacheWriteTokens;
    if (fresh < 0) return { amount: null, currency: null };
    const rates = price.tiers.find(tier => inputTokens > tier.aboveInputTokens) ?? price.rates;
    const usd = (fresh * rates.input + cacheReadTokens * (rates.cacheRead ?? rates.input)
      + cacheWriteTokens * (rates.cacheWrite ?? rates.input) + (outputTokens - reasoningTokens) * rates.output
      + reasoningTokens * (rates.reasoning ?? rates.output)) / 1_000_000;
    const exchange = this.exchange.value;
    if (price.currency === 'CNY' && usd > 0 && exchange === undefined) return { amount: null, currency: null };
    const amount = price.currency === 'CNY' && exchange !== undefined ? usd * exchange : usd;
    return isAmount(amount) ? { amount, currency: price.currency } : { amount: null, currency: null };
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { Usage } from '../../../packages/dsh-flow/src/core/types.js';
import { PricingCatalog } from '../../../packages/dsh-flow/src/dashboard/pricing.js';

const modelsUrl = 'https://models.dev/api.json';
const exchangeUrl = 'https://api.frankfurter.dev/v2/rate/USD/CNY';
const exchange = { base: 'USD', quote: 'CNY', rate: 7 };
const unavailable = { amount: null, currency: null };

function usage(provider: string, id: string, counts: Partial<Usage> = {}): Usage {
  return { timestamp: 0, model: { provider, id }, inputTokens: 1_000_000, outputTokens: 1_000_000, ...counts };
}

function catalog(models: unknown, rate: unknown = exchange) {
  return new PricingCatalog(async input => {
    if (input === modelsUrl) return Response.json(models);
    assert.equal(input, exchangeUrl);
    return Response.json(rate);
  });
}

test('models.dev charges the actual provider route and uses the originating model lab for currency', async () => {
  const pricing = catalog({
    deepseek: { models: { 'deepseek-chat': { cost: { input: 1, output: 2 } } } },
    relay: { models: {
      'deepseek-chat': { canonical_model_id: 'deepseek/deepseek-chat', cost: { input: 3, output: 5 } },
      'deepseek-compatible': { canonical_model_id: 'openai/gpt-5', cost: { input: 4, output: 6 } },
      'qwen/coder': { cost: { input: 2, output: 5 } },
    } },
  });

  await pricing.refresh();
  assert.deepEqual(pricing.estimate(usage('relay', 'deepseek-chat')), { amount: 56, currency: 'CNY' });
  assert.deepEqual(pricing.estimate(usage('relay', 'deepseek-compatible')), { amount: 10, currency: 'USD' });
  assert.deepEqual(pricing.estimate(usage('relay', 'qwen/coder')), { amount: 49, currency: 'CNY' });
  assert.deepEqual(pricing.estimate(usage('deepseek-official', 'deepseek-chat')), { amount: 21, currency: 'CNY' });
  assert.deepEqual(pricing.estimate(usage('other-relay', 'deepseek-chat')), unavailable);
});

test('long-context price tiers charge uncached input, cache reads and writes, output and reasoning once', async () => {
  const pricing = catalog({ openai: { models: { chat: { cost: {
    input: 1, output: 2,
    tiers: [
      { tier: { type: 'context', size: 1_000_000 }, input: 8, output: 16, cache_read: 4, cache_write: 12, reasoning: 24 },
      { tier: { type: 'context', size: 2_000_000 }, input: 20, output: 30 },
    ],
  } } } } });

  await pricing.refresh();
  assert.deepEqual(pricing.estimate(usage('openai', 'chat')), { amount: 3, currency: 'USD' });
  assert.deepEqual(pricing.estimate(usage('openai', 'chat', {
    inputTokens: 1_500_000, cacheReadTokens: 250_000, cacheWriteTokens: 250_000, reasoningTokens: 500_000,
  })), { amount: 32, currency: 'USD' });
  assert.deepEqual(pricing.estimate(usage('openai', 'chat', { inputTokens: 2_500_000 })), { amount: 80, currency: 'USD' });
  assert.deepEqual(pricing.estimate(usage('openai', 'chat', { cacheWriteTokens: 1_000_001 })), unavailable);
  assert.deepEqual(pricing.estimate(usage('openai', 'chat', { reasoningTokens: 1_000_001 })), unavailable);
});

test('a used cache rate must be present in the selected tariff, and explicit zero is valid', async () => {
  const pricing = catalog({ openai: { models: { chat: { cost: {
    input: 1, output: 2, cache_write: 0.5,
    tiers: [{ tier: { type: 'context', size: 1_000_000 }, input: 3, output: 4, cache_read: 0 }],
  } } } } });

  await pricing.refresh();
  assert.deepEqual(pricing.estimate(usage('openai', 'chat', { cacheReadTokens: 1_000_000 })), unavailable);
  assert.deepEqual(pricing.estimate(usage('openai', 'chat', { inputTokens: 2_000_000, cacheWriteTokens: 250_000 })), unavailable);
  assert.deepEqual(pricing.estimate(usage('openai', 'chat', {
    inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 2_000_000,
  })), { amount: 0, currency: 'USD' });
  assert.deepEqual(pricing.estimate(usage('openai', 'chat')), { amount: 3, currency: 'USD' });
});

test('unavailable exchange leaves dollar and zero-priced yuan calls usable', async () => {
  const pricing = catalog({
    deepseek: { models: {
      'deepseek-free': { cost: { input: 0, output: 0 } },
      'deepseek-chat': { cost: { input: 1, output: 2 } },
    } },
    openai: { models: { chat: { cost: { input: 1, output: 2 } } } },
  }, { ...exchange, quote: 'JPY' });

  await pricing.refresh();
  assert.deepEqual(pricing.estimate(usage('deepseek', 'deepseek-chat')), unavailable);
  assert.deepEqual(pricing.estimate(usage('deepseek', 'deepseek-free')), { amount: 0, currency: 'CNY' });
  assert.deepEqual(pricing.estimate(usage('openai', 'chat')), { amount: 3, currency: 'USD' });
});

test('simultaneous pricing refreshes share requests and transient failures retain good rates', async t => {
  let now = 1;
  t.mock.method(Date, 'now', () => now);
  let offline = false;
  let requests = 0;
  const pricing = new PricingCatalog(async input => {
    requests++;
    if (offline) throw new TypeError('network unavailable');
    return input === modelsUrl
      ? Response.json({ deepseek: { models: { 'deepseek-chat': { cost: { input: 1, output: 2 } } } } })
      : Response.json(exchange);
  });
  const call = usage('deepseek', 'deepseek-chat');

  await Promise.all([pricing.refresh(), pricing.refresh()]);
  assert.equal(requests, 2);
  assert.deepEqual(pricing.estimate(call), { amount: 21, currency: 'CNY' });
  offline = true;
  now += 24 * 60 * 60 * 1_000;
  await Promise.all([pricing.refresh(), pricing.refresh()]);
  await setImmediate();
  assert.equal(requests, 4);
  assert.deepEqual(pricing.estimate(call), { amount: 21, currency: 'CNY' });
  await pricing.refresh();
  assert.equal(requests, 4);
});

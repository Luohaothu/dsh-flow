import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { initializeOmlxProfile, omlxProfileOptions } from '../../src/host/profile-models.ts';

test('editable profile initialization writes typed model fields and only a credential reference', t => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = omlxProfileOptions({ FLOW_QWEN_BASE_URL: 'http://127.0.0.1:9000/v1', FLOW_QWEN_MODEL: 'test-model', FLOW_MODEL_API_KEY: 'must-never-be-written' });
  const result = initializeOmlxProfile(dir, options);
  const source = readFileSync(result.path, 'utf8');
  assert.equal(source.includes('!!js'), false);
  assert.equal(source.includes('must-never-be-written'), false);
  const rows = parse(source);
  const provider = rows.find((row: { id: string }) => row.id === 'llm-pi-ai').config.providers.omlx;
  assert.equal(provider.baseURL, options.baseURL);
  assert.equal(provider.apiKeyEnv, 'FLOW_MODEL_API_KEY');
  assert.equal(typeof provider.models[0].contextWindow, 'number');
  assert.equal(typeof provider.models[0].maxTokens, 'number');
  assert.equal(typeof provider.models[0].id, 'string');
  assert.equal(initializeOmlxProfile(dir, options).changed, false);
});

test('initialization preserves existing providers, model selection and unrelated profile content', t => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cordis.patch.yml');
  const before = '# Keep user settings\n- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        baseURL: https://example.test/v1\n        apiKeyEnv: CUSTOM_KEY\n      omlx:\n        baseURL: http://127.0.0.1:8123/v1\n        models: [{id: user-model}]\n- id: agent-default-model\n  config: {provider: custom, model: user-choice}\n- id: other\n  config: {enabled: true}\n';
  writeFileSync(path, before);
  initializeOmlxProfile(dir, omlxProfileOptions({}));
  assert.deepEqual(parse(readFileSync(path, 'utf8')), parse(before));
  assert.match(readFileSync(path, 'utf8'), /Keep user settings/);
});

test('known oMLX profile expressions migrate completely while unsupported ones refuse without writes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cordis.patch.yml');
  const example = readFileSync(new URL('../../examples/omlx.patch.yml', import.meta.url), 'utf8');
  writeFileSync(path, example);
  initializeOmlxProfile(dir, omlxProfileOptions({ FLOW_QWEN_MODEL: 'migrated-model', FLOW_CONTEXT_MODEL: '16384' }));
  const migrated = readFileSync(path, 'utf8');
  assert.equal(migrated.includes('!!js'), false);
  assert.match(migrated, /migrated-model/);
  assert.match(migrated, /contextWindow: 16384/);
  const unsupported = example.replace("process.env.FLOW_QWEN_MODEL ?? 'Qwen3.8-27B-4bit'", 'someUserFunction()');
  writeFileSync(path, unsupported);
  assert.throws(() => initializeOmlxProfile(dir, omlxProfileOptions({})), /Unsupported model expression/);
  assert.equal(readFileSync(path, 'utf8'), unsupported);
});

test('invalid deployment values are rejected and runtime overlay cannot override editable model entries', () => {
  for (const env of [
    { FLOW_CONTEXT_MODEL: 'bad' }, { FLOW_MAX_TOKENS: '0' }, { FLOW_CONTEXT_MODEL: '128', FLOW_MAX_TOKENS: '256' },
    { FLOW_QWEN_BASE_URL: 'file:///tmp/model' }, { FLOW_QWEN_BASE_URL: 'https://user:secret@example.test/v1' },
    { FLOW_MODEL_REASONING_EFFORT: 'anything' }, { FLOW_QWEN_MODEL: ' ' },
  ]) assert.throws(() => omlxProfileOptions(env));
  const policy = readFileSync(new URL('../../examples/instance-runtime.patch.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(policy, /^- id: (?:llm-pi-ai|agent-default-model)$/m);
  assert.match(policy, /^- id: dsh-flow$/m);
});

test('missing default uses an existing oMLX model and refuses an undeclared route without writes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cordis.patch.yml');
  writeFileSync(path, '- id: llm-pi-ai\n  config:\n    providers:\n      omlx:\n        baseURL: http://127.0.0.1:8123/v1\n        models: [{id: user-model}]\n');
  initializeOmlxProfile(dir, omlxProfileOptions({}));
  assert.equal(parse(readFileSync(path, 'utf8')).find((row: { id: string }) => row.id === 'agent-default-model').config.model, 'user-model');
  const withoutModels = '- id: llm-pi-ai\n  config:\n    providers:\n      omlx: {baseURL: http://127.0.0.1:8123/v1}\n';
  writeFileSync(path, withoutModels);
  assert.throws(() => initializeOmlxProfile(dir, omlxProfileOptions({})), /no declared model/);
  assert.equal(readFileSync(path, 'utf8'), withoutModels);
});

test('model aliases cannot smuggle an expression from another namespace or mutate shared anchors', t => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cordis.patch.yml');
  for (const endpoint of ['http://127.0.0.1:8123/v1', "!!js process.env.FLOW_QWEN_BASE_URL ?? 'http://127.0.0.1:8000/v1'"]) {
    const before = `- id: other\n  config: {endpoint: &endpoint ${endpoint}}\n- id: llm-pi-ai\n  config:\n    providers:\n      omlx:\n        baseURL: *endpoint\n        models: [{id: user-model}]\n`;
    writeFileSync(path, before);
    assert.throws(() => initializeOmlxProfile(dir, omlxProfileOptions({})), /aliases/);
    assert.equal(readFileSync(path, 'utf8'), before);
  }
});

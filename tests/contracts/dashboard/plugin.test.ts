import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import { FlowPlugin } from '../../../packages/dsh-flow/src/plugin.js';
import { resolveConfig } from '../../../packages/dsh-flow/src/config.js';
import { runtime, until } from '../../helpers/contract-runtime.js';
import { enablePluginHost } from '../../helpers/contract-plugin.js';
import type { RunSnapshot, TokenResponse } from '../../../packages/dsh-flow/src/dashboard/protocol.js';

async function hosted(t: Parameters<typeof runtime>[0]) {
  const f = await runtime(t); await enablePluginHost(f.host, f.directory);
  const main = (await f.host.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'fixture', model: 'model' }, meta: { cwd: f.directory } })).agent;
  return { ...f, main };
}

test('P5 plugin exposes real authenticated projection and user Run release, then closes only owned resources', async t => {
  const f = await hosted(t), stateDirectory = join(f.directory, 'plugin');
  const plugin = await FlowPlugin.create(f.host, { stateDirectory, connection: { port: 0 } });
  t.after(() => plugin.dispose());
  const address = plugin.dashboardAddress;
  const tokenResponse = await fetch(`${address}/api/token`, { headers: { Origin: 'dsh-app://app' } });
  assert.equal(tokenResponse.status, 200);
  assert.equal(tokenResponse.headers.get('cache-control'), 'no-store');
  const token = await tokenResponse.json() as TokenResponse;
  const headers = { Authorization: `Bearer ${token.token}`, Origin: 'dsh-app://app' };
  const origin = plugin.bridge.createOrigin(f.main), run = plugin.runs.create(origin, {}, 'p5-owned');
  await until(() => run.status !== 'starting'); assert.equal(run.status, 'active');
  const response = await fetch(`${address}/api/runs/${run.id}`, { headers });
  assert.equal(response.status, 200);
  const snapshot = await response.json() as RunSnapshot;
  assert.equal(snapshot.run.epoch, token.epoch); assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.nodes[0]!.sessionID, run.root!.getProfile().sessionID);
  assert.notEqual(snapshot.nodes[0]!.id, snapshot.nodes[0]!.sessionID);
  assert.equal(snapshot.nodes[0]!.status, 'idle'); assert.ok(snapshot.run.startedAt > 0);
  const operationId = randomUUID(), body = JSON.stringify({ operationId, targetEpoch: token.epoch, scope: 'run' });
  const stopped = await fetch(`${address}/api/runs/${run.id}/stop`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body });
  assert.equal(stopped.status, 202); assert.deepEqual(await stopped.json(), { operationId, status: 'accepted' });
  await until(() => run.status === 'stopped');
  const terminal = await fetch(`${address}/api/runs/${run.id}`, { headers }).then(r => r.json()) as RunSnapshot;
  assert.equal(terminal.nodes[0]!.status, 'terminated'); assert.equal(terminal.nodes[0]!.outcome, 'stopped');
  assert.equal(terminal.nodes[0]!.termination?.initiator, 'user');
  await until(() => plugin.projector.snapshot(run.id).operations.some(op => op.id === operationId && op.status === 'completed'));
  const eventFiles = await readdir(join(stateDirectory, 'events'), { recursive: true });
  const eventText = (await Promise.all(eventFiles.filter(name => name.endsWith('.jsonl')).map(name => readFile(join(stateDirectory, 'events', name), 'utf8')))).join('\n');
  assert.ok(eventText.includes('node-appeared')); assert.ok(eventText.includes('node-terminated')); assert.ok(eventText.includes('operation-result'));
  await plugin.dispose();
  await assert.rejects(fetch(`${address}/api/runs`, { headers }));
  assert.equal(f.host.agents.get(f.main.session.id), f.main);
  assert.equal(f.main.ctx.tools.get('flow_team_create', f.main), undefined);
});

test('P5 plugin activation failure releases partial projection and allows a clean subsequent activation', async t => {
  const f = await hosted(t), stateDirectory = join(f.directory, 'plugin');
  const occupied = createServer();
  await new Promise<void>((yes, no) => { occupied.once('error', no); occupied.listen(0, '127.0.0.1', yes); });
  t.after(() => new Promise<void>((yes, no) => occupied.close(error => error ? no(error) : yes())));
  const bound = occupied.address(); assert.ok(bound && typeof bound !== 'string');
  await assert.rejects(FlowPlugin.create(f.host, { stateDirectory, connection: { port: bound.port } }), { code: 'EADDRINUSE' });
  assert.equal(f.main.ctx.tools.get('flow_team_create', f.main), undefined);
  const plugin = await FlowPlugin.create(f.host, { stateDirectory }); t.after(() => plugin.dispose());
  assert.ok(f.main.ctx.tools.get('flow_team_create', f.main));
  const invalidState = join(f.directory, 'invalid-state'); await mkdir(invalidState);
  await writeFile(join(invalidState, 'events'), 'not a journal directory');
  await assert.rejects(FlowPlugin.create(f.host, { stateDirectory: invalidState }));
  await plugin.dispose(); assert.equal(f.host.agents.get(f.main.session.id), f.main);
});

test('P5 model prices are explicit per-model rates, reject ambiguous duplicate and malformed entries', () => {
  const price = { model: { provider: 'fixture', id: 'model' }, currency: 'USD', input: 2, output: 8, cacheRead: 0.2 };
  const configuration = resolveConfig({ connection: { port: 0, prices: [price] } });
  price.model.id = 'mutated'; assert.equal(configuration.connection.prices![0]!.model.id, 'model');
  assert.throws(() => resolveConfig({ connection: { prices: [price, price] } }), /unique/);
  for (const input of [Infinity, NaN, -1]) assert.throws(() => resolveConfig({ connection: { prices: [{ ...price, input }] } }));
  assert.throws(() => resolveConfig({ connection: { prices: { model: 1 } } } as never));
  assert.throws(() => resolveConfig({ connection: { prices: [{ ...price, currency: '' }] } }));
});

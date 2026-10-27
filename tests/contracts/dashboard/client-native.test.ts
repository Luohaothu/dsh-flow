import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model';
import { SessionId } from '@deepseek-ai/dsh-session';
import { DshNativeBridge } from '../../../packages/dsh-flow/src/host/native-bridge.js';
import { RunService } from '../../../packages/dsh-flow/src/run/run.js';
import { RunStore } from '../../../packages/dsh-flow/src/run/store.js';
import { runState } from '../../../packages/dsh-flow/src/run/internal.js';
import { PatternCatalog } from '../../../packages/dsh-flow/src/patterns/catalog.js';
import { DashboardProjector } from '../../../packages/dsh-flow/src/dashboard/projector.js';
import { DashboardServer } from '../../../packages/dsh-flow/src/dashboard/server.js';
import { DashboardClient, DashboardRequestError } from '../../../packages/dsh-flow/src/dashboard/client.js';
import { input, runtime, until, validSummary } from '../../helpers/contract-runtime.js';

test('actual SDK model calls and herb settlements cross authenticated DashboardServer SSE without duplicate charges', async t => {
  const f = await runtime(t); await f.host.plugin(AgentDefaultModel, { provider: 'fixture', model: 'model', reasoningEffort: 'medium' });
  const catalog = new PatternCatalog({ includeBuiltins: false });
  const bridge = new DshNativeBridge(f.host, { stateDirectory: join(f.directory, 'native'), catalog });
  const service = new RunService({ store: new RunStore(join(f.directory, 'runs')), patternCatalog: catalog, patternRoleProvisioner: bridge,
    getOriginDefaults: origin => bridge.getOriginDefaults(origin), initialize: (...args) => bridge.initialize(...args), validateMaterials: request => bridge.validateMaterials(request) });
  bridge.attachRunService(service);
  const projector = new DashboardProjector(service, { directory: join(f.directory, 'journals') });
  const server = await DashboardServer.create({ projector, service, port: 0 });
  const client = new DashboardClient({ baseUrl: server.address, origin: 'dsh-app://app', reconnectDelayMs: 1 });
  t.after(async () => { client.dispose(); await server.dispose(); projector.dispose(); await bridge.dispose().catch(() => {}); });
  const ordinary = await f.host.agents.create({ sessionId: SessionId('dashboard-origin'), meta: { cwd: f.directory }, agentOptions: { provider: 'fixture', model: 'model' } });
  const team = service.create(bridge.createOrigin(ordinary.agent), {}, 'native-client'); await runState(team).initialization;
  assert.equal(team.status, 'active'); assert.ok(team.root);
  await client.selectRun(team.id);
  const root = team.root, binding = bridge.bindings.get(root); assert.ok(binding);
  root.recvMessage(input('actual model execution')); await binding.native.whenIdle();
  await until(() => (client.getState().snapshot?.nodes[0]?.usage.length ?? 0) === 1);
  const main = client.getState().snapshot!.nodes[0]!.usage[0]!;
  assert.equal(main.kind, 'main'); assert.equal(main.totalTokens, 20); assert.equal(main.amount, null); assert.ok(main.callId);
  const other = await root.fork();
  f.model.script = () => validSummary;
  const child = await root.herb(other);
  await until(() => client.getState().snapshot!.nodes.some(node => node.sessionID === child.getProfile().sessionID && node.usage.filter(item => item.kind === 'auxiliary').length === 3));
  const childNode = client.getState().snapshot!.nodes.find(node => node.sessionID === child.getProfile().sessionID)!;
  assert.equal(new Set(childNode.usage.filter(item => item.kind === 'auxiliary').map(item => item.callId)).size, 3);
  assert.equal(client.getState().snapshot!.nodes.find(node => node.sessionID === root.getProfile().sessionID)!.usage.filter(item => item.kind === 'auxiliary').length, 0);
  await client.stop(team.id, { operationId: 'native-release', targetEpoch: service.epoch, scope: 'run' });
  await until(() => client.getState().snapshot?.operations.some(operation => operation.id === 'native-release' && operation.status === 'completed') === true);
  assert.ok(client.getState().snapshot!.nodes.every(node => node.cleanup?.phase === 'complete'));
});

test('actual failed missing-instance stop survives SSE and a 401-driven snapshot reconnect', async t => {
  const { runFixture } = await import('../../helpers/contract-run.js');
  const f = await runFixture(t), projector = new DashboardProjector(f.service, { directory: join(f.directory, 'events') });
  const team = await f.createActive(), server = await DashboardServer.create({ projector, service: f.service, port: 0, tokenLifetimeMs: 300 });
  let runStream: AbortController | undefined, tokens = 0, snapshots = 0, stops = 0;
  const client = new DashboardClient({ baseUrl: server.address, origin: 'dsh-app://app', reconnectDelayMs: 1, fetch: (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/token') tokens++;
    if (path.endsWith('/stop')) stops++;
    if (path === `/api/runs/${team.id}`) snapshots++;
    if (path === `/api/runs/${team.id}/events`) {
      runStream = new AbortController();
      return fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, runStream.signal]) : runStream.signal });
    }
    return fetch(url, init);
  } });
  try {
    await client.selectRun(team.id); await until(() => runStream !== undefined);
    assert.deepEqual(await client.stop(team.id, { operationId: 'missing-instance-stop', targetEpoch: f.service.epoch, agentId: 'missing-instance' }), { operationId: 'missing-instance-stop', status: 'accepted' });
    await until(() => client.getState().snapshot?.operations.some(operation => operation.id === 'missing-instance-stop' && operation.status === 'failed') === true);
    assert.equal(client.getState().snapshot!.operations.find(operation => operation.id === 'missing-instance-stop')!.error, 'Unknown Agent instance');
    const beforeConflict = stops, beforeSnapshots = snapshots;
    await assert.rejects(client.stop(team.id, { operationId: 'missing-instance-stop', targetEpoch: f.service.epoch, scope: 'run' }), error =>
      error instanceof DashboardRequestError && error.status === 409 && error.code === 'operation-conflict' && error.message === 'Operation ID was reused with a different target');
    assert.equal(stops, beforeConflict + 1); assert.equal(snapshots, beforeSnapshots);
    await assert.rejects(client.stop('missing-run', { operationId: 'missing-run-stop', targetEpoch: f.service.epoch, scope: 'run' }), error =>
      error instanceof DashboardRequestError && error.status === 404 && error.code === 'run-unavailable' && error.message === 'Run is unavailable');
    await new Promise(resolve => setTimeout(resolve, 350)); runStream!.abort();
    await until(() => tokens >= 2 && snapshots >= 2 && client.getState().runConnection === 'connected');
    const view = client.getState().snapshot!;
    assert.equal(view.run.id, team.id); assert.equal(view.nodes.length, 1);
    assert.equal(view.operations.find(operation => operation.id === 'missing-instance-stop')!.status, 'failed');
    assert.deepEqual(view.operations.find(operation => operation.id === 'missing-instance-stop')!.target, { agentId: 'missing-instance' });
    assert.equal(view.operations.find(operation => operation.id === 'missing-instance-stop')!.error, 'Unknown Agent instance');
    await client.stop(team.id, { operationId: 'release-after-failed-stop', targetEpoch: f.service.epoch, scope: 'run' });
    await until(() => client.getState().snapshot?.operations.some(operation => operation.id === 'release-after-failed-stop' && operation.status === 'completed') === true);
  } finally { client.dispose(); await server.dispose(); projector.dispose(); }
});

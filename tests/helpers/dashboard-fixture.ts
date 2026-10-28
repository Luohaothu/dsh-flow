import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Agent, Group } from '../../packages/dsh-flow/src/core/index.js';
import { describeWait } from '../../packages/dsh-flow/src/core/message.js';
import { getAgentInstanceId } from '../../packages/dsh-flow/src/core/observation.js';
import { agentControl } from '../../packages/dsh-flow/src/core/internals.js';
import { RunService, type Run } from '../../packages/dsh-flow/src/run/run.js';
import { RunStore } from '../../packages/dsh-flow/src/run/store.js';
import { withTrustedCall } from '../../packages/dsh-flow/src/assignments/internal.js';
import { issueHostOrigin } from '../../packages/dsh-flow/src/run/internal.js';
import { PatternCatalog } from '../../packages/dsh-flow/src/patterns/catalog.js';
import { DashboardProjector } from '../../packages/dsh-flow/src/dashboard/projector.js';
import { DashboardServer } from '../../packages/dsh-flow/src/dashboard/server.js';
import { ContractHost, message, profile } from './contract-host.js';
import { ContractPatternRoleProvisioner } from './contract-patterns.js';
import { waitFor, spec } from './contract-run.js';

export async function createDashboardFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'flow-dashboard-browser-'));
  const bindings = new Map<Run, { host: ContractHost; root: Agent }>();
  let serial = 0;
  const service = new RunService({ store: new RunStore(join(directory, 'runs')), patternCatalog: new PatternCatalog({ includeBuiltins: false }),
    patternRoleProvisioner: new ContractPatternRoleProvisioner(),
    getOriginDefaults: () => ({ model: { provider: 'contract', id: 'model-a' }, permission: 'workspace-write', params: { version: 1 } }),
    initialize: async (_run, defaults, context) => {
      const host = new ContractHost(); context.registerHostAdaptor(host);
      const index = serial++;
      const root = await Agent.create(context, profile(`browser-root-${index}`, { name: index ? '项目协调者' : '资料分析团队', role: '组织团队完成事实核验，检查来源并统筹多个正式作业。', model: defaults.model!, permission: defaults.permission! }), null);
      bindings.set(_run, { host, root }); return root;
    } });
  const projector = new DashboardProjector(service, { directory: join(directory, 'events'), prices: [{ model: { provider: 'contract', id: 'model-a' }, currency: 'USD', input: 2, output: 8, cacheRead: 0.2 }] });
  const origin = issueHostOrigin({ backend: 'browser-fixture', callerSessionId: 'origin-main' });
  const run = service.create(origin, {}, 'browser-first'); await waitFor(() => run.status === 'active');
  const { root, host } = bindings.get(run)!;
  const research = await Agent.create(run.context!, profile('browser-research', { name: '资料研究员', role: '检索公开材料，标注来源与不确定性。' }), root);
  const reviewer = await Agent.create(run.context!, profile('browser-review', { name: '审查员', role: '独立审核证据与推理，指出遗漏和冲突。' }), root);
  const child = await Agent.create(run.context!, profile('browser-crosscheck', { name: '交叉核验员', role: '交叉核验不同来源的结论。' }), research);
  const group = new Group(run.context!, [research, reviewer]);
  const submitted = await service.assign(origin, run, spec({ name: '公开资料核验', resultSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } }), 'initial-assignment');
  await withTrustedCall({ actor: root, transportKey: 'browser-initial-submission' }, () => run.assignments!.submit(root, run.assignments!.resolve(submitted.id), { result: { answer: '已有资料核验完成，团队继续保留。' }, continuingChildren: [] }));
  host.turnEnd(root); host.status(root, 'idle');
  await service.assign(origin, run, spec({ name: '第二份并行作业' }), 'second-assignment');
  research.recvMessage(message('已有收件箱消息不会在加载时重新播放投递。', root, Date.now()));
  host.turnEnd(research); host.status(research, 'idle');
  host.emit({ type: 'usage', agent: host.native(root), timestamp: Date.now(), usage: { callId: 'browser-main', kind: 'main', model: root.getProfile().model, timestamp: Date.now(), inputTokens: 2400, outputTokens: 600, cacheReadTokens: 400, totalTokens: 3000 } });
  await group.postToBlackboard(research, message('已确认来源', research, Date.now(), { sources: ['公开文档'], confidence: '核验中' }));
  const other = service.create(origin, {}, 'browser-other'); await waitFor(() => other.status === 'active');
  const actors = { root, research, reviewer, child };
  let server: DashboardServer | undefined = await DashboardServer.create({ projector, service, staticDirectory: resolve('packages/dsh-flow/web') });
  const address = server.address, port = Number(new URL(address).port);
  const control = createServer((request, response) => { void (async () => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    const command = url.pathname.slice(1), actor = actors[(url.searchParams.get('actor') ?? 'research') as keyof typeof actors];
    if (!actor) throw new Error('Unknown fixture actor');
    if (command === 'message') actor.recvMessage(message(url.searchParams.get('text') ?? '实时收到一条新资料。', reviewer, Date.now()));
    else if (command === 'wait') { host.turnEnd(actor); host.status(actor, 'idle'); actor.wait(describeWait(() => false, '等待正式交付与补充材料'), 30_000); }
    else if (command === 'blackboard') await group.postToBlackboard(research, message('实时追加黑板', research, Date.now(), { verified: true }));
    else if (command === 'transfer') research.transfer(child, reviewer);
    else if (command === 'fail') { host.emit({ type: 'error', agent: host.native(child), timestamp: Date.now(), message: '用于界面验收的明确错误' }); await child[agentControl].release('SIGKILL', 'self'); }
    else if (command === 'deep') { let parent = research; for (let i = 0; i < 12; i++) parent = await Agent.create(run.context!, profile(`deep-${i}`, { name: `深层成员 ${i + 1}` }), parent); }
    else if (command === 'offline') { await server?.dispose(); server = undefined; }
    else if (command === 'online') { server ??= await DashboardServer.create({ projector, service, port, staticDirectory: resolve('packages/dsh-flow/web') }); }
    else if (command !== 'snapshot') throw new Error('Unknown fixture command');
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(projector.snapshot(run.id)));
  })().catch(error => { response.writeHead(500); response.end(String(error)); }); });
  control.listen(0, '127.0.0.1'); await new Promise<void>(resolve => control.once('listening', resolve));
  const bound = control.address(); if (!bound || typeof bound === 'string') throw new Error('Control did not bind');
  return { address, controlAddress: `http://127.0.0.1:${bound.port}`, runId: run.id, otherRunId: other.id,
    instances: Object.fromEntries(Object.entries(actors).map(([name, actor]) => [name, getAgentInstanceId(actor)])),
    async dispose() { control.closeAllConnections(); await new Promise<void>((yes, no) => control.close(error => error ? no(error) : yes())); await server?.dispose(); await Promise.all([service.release(origin, run), service.release(origin, other)]); projector.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

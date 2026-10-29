import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model';
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import { getTraceable } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Presets from '@deepseek-ai/dsh-agent-preset-registry';
import { createUserMessage, fileHandleText, ReasoningEffortId, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { DshNativeBridge } from '../../../packages/dsh-flow/src/host/native-bridge.js';
import { NativeMaterials, renderMaterial } from '../../../packages/dsh-flow/src/host/materials.js';
import { PatternCatalog } from '../../../packages/dsh-flow/src/patterns/catalog.js';
import { RunService } from '../../../packages/dsh-flow/src/run/run.js';
import { RunStore } from '../../../packages/dsh-flow/src/run/store.js';
import { runState } from '../../../packages/dsh-flow/src/run/internal.js';
import { Agent } from '../../../packages/dsh-flow/src/core/agent.js';
import { newSessionID } from '../../../packages/dsh-flow/src/core/message.js';
import { runtime } from '../../helpers/contract-runtime.js';

class UnmappedExecutionWorld extends LocalFileSystem { override processPathFromHostPath(): undefined { return undefined; } }
class VirtualExecutionWorld extends LocalFileSystem {
  rejectHostPaths = true;
  override processPathFromHostPath(path: string): string { return `/virtual${path}`; }
  override resolve(path: string, options?: Parameters<LocalFileSystem['resolve']>[1]) {
    if (path.startsWith('/virtual/')) return super.resolve(path.slice('/virtual'.length), options);
    if (this.rejectHostPaths && path.includes('/attachments/')) return Promise.reject(new Error('Host attachment path is not available in this execution world'));
    return super.resolve(path, options);
  }
}
async function fixture(t: Parameters<typeof runtime>[0], unmapped = false, virtual = false) {
  const f = await runtime(t, unmapped ? { filesystem: UnmappedExecutionWorld } : {});
  await f.host.plugin(AgentDefaultModel, { provider: 'fixture', model: 'model', reasoningEffort: 'medium' });
  await f.host.plugin(AttachmentLocal, { dshHome: join(f.directory, 'native-home') });
  if (virtual) {
    await f.host.plugin(Loader); await f.host.plugin(Presets, { default: 'virtual-materials' });
    f.host.loader.builtins.material_virtual_fs = VirtualExecutionWorld;
    await f.host.agentPresets.register({ id: 'virtual-materials', plugins: [{ name: 'cordis:material_virtual_fs', config: { cwd: f.directory }, isolate: { fs: 'material-virtual' } }] });
  }
  const catalog = new PatternCatalog({ includeBuiltins: false }), stateDirectory = join(f.directory, 'bridge');
  const bridge = new DshNativeBridge(f.host, { stateDirectory, catalog, ...(virtual ? { getConfiguration: () => ({ defaults: { preset: 'virtual-materials' } }) } : {}) });
  const service = new RunService({ store: new RunStore(join(f.directory, 'runs')), patternCatalog: catalog, patternRoleProvisioner: bridge,
    getOriginDefaults: origin => bridge.getOriginDefaults(origin), initialize: (...args) => bridge.initialize(...args), validateMaterials: request => bridge.validateMaterials(request) });
  bridge.attachRunService(service); t.after(() => bridge.dispose().catch(() => {}));
  const main = (await f.host.agents.create({ sessionId: SessionId('materials-main'), meta: { cwd: f.directory }, agentOptions: { provider: 'fixture', model: 'model', reasoningEffort: ReasoningEffortId('medium') } })).agent;
  const origin = bridge.createOrigin(main), run = service.create(origin, {}, 'materials-run'); await runState(run).initialization;
  assert.equal(run.status, 'active', service.read(origin, run).error); const root = run.root!;
  const spec = (materials: Awaited<ReturnType<typeof bridge.materials.admitSession>>) => ({ name: 'material task', type: 'test', background: '', requirements: 'read', acceptanceCriteria: 'readable', resultSchema: true, materials });
  const admit = async (content: ContentBlock[]) => {
    main.followup(createUserMessage({ source: { kind: 'user' }, content })); await main.whenIdle();
    return bridge.materials.admitSession(main);
  };
  return { ...f, bridge, service, main, run, root, origin, spec, admit, stateDirectory };
}

test('material provenance rejects forged strings and cross-origin grants; committed assignment grants survive reading and directory reconstruction', async t => {
  const f = await fixture(t), refs = await f.admit([{ type: 'text', text: '真正的输入资料' }]);
  const material = refs[0]!;
  await assert.rejects(f.service.assign(f.origin, f.run, f.spec([{ ...material, location: '/invented' }]), 'forged'), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /altered/);
    assert.ok(error.message.includes(`material ${material.id}; changed fields: location`));
    assert.match(error.message, /flow_team_get or flow_team_read/);
    assert.ok(!error.message.includes(material.digest));
    assert.ok(!error.message.includes(material.location));
    return true;
  });
  assert.equal(f.run.assignments!.list(f.run).length, 0);
  await assert.rejects(f.service.assign(f.origin, f.run, f.spec([{ ...material, id: 'forged' }]), 'forged-id'), /Unknown/);
  const stranger = (await f.host.agents.create({ sessionId: SessionId('stranger'), meta: { cwd: f.directory }, agentOptions: { provider: 'fixture', model: 'model' } })).agent;
  const strangerOrigin = f.bridge.createOrigin(stranger), other = f.service.create(strangerOrigin, {}, 'other'); await runState(other).initialization;
  await assert.rejects(f.service.assign(strangerOrigin, other, f.spec(refs), 'stolen'), /not admitted/);
  const prepared = await f.run.assignments!.prepare({ sender: f.run, recipient: f.root, parentAssignment: null, spec: f.spec(refs) }, 'real');
  assert.deepEqual((await f.bridge.materials.read(f.root, material.id)).content, [{ type: 'text', text: '真正的输入资料' }]);
  f.run.assignments!.deliver(prepared); await f.native(f.root).whenIdle();
  const value = await f.bridge.materials.read(f.root, material.id);
  [...f.root.getMailbox().getUnread()];
  assert.deepEqual(renderMaterial(value), [{ type: 'text', text: '真正的输入资料' }]);
  const reconstructed = new NativeMaterials(f.host, f.bridge.bindings, join(f.stateDirectory, 'materials'));
  assert.deepEqual(await reconstructed.read(f.root, material.id), value);
  const child = await Agent.create(f.run.context!, { ...f.root.getProfile(), sessionID: newSessionID(), name: 'child' }, f.root);
  const handle = await f.run.assignments!.prepare({ sender: f.root, recipient: child, parentAssignment: prepared, spec: f.spec(refs) }, 'child');
  f.run.assignments!.deliver(handle); await f.native(child).whenIdle();
  assert.deepEqual((await reconstructed.read(child, material.id)).content, value.content);
  await f.bridge.dispose();
});

test('actual local file and image storage retain original Native ContentBlocks and recheck corruption on read', async t => {
  const f = await fixture(t);
  const file = await f.host.attachments.saveFile({ data: Buffer.from('original file\n'), name: 'source.txt' });
  const image = await f.host.attachments.saveImage({ data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64'), mediaType: 'image/png', name: 'image.png' });
  const refs = await f.admit([{ type: 'file', attachment: file }, { type: 'image', attachment: image }]);
  const fileRef = refs.find(ref => ref.sourceId === file.attachmentId)!, imageRef = refs.find(ref => ref.sourceId === image.attachmentId)!;
  let readStep = 0;
  f.model.script = () => readStep++ === 0 ? { tool: 'flow_material_read', args: { materialId: fileRef.id } }
    : readStep === 2 ? { tool: 'flow_material_read', args: { materialId: imageRef.id } } : 'DONE';
  const assigned = await f.service.assign(f.origin, f.run, f.spec(refs), 'files'); await f.native(f.root).whenIdle();
  assert.equal(assigned.status, 'pending');
  const expectedHandle = fileHandleText(file, f.host.fs.processPathFromHostPath(f.host.attachments.fileHostPath(file)!));
  const nextRequest = f.model.requests.at(-1)!;
  assert.ok(nextRequest.messages.some(message => message.content.some(block => block.type === 'text' && block.text === expectedHandle)));
  assert.ok(nextRequest.messages.some(message => message.content.some(block => block.type === 'image' && block.attachment.attachmentId === image.attachmentId)));
  assert.deepEqual(renderMaterial(await f.bridge.materials.read(f.root, fileRef.id)), [{ type: 'file', attachment: file }]);
  assert.deepEqual(renderMaterial(await f.bridge.materials.read(f.root, imageRef.id)), [{ type: 'image', attachment: image }]);
  const handle = f.host.llm.fileRequestText(file);
  assert.match(handle, /source\.txt/); assert.match(handle, /original|path|只读|read/i);
  await chmod(f.host.attachments.fileHostPath(file)!, 0o600); await writeFile(f.host.attachments.fileHostPath(file)!, 'corrupt');
  await assert.rejects(f.bridge.materials.read(f.root, fileRef.id), /digest|integrity|corrupt|size|mismatch/i);
  await rm(f.host.attachments.imageHostPath(image)!);
  await assert.rejects(f.bridge.materials.read(f.root, imageRef.id));
  await f.bridge.dispose();
});

test('material prepare and read verify the actual shared-loop file handle in a recipient virtual filesystem', async t => {
  const f = await fixture(t, false, true), native = f.native(f.root);
  const file = await f.host.attachments.saveFile({ data: Buffer.from('virtual source'), name: 'virtual-source.txt' });
  const refs = await f.admit([{ type: 'file', attachment: file }]);
  const fs = f.host.agentPresets.serviceFor(native, 'fs'); assert.ok(fs instanceof VirtualExecutionWorld);
  await assert.rejects(f.service.assign(f.origin, f.run, f.spec(refs), 'incompatible-file'), /Host attachment path|shared.loop/i);
  assert.equal(f.run.assignments!.list(f.run).length, 0);
  fs.rejectHostPaths = false;
  await f.service.assign(f.origin, f.run, f.spec(refs), 'compatible-file'); await native.whenIdle();
  const value = await f.bridge.materials.read(f.root, refs[0]!.id);
  assert.equal(value.presentedLocation, f.host.fs.processPathFromHostPath(refs[0]!.location));
  assert.deepEqual(value.content, [{ type: 'file', attachment: file }]);
  fs.rejectHostPaths = true;
  await assert.rejects(f.bridge.materials.read(f.root, refs[0]!.id), /Host attachment path|shared.loop/i);
  await f.bridge.dispose();
});

test('image material prepare and read enforce the shared-loop readonly path against the recipient execution world', async t => {
  const f = await fixture(t, false, true), native = f.native(f.root);
  const image = await f.host.attachments.saveImage({ data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64'), mediaType: 'image/png' });
  const refs = await f.admit([{ type: 'image', attachment: image }]);
  await assert.rejects(f.service.assign(f.origin, f.run, f.spec(refs), 'incompatible-image'), /Host attachment path/);
  assert.equal(f.run.assignments!.list(f.run).length, 0);
  const fs = f.host.agentPresets.serviceFor(native, 'fs'); assert.ok(fs instanceof VirtualExecutionWorld); fs.rejectHostPaths = false;
  await f.service.assign(f.origin, f.run, f.spec(refs), 'compatible-image'); await native.whenIdle();
  const value = await f.bridge.materials.read(f.root, refs[0]!.id);
  assert.deepEqual(value.content, [{ type: 'image', attachment: image }]); assert.equal(value.presentedLocation, f.host.fs.processPathFromHostPath(refs[0]!.location));
  fs.rejectHostPaths = true; await assert.rejects(f.bridge.materials.read(f.root, refs[0]!.id), /Host attachment path/);
  await f.bridge.dispose();
});

test('prepare rejects explicit text-only and unknown image model capabilities before saving', async t => {
  const f = await fixture(t);
  const image = await f.host.attachments.saveImage({ data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64'), mediaType: 'image/png' });
  const refs = await f.admit([{ type: 'image', attachment: image }]);
  f.model.inputModalities = ['text'];
  await assert.rejects(f.service.assign(f.origin, f.run, f.spec(refs), 'text-only'), /does not support/);
  f.model.inputModalities = undefined;
  await assert.rejects(f.service.assign(f.origin, f.run, f.spec(refs), 'unknown'), /unknown/);
  assert.equal(f.run.assignments!.list(f.run).length, 0);
  await f.bridge.dispose();
});

test('recipient backend mapping is authoritative and never falls back to host filesystem reads', async t => {
  const f = await fixture(t, true);
  const file = await f.host.attachments.saveFile({ data: Buffer.from('file data'), name: 'file.txt' });
  const refs = await f.admit([{ type: 'file', attachment: file }]);
  await assert.rejects(f.service.assign(f.origin, f.run, f.spec(refs), 'unmapped'), /cannot be mapped/);
  assert.equal(f.run.assignments!.list(f.run).length, 0);
  await f.bridge.dispose();
});

test('a successful real native file-producing tool is discoverable and can be handed to a child under the current parent assignment', async t => {
  const f = await fixture(t);
  const child = await Agent.create(f.run.context!, { ...f.root.getProfile(), sessionID: newSessionID(), name: 'artifact child', role: 'artifact recipient role' }, f.root);
  const native = f.native(f.root);
  native.ctx.tools.register({ name: 'produce_artifact', description: 'Write the actual task artifact.', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'file', attachment: (value as unknown as { file: Awaited<ReturnType<typeof f.host.attachments.saveFile>> }).file }] },
    async execute(_args, execution) {
      assert.equal(execution.agent, native);
      const fs = getTraceable(native.ctx, native.ctx.get('fs')!);
      const path = await fs.resolve(join(f.directory, 'task-result.txt'));
      await fs.writeText(path, 'real generated result');
      const bytes = await fs.readBytes(path, execution.signal, 1000);
      return { file: await f.host.attachments.saveFile({ data: bytes, name: 'task-result.txt' }) };
    } });
  const top = await f.run.assignments!.prepare({ sender: f.run, recipient: f.root, parentAssignment: null, spec: f.spec([]) }, 'producer-task');
  let step = 0, selectedId = '';
  f.model.script = options => {
    if (options.system?.includes('artifact recipient role')) return 'DONE';
    if (step++ === 0) return { tool: 'produce_artifact', args: {} };
    if (step === 2) return { tool: 'flow_team_read', args: {} };
    if (step === 3) {
      const event = [...native.session.snapshotEvents()].reverse().find(event => event.type === 'tool/result');
      assert.equal(event?.type, 'tool/result'); if (event?.type !== 'tool/result') throw new Error('missing material index');
      const index = JSON.parse(event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''));
      const material = index.materials.find((ref: { location: string }) => ref.location.endsWith('task-result.txt')); assert.ok(material); selectedId = material.id;
      return { tool: 'flow_assign', args: { recipientSessionID: child.getProfile().sessionID, parentAssignmentId: top.id, spec: f.spec([material]), requestId: 'artifact-child' } };
    }
    return 'DONE';
  };
  f.run.assignments!.deliver(top); await native.whenIdle(); await f.native(child).whenIdle();
  const assignments = f.run.assignments!.list(f.run); assert.equal(assignments.length, 2, JSON.stringify(native.session.snapshotEvents().filter(event => event.type === 'tool/result' || event.type === 'tool/call')));
  assert.deepEqual((await f.bridge.materials.read(child, selectedId)).content[0]?.type, 'file');
  const childIndex = await f.bridge.materials.available(child); assert.equal(childIndex.length, 1); assert.equal(childIndex[0]!.id, selectedId);
  const sourceIndex = await f.bridge.materials.available(f.root); assert.ok(sourceIndex.some(material => material.id === selectedId));
  await f.bridge.dispose();
});

test('material admission publishes no cached reference after a failed actual durable write and retries only after storage recovers', async t => {
  const f = await fixture(t), directory = join(f.directory, 'blocked-index');
  f.main.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'durable source' }] })); await f.main.whenIdle();
  const materials = new NativeMaterials(f.host, f.bridge.bindings, directory);
  await mkdir(directory); await chmod(directory, 0o500);
  try {
    await assert.rejects(materials.admitSession(f.main), { code: 'EACCES' });
    await assert.rejects(materials.admitSession(f.main), { code: 'EACCES' });
    assert.deepEqual(await readdir(directory), []);
  } finally { await chmod(directory, 0o700); }
  const admitted = await materials.admitSession(f.main); assert.equal(admitted.length, 1);
  assert.deepEqual(await readdir(directory), [`${admitted[0]!.id}.json`]);
  const reconstructed = new NativeMaterials(f.host, f.bridge.bindings, directory);
  assert.deepEqual(await reconstructed.admitSession(f.main), admitted);
  await f.bridge.dispose();
});

test('failed material publication rename removes its temporary file and leaves no cached success', async t => {
  const f = await fixture(t);
  const refs = await f.admit([{ type: 'text', text: 'rename source' }]), ref = refs[0]!, directory = join(f.directory, 'rename-index');
  await mkdir(join(directory, `${ref.id}.json`), { recursive: true });
  const materials = new NativeMaterials(f.host, f.bridge.bindings, directory);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(materials.admitSession(f.main));
    assert.deepEqual(await readdir(directory), [`${ref.id}.json`]);
  }
  await rm(join(directory, `${ref.id}.json`), { recursive: true });
  assert.deepEqual(await materials.admitSession(f.main), refs);
  assert.deepEqual(await readdir(directory), [`${ref.id}.json`]);
  await f.bridge.dispose();
});

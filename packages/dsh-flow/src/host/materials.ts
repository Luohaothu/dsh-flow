import { getTraceable, type Context as DshContext } from '@deepseek-ai/cordis';
import type { Agent as NativeAgent } from '@deepseek-ai/dsh-agent';
import type { CommandInvocation } from '@deepseek-ai/dsh-commands';
import { fileHandleText, resolveImageAttachmentAccess, type ContentBlock, type FileBlock, type ImageBlock } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from '../core/agent.js';
import { agentControl } from '../core/internals.js';
import { Run } from '../run/run.js';
import { contextRun, runState } from '../run/internal.js';
import type { AssignmentMaterialRequest } from '../run/types.js';
import { digestJson } from '../assignments/schema.js';
import type { MaterialRef } from '../assignments/types.js';
import type { NativeFlowBindings } from './native-bindings.js';

type MaterialBlock = { type: 'text'; text: string } | ImageBlock | FileBlock;
interface MaterialSource { version: 1; sessionId: string; eventId: string; block: MaterialBlock; ref: MaterialRef }
export interface MaterialValue { material: MaterialRef; content: MaterialBlock[]; presentedLocation?: string }
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown): boolean => digestJson(a) === digestJson(b);
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fields(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function positive(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function materialBlock(value: unknown): value is MaterialBlock {
  if (!record(value)) return false;
  if (value.type === 'text') return fields(value, ['type', 'text']) && typeof value.text === 'string';
  if (!['image', 'file'].includes(value.type as string) || !fields(value, value.type === 'image' ? ['type', 'attachment', 'offloaded'] : ['type', 'attachment'])
    || value.type === 'image' && Object.hasOwn(value, 'offloaded') && value.offloaded !== true || !record(value.attachment)) return false;
  const attachment = value.attachment;
  if (typeof attachment.attachmentId !== 'string' || !attachment.attachmentId || typeof attachment.bytes !== 'number' || !Number.isSafeInteger(attachment.bytes) || attachment.bytes < 0) return false;
  if (value.type === 'file') return fields(attachment, ['attachmentId', 'name', 'bytes']) && typeof attachment.name === 'string';
  return fields(attachment, ['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name', 'originalDimensions'])
    && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.mediaType as string)
    && positive(attachment.width) && positive(attachment.height) && (!Object.hasOwn(attachment, 'name') || typeof attachment.name === 'string')
    && (!Object.hasOwn(attachment, 'originalDimensions') || record(attachment.originalDimensions) && fields(attachment.originalDimensions, ['width', 'height']) && positive(attachment.originalDimensions.width) && positive(attachment.originalDimensions.height));
}
function decodeSource(value: unknown): MaterialSource {
  if (!record(value) || !fields(value, ['version', 'sessionId', 'eventId', 'block', 'ref']) || value.version !== 1
    || typeof value.sessionId !== 'string' || !value.sessionId || typeof value.eventId !== 'string' || !value.eventId || !materialBlock(value.block)
    || !record(value.ref) || !fields(value.ref, ['id', 'sourceId', 'digest', 'location', 'mediaType'])) throw new Error('Invalid material provenance');
  const ref = value.ref;
  if (![ref.id, ref.sourceId, ref.digest, ref.location, ref.mediaType].every(field => typeof field === 'string' && !!field)
    || !/^[a-f0-9]{64}$/.test(ref.digest as string) || ref.id !== sha(JSON.stringify([value.sessionId, value.eventId, value.block]))) throw new Error('Invalid material provenance');
  const block = value.block;
  if (ref.sourceId !== (block.type === 'text' ? `${value.sessionId}:${value.eventId}` : block.attachment.attachmentId)
    || ref.mediaType !== (block.type === 'text' ? 'text/plain' : block.type === 'image' ? block.attachment.mediaType : 'application/octet-stream')) throw new Error('Invalid material source identity');
  return { version: 1, sessionId: value.sessionId, eventId: value.eventId, block,
    ref: { id: ref.id as string, sourceId: ref.sourceId as string, digest: ref.digest as string, location: ref.location as string, mediaType: ref.mediaType as string } };
}

/** Provenance is established only from admitted Session content or CommandInvocation. */
export class NativeMaterials {
  private readonly sources = new Map<string, MaterialSource>();
  constructor(private readonly host: DshContext, private readonly bindings: NativeFlowBindings, private readonly directory: string) {}
  async admitSession(native: NativeAgent): Promise<MaterialRef[]> {
    const refs: MaterialRef[] = [];
    const events = native.session.snapshotEvents();
    for (const event of events) {
      let content: readonly ContentBlock[], source: string;
      if (event.type === 'user/message' && event.data.source.kind === 'user') { content = event.data.content; source = String(event.seq); }
      else if (event.type === 'tool/result' && !event.data.message.isError) {
        const call = events.find(call => call.type === 'tool/call' && call.data.callId === event.data.message.toolCallId);
        if (call?.type !== 'tool/call' || call.data.name.startsWith('flow_')) continue;
        content = event.data.message.content; source = `tool:${event.seq}`;
      } else if (event.type === 'tool/ptc-dispatch' && !event.data.isError && !event.data.name.startsWith('flow_')) {
        const root = events.find(call => call.type === 'tool/call' && call.data.callId === event.data.rootCallId && call.data.name === 'run_code');
        if (!root) continue;
        content = event.data.content; source = `tool:ptc:${event.seq}`;
      } else continue;
      let index = 0;
      for (const block of content) {
        if (block.type === 'text' || block.type === 'image' || block.type === 'file') refs.push(await this.admit(native, `${source}:${index}`, block));
        index++;
      }
    }
    return refs;
  }
  async available(caller: Agent): Promise<MaterialRef[]> {
    const binding = this.bindings.get(caller);
    if (!binding) throw new Error('Caller has no native execution scope');
    const own = await this.admitSession(binding.native);
    const assigned = contextRun(caller[agentControl].context).assignments!.list(caller)
      .filter(assignment => assignment.recipientSessionID === caller.getProfile().sessionID).flatMap(assignment => assignment.spec.materials ?? []);
    return [...new Map([...own, ...assigned].map(material => [material.id, structuredClone(material)])).values()];
  }
  async admitCommand(invocation: Pick<CommandInvocation, 'agent' | 'commandId' | 'attachments'>): Promise<MaterialRef[]> {
    const native = invocation.agent;
    if (this.host.agents.get(native.session.id) !== native) throw new Error('Command Agent is no longer live');
    if (!native.session.snapshotEvents().some(event => event.type === 'command/run' && event.data.commandId === invocation.commandId)) throw new Error('Command was not admitted to the native Session');
    return Promise.all(invocation.attachments.map((block, index) => this.admit(native, `command:${invocation.commandId}:${index}`, block)));
  }
  private async admit(native: NativeAgent, eventId: string, block: MaterialBlock): Promise<MaterialRef> {
    const id = sha(JSON.stringify([native.session.id, eventId, block]));
    const known = this.sources.get(id);
    if (known) return structuredClone(known.ref);
    try {
      const saved = decodeSource(JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')));
      if (saved.ref?.id !== id) throw new Error('Invalid saved material identity');
      return structuredClone((await this.source(saved.ref)).ref);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const digest = await this.originalDigest(block);
    const sourceId = block.type === 'text' ? `${native.session.id}:${eventId}` : block.attachment.attachmentId;
    const location = block.type === 'text' ? `session://${native.session.id}/${eventId}` : block.type === 'image'
      ? this.host.attachments.imageHostPath(block.attachment) : this.host.attachments.fileHostPath(block.attachment);
    if (!location) throw new Error('Attachment has no readable host location');
    const ref = { id, sourceId, digest, location, mediaType: block.type === 'image' ? block.attachment.mediaType : block.type === 'text' ? 'text/plain' : 'application/octet-stream' };
    const source: MaterialSource = { version: 1, sessionId: native.session.id, eventId, block: structuredClone(block), ref };
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${id}.json`), temporary = `${path}.${randomUUID()}.tmp`;
    let failure: unknown;
    try {
      await writeFile(temporary, JSON.stringify(source), { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) { failure = error; throw error; }
    finally {
      try { await rm(temporary, { force: true }); }
      catch (cleanup) { throw failure === undefined ? cleanup : new AggregateError([failure, cleanup], 'Material publication and temporary cleanup failed'); }
    }
    this.sources.set(id, source);
    return structuredClone(ref);
  }
  private async source(ref: MaterialRef): Promise<MaterialSource> {
    if (!/^[a-f0-9]{64}$/.test(ref.id)) throw new Error('Unknown material identity');
    let source = this.sources.get(ref.id);
    if (!source) {
      const item = decodeSource(JSON.parse(await readFile(join(this.directory, `${ref.id}.json`), 'utf8')));
      source = item; this.sources.set(ref.id, item);
    }
    if (!same(source.ref, ref)) throw new Error('Material identity, location or digest was altered');
    return source;
  }
  async validate(request: AssignmentMaterialRequest, signal?: AbortSignal): Promise<void> {
    const run = contextRun(request.recipient[agentControl].context);
    for (const ref of request.materials) {
      const source = await this.source(ref);
      if (request.sender instanceof Run) {
        if (request.sender !== run || request.parentAssignment !== null || source.sessionId !== runOrigin(run)) throw new Error('Material is not admitted to this Run origin');
      } else {
        if (request.sender[agentControl].context !== request.recipient[agentControl].context || !request.parentAssignment) throw new Error('Material requires the sender parent assignment');
        const parent = run.assignments!.read(request.sender, request.parentAssignment);
        const ownArtifact = source.eventId.startsWith('tool:') && source.sessionId === this.bindings.get(request.sender)?.native.session.id;
        if (parent.recipientSessionID !== request.sender.getProfile().sessionID || !ownArtifact && !parent.spec.materials?.some(material => same(material, ref))) throw new Error('Material was not received or produced by the sender in this assignment');
      }
      await this.present(request.recipient, source, signal);
    }
  }
  async read(caller: Agent, materialId: string, signal?: AbortSignal): Promise<MaterialValue> {
    const run = contextRun(caller[agentControl].context);
    const ref = run.assignments!.list(caller).filter(assignment => assignment.recipientSessionID === caller.getProfile().sessionID)
      .flatMap(assignment => assignment.spec.materials ?? []).find(ref => ref.id === materialId);
    if (!ref) throw new Error('Material was not received by this Agent');
    return { material: structuredClone(ref), ...await this.present(caller, await this.source(ref), signal) };
  }
  private async originalDigest(block: MaterialBlock, signal?: AbortSignal): Promise<string> {
    if (block.type === 'text') return sha(block.text);
    if (!this.host.get('attachments')) throw new Error('Native attachment storage is required');
    if (block.type === 'image') return sha((await this.host.attachments.readImage(block.attachment, signal)).data);
    const digest = createHash('sha256');
    for await (const chunk of this.host.attachments.readFileStream(block.attachment, signal)) digest.update(chunk);
    return digest.digest('hex');
  }
  private async present(recipient: Agent, source: MaterialSource, signal?: AbortSignal): Promise<Omit<MaterialValue, 'material'>> {
    signal?.throwIfAborted();
    const binding = this.bindings.get(recipient);
    if (!binding) throw new Error('Recipient has no native execution scope');
    if (await this.originalDigest(source.block, signal) !== source.ref.digest) throw new Error('Material content digest changed');
    const block = source.block;
    if (block.type === 'text') return { content: [structuredClone(block)] };
    const filesystem = this.host.get('agentPresets')?.serviceFor(binding.native, 'fs') ?? binding.native.ctx.get('fs');
    if (!filesystem) throw new Error('Recipient filesystem is unavailable');
    const fs = getTraceable(binding.native.ctx, filesystem);
    const path = fs.processPathFromHostPath(source.ref.location);
    if (!path) throw new Error('Material cannot be mapped into recipient filesystem');
    const verifyPath = async (location: string): Promise<void> => {
      const target = await fs.resolve(location, { cwd: binding.plan.cwd, ...(signal ? { signal } : {}) });
      const info = await fs.stat(target, signal);
      if (!info || info.type !== 'file' || info.size !== block.attachment.bytes) throw new Error('Recipient material size differs');
      const digest = createHash('sha256');
      for (let offset = 0; offset < info.size; offset += 1024 * 1024) {
        const length = Math.min(1024 * 1024, info.size - offset);
        const chunk = await fs.readByteRange(target, { offset, length }, signal);
        if (chunk.byteLength !== length) throw new Error('Recipient material changed during read');
        digest.update(chunk);
      }
      if (digest.digest('hex') !== source.ref.digest) throw new Error('Recipient material digest differs');
    };
    await verifyPath(path);
    // rc.2's shared AgentLoop LLM projects attachment paths through its stable
    // composition, while the recipient preset can expose a different fs world.
    const sharedFs = this.host.get('fs'), attachments = this.host.get('attachments');
    if (!sharedFs || !attachments) throw new Error('Native shared-loop attachment presentation is unavailable');
    let presentedLocation: string | undefined;
    if (block.type === 'file') {
      const hostPath = attachments.fileHostPath(block.attachment);
      presentedLocation = hostPath === undefined ? undefined : sharedFs.processPathFromHostPath(hostPath);
      if (!presentedLocation || this.host.get('llm')?.fileRequestText(block.attachment) !== fileHandleText(block.attachment, presentedLocation)) throw new Error('Native shared-loop file presentation is incompatible');
    } else presentedLocation = resolveImageAttachmentAccess(attachments, hostPath => sharedFs.processPathFromHostPath(hostPath), block.attachment)?.readonlyPath;
    if (!presentedLocation) throw new Error('Native shared-loop attachment has no readable presentation path');
    if (presentedLocation !== path) await verifyPath(presentedLocation);
    if (block.type === 'image') {
      const modelService = this.host.get('agentPresets')?.serviceFor(binding.native, 'llm') ?? binding.native.ctx.get('llm');
      if (!modelService) throw new Error('Recipient model service is unavailable');
      const llm = getTraceable(binding.native.ctx, modelService);
      const info = await llm.resolveModelInfo(binding.plan.config.provider, binding.plan.config.model, signal);
      if (!info.inputModalities) throw new Error('Recipient image modality capability is unknown');
      if (!info.inputModalities.includes('image')) throw new Error('Recipient model does not support image materials');
    }
    return { content: [structuredClone(block)], presentedLocation };
  }
}
function runOrigin(run: Run): string { return runState(run).record.origin.callerSessionId; }
export function renderMaterial(value: MaterialValue): ContentBlock[] { return structuredClone(value.content); }

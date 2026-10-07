/**
 * The acceptance IPC bridge — development only.
 *
 * The deterministic acceptance runner drives a real DSH host over
 * `process.send`/`process.on('message')`, and it needs operations that a page
 * must never reach: settle a cluster, tick the scheduler, run one agent,
 * re-run recovery, close the database. Rather than leaving that surface inside
 * the production plugin (where it also installed process listeners on every
 * real deployment and took over process exit), it lives here and is mounted
 * only by the acceptance overlay patch.
 *
 * The bridge talks to `ctx.flow` through an explicit, checked contract instead
 * of asserting the service is the concrete runtime: the overlay patch and the
 * plugin can be loaded as different copies in one process, so `instanceof` is
 * meaningless and a silent downcast would only fail later, mid-run. If a method
 * the bridge needs is missing, it refuses at mount time with
 * `FLOW_TEST_BRIDGE_RUNTIME_MISMATCH`.
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import type { FlowService } from 'dsh-flow';
import type {
  FlowControlAction,
  FlowEventQuery,
  FlowEventsResult,
  FlowListQuery,
  FlowQueryKind,
  FlowQueryParams,
  FlowReadQuery,
  FlowReport,
  FlowSnapshot,
  FlowStartRequest,
} from 'dsh-flow/types';

/** Cordis identity for the acceptance IPC bridge. */
export const name = 'dsh-flow-ipc-bridge';

/** The bridge may only exist where the cluster service is live. */
export const inject = ['flow','sessions','agents','sessionPersistence','sessionController'];

/** The extra operations the acceptance runner drives, beyond {@link FlowService}. */
export interface FlowTestOperations {
  runSingleAgent(request: SingleAgentRequest): Promise<FlowSnapshot>
  runUntilSettled(id: string, options: SettleOptions): Promise<FlowSnapshot>
  tick(): Promise<unknown>
  recoverAndReconcile(): Promise<RecoveredReport>
  dispose(): Promise<void>
}

/** One single-agent request, as the runner's fixtures send it. */
export interface SingleAgentRequest {
  readonly objective: string
  readonly workspace?: string
  readonly capabilities?: readonly string[]
  readonly budget?: Record<string, unknown>
  readonly acceptance_criteria?: readonly string[]
  readonly timeoutMs?: number
}

/** How long to drive a cluster before giving up. */
export interface SettleOptions {
  readonly timeoutMs?: number | undefined
  readonly pollMs?: number | undefined
}

/** What recovery reconciled. */
export interface RecoveredReport {
  readonly recovered: readonly string[]
}

/**
 * The development-only fixtures a `start` call carries beside the public
 * request. They name the cluster's internal delegation/message injection and
 * are never part of the published wire DTO, so the bridge declares them here.
 */
export interface FlowStartInternals {
  readonly delegation?: unknown
  readonly message_fixture?: unknown
}

/**
 * The exact contract the bridge consumes.
 *
 * `start` carries the development fixtures as an optional second argument; the
 * concrete runtime declares exactly that signature, and the checked contract
 * makes the dependency explicit rather than hidden behind a cast.
 */
export type FlowTestRuntime = FlowService
  & FlowTestOperations
  & {
    start(request: FlowStartRequest, internals?: FlowStartInternals): FlowSnapshot
    readonly config: { readonly dataDir: string }
  };

/** One request from the runner. */
export interface IpcRequest {
  readonly flow: true
  readonly requestId: string
  readonly op: string
  readonly cluster?: string
  readonly payload?: Record<string, unknown>
}

/** The runner's ready note. */
export interface IpcReady {
  readonly flow: true
  readonly ready: true
  readonly pid: number
  readonly data_dir: string
}

/** One successful reply. */
export interface IpcReply {
  readonly flow: true
  readonly requestId: string
  readonly ok: true
  readonly result: unknown
}

/** One failed reply. */
export interface IpcFailure {
  readonly flow: true
  readonly requestId: string
  readonly ok: false
  readonly error: { readonly message: string; readonly status: number; readonly code: string | null }
}

/** Everything the bridge may send back. */
export type IpcOutbound = IpcReady | IpcReply | IpcFailure;

/**
 * Mount the bridge.
 * @param ctx - context carrying the cluster service.
 */
export function apply(ctx: Context): void {
  if (process.env.FLOW_IPC !== '1' || typeof process.send !== 'function') return;
  const runtime = requireTestRuntime(ctx.flow);
  ctx.effect(() => install(runtime,ctx), 'dsh-flow: acceptance ipc bridge');
}

/**
 * Prove the live service really offers the development operations.
 * @param service - the live `ctx.flow` value.
 * @returns the same object, narrowed to the checked contract.
 */
export function requireTestRuntime(service: FlowService): FlowTestRuntime {
  const candidate = service as FlowService & Partial<FlowTestOperations> & Partial<FlowTestRuntime>;
  const missing = (['runSingleAgent', 'runUntilSettled', 'tick', 'recoverAndReconcile', 'dispose'] as const)
    .filter(method => typeof candidate[method] !== 'function');
  const dataDir = candidate.config?.dataDir;
  if (missing.length > 0 || typeof dataDir !== 'string') {
    throw new Error(
      `FLOW_TEST_BRIDGE_RUNTIME_MISMATCH: ctx.flow is missing ${missing.join(', ') || 'config.dataDir'}`,
    );
  }
  return candidate as FlowTestRuntime;
}

/** Install the listener pair and return the disposer that removes both. */
function install(runtime: FlowTestRuntime,ctx:Context): () => void {
  const onDisconnect = (): void => {
    // A killed runner must not leave an orphaned host holding the workspace, the
    // ports and the cluster database. The same drain, awaited, before the
    // process goes: exiting first left the turns' bookkeeping half-written.
    void Promise.resolve(runtime.dispose())
      .catch(error => console.error(messageOf(error)))
      .finally(() => process.exit(0));
  };
  const onMessage = (message: unknown): void => {
    if (!isIpcRequest(message)) return;
    Promise.resolve()
      .then(() => message.op==='observation-fixture'?observationFixture(ctx,message.payload):handle(runtime, message))
      .then(result => send({ flow: true, requestId: message.requestId, ok: true, result }))
      .catch((error: unknown) => send({
        flow: true,
        requestId: message.requestId,
        ok: false,
        error: {
          message: messageOf(error),
          status: rejectionStatus(error) ?? 500,
          code: error instanceof Error ? error.name : null,
        },
      }));
  };
  process.on('disconnect', onDisconnect);
  process.on('message', onMessage);
  send({ flow: true, ready: true, pid: process.pid, data_dir: runtime.config.dataDir });
  return () => {
    process.off('message', onMessage);
    process.off('disconnect', onDisconnect);
  };
}

/** Narrow an inbound message to the bridge's envelope. */
function isIpcRequest(value: unknown): value is IpcRequest {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.flow === true && typeof record.requestId === 'string' && typeof record.op === 'string';
}

/** Persisted native message fixture, never an execution or throughput claim. */
async function observationFixture(ctx:Context,payload:Record<string,unknown>|undefined):Promise<unknown> {
  const id=typeof payload?.session_id==='string'?SessionId(payload.session_id):undefined;
  if(payload?.inspect===true&&id){
    let snapshot:unknown;
    if(payload.read===true){
      const controller=new AbortController();
      const iterator=ctx.sessionController.follow({address:{kind:'session',sessionId:id},observationOnly:true},controller.signal)[Symbol.asyncIterator]();
      try{snapshot=(await iterator.next()).value;}catch(error){snapshot={error:messageOf(error)};}finally{controller.abort();await iterator.return?.();}
    }
    return {agent_active:ctx.agents.get(id)!==undefined,session_live:ctx.sessions.get(id)!==undefined,...(snapshot===undefined?{}:{snapshot})};
  }
  const options={meta:{cwd:stringField(payload,'workspace')??process.cwd()}};
  const session=id?ctx.sessions.get(id):payload?.cold===true?ctx.sessions.prepare(undefined,options):ctx.sessions.create(undefined,options);
  if(!session)throw new Error('Observation fixture session unavailable');
  const count=typeof payload?.count==='number'?payload.count:1;
  if(!Number.isSafeInteger(count)||count<1||count>200)throw new Error('Invalid observation fixture count');
  const prefix=stringField(payload,'prefix')??'native-history';
  for(let index=0;index<count;index++) {
    const turn=session.snapshotEvents().filter(event=>event.type==='turn/start').length+1;
    session.append('turn/start',{turn});
    session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:`${prefix}-${index}：这是一条由原生 Session API 保存的阅读验收记录。\n${'正文保持独立身份和原始顺序。'.repeat(12)}`}]}),{surfaceOp:'append'});
    session.append('turn/end',{turn,reason:{kind:'completed'}});
  }
  if(payload?.cold===true){const handle=await ctx.sessionPersistence.create(session.header);try{await handle.append(session.snapshotEvents());await handle.flush();}finally{await handle.close();}}
  else await ctx.sessions.flush(session);
  return {session_id:session.id,count,kind:'native persisted read fixture'};
}

/** Send one envelope to the runner, tolerating a channel that already closed. */
function send(envelope: IpcOutbound): void {
  if (typeof process.send !== 'function') return;
  try {
    process.send(envelope);
  } catch {
    // The runner is gone; disconnect already triggered the drain.
  }
}

/**
 * Perform one runner operation.
 * @param runtime - the checked cluster contract.
 * @param message - the runner's request.
 * @returns the operation's result, in the runner's own envelope shape.
 */
async function handle(runtime: FlowTestRuntime, message: IpcRequest): Promise<unknown> {
  const { op, payload } = message;
  const id = message.cluster ?? stringField(payload, 'id');
  switch (op) {
    case 'ping':
      return { ok: true, pid: process.pid, data_dir: runtime.config.dataDir };
    case 'start':
      return runtime.start(startRequest(payload), internals(payload));
    case 'list':
      return runtime.list(listQuery(payload));
    case 'read':
      return runtime.read(requireId(id, 'read'), readQuery(payload));
    case 'events':
      return runtime.events(requireId(id, 'events'), eventQuery(payload));
    case 'control':
      return runtime.control(requireId(id, 'control'), controlAction(payload?.action));
    case 'report':
      return runtime.report(requireId(id, 'report'));
    case 'query': {
      // The runner keeps its previous raw-data envelope: unwrap the tagged
      // answer the standard service returns.
      const what = typeof payload?.what === 'string' ? payload.what as FlowQueryKind : 'cluster';
      return runtime.queryCluster(requireId(id, 'query'), what, objectField(payload?.params) as FlowQueryParams);
    }
    case 'settle':
      await runtime.runUntilSettled(requireId(id, 'settle'), {
        ...(numberField(payload, 'timeout_ms') === undefined ? {} : { timeoutMs: numberField(payload, 'timeout_ms') }),
        ...(numberField(payload, 'poll_ms') === undefined ? {} : { pollMs: numberField(payload, 'poll_ms') }),
      });
      return runtime.read(requireId(id, 'settle'), { include_events: false });
    case 'tick':
      await runtime.tick();
      return runtime.read(requireId(id, 'tick'), { include_events: false });
    case 'single':
      return runtime.runSingleAgent(singleAgentRequest(payload));
    case 'recover':
      return runtime.recoverAndReconcile();
    case 'dispose':
      // Disposal drains the live turns before it closes the store: the caller
      // waits for it, or it would answer "disposed" over a runtime still
      // finishing its turns.
      await runtime.dispose();
      return { ok: true };
    default:
      throw new Error(`Unknown flow op: ${op}`);
  }
}

function requireId(id: string | undefined, op: string): string {
  if (typeof id !== 'string' || !id) throw new Error(`flow op ${op} needs a cluster id`);
  return id;
}

/** The control verb one `control` request asked for. */
function controlAction(value: unknown): FlowControlAction {
  if (value === 'pause' || value === 'resume' || value === 'cancel') return value;
  throw new Error(`flow op control needs a pause/resume/cancel action, got ${JSON.stringify(value)}`);
}

/**
 * Render a caught value for a log line or a runner envelope.
 *
 * The plugin's own `messageOf`/`rejectionStatus` are not on the package's
 * published type surface, so this development-only copy keeps the bridge free
 * of imports into the plugin's source tree. It reads a rejection the same way,
 * structurally, so a differently-loaded copy of the plugin still matches.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

/** Read the business status of a caught cluster rejection, or undefined. */
function rejectionStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if (!('code' in error) || error.code !== 'flow/rejected') return undefined;
  if (!('details' in error)) return undefined;
  const details = error.details;
  if (typeof details !== 'object' || details === null) return undefined;
  if (!('status' in details) || typeof details.status !== 'number') return undefined;
  return details.status;
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function objectField(source: unknown): Record<string, unknown> {
  return source !== null && typeof source === 'object' && !Array.isArray(source)
    ? source as Record<string, unknown>
    : {};
}

function startRequest(payload: Record<string, unknown> | undefined): FlowStartRequest {
  const source = objectField(payload);
  const objective = source.objective;
  if (typeof objective !== 'string') throw new Error('flow op start needs a string objective');
  const workspace = stringField(source, 'workspace');
  const capabilities = Array.isArray(source.capabilities)
    ? source.capabilities.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const acceptance = Array.isArray(source.acceptance_criteria)
    ? source.acceptance_criteria.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const initial = Array.isArray(source.initial_transactions) ? source.initial_transactions : undefined;
  return {
    objective,
    ...(stringField(source, 'id') === undefined ? {} : { id: stringField(source, 'id') }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(source.budget === undefined ? {} : { budget: objectField(source.budget) }),
    ...(source.limits === undefined ? {} : { limits: objectField(source.limits) }),
    ...(initial === undefined ? {} : { initial_transactions: initial }),
    ...(acceptance === undefined ? {} : { acceptance_criteria: acceptance }),
  } as FlowStartRequest;
}

function internals(payload: Record<string, unknown> | undefined): FlowStartInternals {
  const source = objectField(payload);
  return {
    ...(source.delegation === undefined ? {} : { delegation: source.delegation }),
    ...(source.message_fixture === undefined ? {} : { message_fixture: source.message_fixture }),
  };
}

function listQuery(payload: Record<string, unknown> | undefined): FlowListQuery {
  const source = objectField(payload);
  const status = stringField(source, 'status');
  const limit = numberField(source, 'limit');
  const offset = numberField(source, 'offset');
  const query: { status?: NonNullable<FlowListQuery['status']>; limit?: number; offset?: number } = {};
  if (status !== undefined) query.status = status as NonNullable<FlowListQuery['status']>;
  if (limit !== undefined) query.limit = limit;
  if (offset !== undefined) query.offset = offset;
  return query;
}

function readQuery(payload: Record<string, unknown> | undefined): FlowReadQuery {
  const source = objectField(payload);
  const status = source.status;
  const limit = numberField(source, 'limit');
  const offset = numberField(source, 'offset');
  const nodeId = stringField(source, 'node_id');
  const since = numberField(source, 'since');
  const eventLimit = numberField(source, 'event_limit');
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
    ...(nodeId === undefined ? {} : { node_id: nodeId }),
    ...(status === undefined ? {} : { status: Array.isArray(status) ? status.map(String) : String(status) }),
    ...(since === undefined ? {} : { since }),
    ...(eventLimit === undefined ? {} : { event_limit: eventLimit }),
    ...(typeof source.include_events === 'boolean' ? { include_events: source.include_events } : {}),
    ...(typeof source.include_summary === 'boolean' ? { include_summary: source.include_summary } : {}),
  };
}

function eventQuery(payload: Record<string, unknown> | undefined): FlowEventQuery {
  const source = objectField(payload);
  const since = numberField(source, 'since');
  const limit = numberField(source, 'limit');
  return {
    ...(since === undefined ? {} : { since }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function singleAgentRequest(payload: Record<string, unknown> | undefined): SingleAgentRequest {
  const source = objectField(payload);
  if (typeof source.objective !== 'string') throw new Error('flow op single needs a string objective');
  const capabilities = Array.isArray(source.capabilities)
    ? source.capabilities.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const acceptance = Array.isArray(source.acceptance_criteria)
    ? source.acceptance_criteria.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const workspace = stringField(source, 'workspace');
  const timeoutMs = numberField(source, 'timeoutMs');
  return {
    objective: source.objective,
    ...(workspace === undefined ? {} : { workspace }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(source.budget === undefined ? {} : { budget: objectField(source.budget) }),
    ...(acceptance === undefined ? {} : { acceptance_criteria: acceptance }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

export type { FlowEventsResult, FlowReport, FlowSnapshot };

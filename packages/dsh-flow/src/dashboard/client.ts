import type { OperationAccepted, ProtocolVersion, RegistrySnapshot, RunSnapshot, StopRequest } from './protocol.js';
import { IncompatibleProtocol, decodeToken, decodeRegistry, decodeSnapshot, decodeRegistryEvent, decodeRunEvent } from './decoder.js';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'disposed';
export interface DashboardUpdate { kind: 'state' | 'snapshot' | 'replay' | 'live'; generation: number; seq?: number; eventType?: string }
export interface DashboardClientState {
  update: DashboardUpdate;
  connection: ConnectionStatus;
  registryConnection: ConnectionStatus;
  runConnection: ConnectionStatus;
  version: ProtocolVersion | null;
  epoch: string | null;
  registry: RegistrySnapshot | null;
  selectedRunId: string | null;
  snapshot: RunSnapshot | null;
  updatedAt: number | null;
  error: string | null;
}
export interface DashboardClientOptions { baseUrl: string; origin?: string; fetch?: typeof fetch; reconnectDelayMs?: number }
export class DashboardRequestError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) { super(message); this.name = 'DashboardRequestError'; }
}
class ResetRequired extends Error {}
function replayWatermark(response: Response, after: number): number {
  const value = response.headers.get('X-Flow-Replay-Through');
  const cursor = value !== null && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(cursor) || cursor < after) { void response.body?.cancel().catch(() => {}); throw new ResetRequired('Invalid replay watermark'); }
  return cursor;
}
async function responseError(response: Response): Promise<DashboardRequestError> {
  let code: string | undefined, detail = `Dashboard request failed (${response.status})`;
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'error' in payload) {
      const error = payload.error;
      if (error && typeof error === 'object' && !Array.isArray(error) && 'code' in error && 'message' in error
        && typeof error.code === 'string' && typeof error.message === 'string') { code = error.code; detail = error.message; }
    }
  } catch { /* An invalid error body still reports its HTTP status. */ }
  return new DashboardRequestError(response.status, code, detail);
}
function replace<T extends { id: string }>(items: T[], value: T): T[] { return [...items.filter(item => item.id !== value.id), value]; }

export async function consumeSse(response: Response, signal: AbortSignal, listener: (data: unknown) => void): Promise<void> {
  if (!response.body) throw new Error('Missing SSE response body');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', data: string[] = [];
  const line = (value: string) => {
    if (value === '') { if (data.length) { const payload: unknown = JSON.parse(data.join('\n')); data = []; listener(payload); } return; }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':'), field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1); if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') data.push(content);
  };
  const consume = (final: boolean) => {
    let start = 0;
    for (let i = 0; i < pending.length; i++) {
      const char = pending[i];
      if (char !== '\r' && char !== '\n') continue;
      if (char === '\r' && i === pending.length - 1 && !final) break;
      line(pending.slice(start, i)); if (char === '\r' && pending[i + 1] === '\n') i++;
      start = i + 1;
    }
    pending = pending.slice(start);
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) { const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break; pending += decoder.decode(chunk.value, { stream: true }); consume(false); }
    pending += decoder.decode(); consume(true);
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class DashboardClient {
  private readonly fetcher: typeof fetch;
  private readonly base: string;
  private readonly listeners = new Set<(state: DashboardClientState) => void>();
  private state: DashboardClientState = { update: { kind: 'state', generation: 0 }, connection: 'idle', registryConnection: 'idle', runConnection: 'idle', version: null, epoch: null,
    registry: null, selectedRunId: null, snapshot: null, updatedAt: null, error: null };
  private token = '';
  private disposed = false;
  private readonly lifetime = new AbortController();
  private registryAbort: AbortController | undefined;
  private runAbort: AbortController | undefined;
  private runGeneration = 0;
  private registryGeneration = 0;
  private authentication: Promise<void> | undefined;
  private connecting: Promise<void> | undefined;
  constructor(private readonly options: DashboardClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis); this.base = options.baseUrl.replace(/\/$/, '');
    if (options.reconnectDelayMs !== undefined && (!Number.isFinite(options.reconnectDelayMs) || options.reconnectDelayMs < 0)) throw new TypeError('Invalid reconnect delay');
  }
  getState(): DashboardClientState { return structuredClone(this.state); }
  subscribe(listener: (state: DashboardClientState) => void): () => void { this.listeners.add(listener); listener(this.getState()); return () => { this.listeners.delete(listener); }; }
  private publish(patch: Partial<DashboardClientState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch, update: patch.update ?? { kind: 'state', generation: this.runGeneration } };
    for (const listener of [...this.listeners]) { try { listener(this.getState()); } catch {} }
  }
  private headers(auth = true): Headers { const headers = new Headers(); if (auth) headers.set('Authorization', `Bearer ${this.token}`); if (this.options.origin) headers.set('Origin', this.options.origin); return headers; }
  private authenticate(): Promise<void> {
    if (this.authentication) return this.authentication;
    const operation = (async () => {
      const response = await this.fetcher(`${this.base}/api/token`, { headers: this.headers(false), signal: this.lifetime.signal, cache: 'no-store' });
      if (!response.ok) throw await responseError(response);
      const next = decodeToken(await response.json()); this.lifetime.signal.throwIfAborted();
      this.token = next.token;
      if (this.state.epoch !== next.epoch || this.state.version?.major !== next.version.major || this.state.version.minor !== next.version.minor) this.publish({ version: next.version, epoch: next.epoch });
    })();
    this.authentication = operation;
    void operation.finally(() => { if (this.authentication === operation) this.authentication = undefined; }).catch(() => {});
    return operation;
  }
  private async request(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
    const headers = this.headers(); if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await this.fetcher(`${this.base}${path}`, { ...init, headers, signal });
    if (!response.ok) {
      const error = await responseError(response);
      if (response.status === 401) { await this.authenticate(); throw new ResetRequired(error.message); }
      if ((response.status === 409 || response.status === 410) && error.code === 'reset-required') throw new ResetRequired(error.message);
      throw error;
    }
    return response;
  }
  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Dashboard client is disposed'));
    if (this.connecting) return this.connecting;
    if (this.registryAbort && !this.registryAbort.signal.aborted && this.state.registry) return Promise.resolve();
    const controller = new AbortController();
    // Publish only after the shared promise is installed so reentrant subscribers join the same attempt.
    const operation = Promise.resolve().then(async () => {
      try {
        this.lifetime.signal.throwIfAborted(); controller.signal.throwIfAborted();
        this.publish({ connection: 'connecting', registryConnection: 'connecting', error: null });
        await this.authenticate(); controller.signal.throwIfAborted();
        try { await this.loadRegistry(controller.signal); }
        catch (error) { if (!(error instanceof ResetRequired)) throw error; await this.loadRegistry(controller.signal); }
        controller.signal.throwIfAborted();
        this.publish({ connection: 'connected', registryConnection: 'connected' });
        void this.registryLoop(controller).catch(error => { if (this.registryAbort === controller) this.fatal(error); });
      } catch (error) {
        if (this.registryAbort === controller) this.fatal(error);
        throw error;
      } finally {
        if (this.connecting === operation) this.connecting = undefined;
      }
    });
    this.registryAbort = controller; this.connecting = operation;
    return operation;
  }
  private async loadRegistry(signal: AbortSignal): Promise<void> {
    const generation = ++this.registryGeneration;
    const response = await this.request('/api/runs', signal), value = decodeRegistry(await response.json());
    signal.throwIfAborted(); if (generation !== this.registryGeneration) return;
    if (value.epoch !== this.state.epoch) { await this.authenticate(); throw new ResetRequired('Process epoch changed'); }
    this.publish({ registry: value, updatedAt: Date.now() });
    const selected = this.state.selectedRunId;
    if (selected && !value.runs.some(run => run.id === selected && run.status !== 'invalid')) {
      this.runAbort?.abort(); this.runGeneration++;
      this.publish({ runConnection: 'error', error: 'Selected run is no longer valid' });
    }
  }
  private async registryLoop(controller: AbortController): Promise<void> {
    let baseline = false;
    while (!controller.signal.aborted && !this.disposed) {
      try {
        if (baseline) { await this.loadRegistry(controller.signal); baseline = false; }
        const registry = this.state.registry!;
        const response = await this.request(`/api/events?after=${registry.seq}&epoch=${encodeURIComponent(registry.epoch)}`, controller.signal);
        this.publish({ connection: 'connected', registryConnection: 'connected', error: null });
        await consumeSse(response, controller.signal, raw => this.applyRegistry(raw));
        throw new Error('Dashboard registry stream disconnected');
      } catch (error) {
        if (controller.signal.aborted || this.disposed) return;
        if (error instanceof IncompatibleProtocol) throw error;
        baseline = baseline || error instanceof ResetRequired;
        this.publish({ connection: 'reconnecting', registryConnection: 'reconnecting', error: message(error) });
        await this.delay(controller.signal);
      }
    }
  }
  private applyRegistry(raw: unknown): void {
    let event: ReturnType<typeof decodeRegistryEvent>;
    try { event = decodeRegistryEvent(raw); } catch (error) { throw new ResetRequired(message(error)); }
    const current = this.state.registry!;
    if (event.epoch !== current.epoch || event.epoch !== this.state.epoch) throw new ResetRequired('Registry epoch changed');
    if (event.seq <= current.seq) return;
    if (event.seq !== current.seq + 1) throw new ResetRequired('Registry sequence gap');
    let runs = current.runs;
    if (event.type !== 'unknown') {
      if (event.run.epoch !== event.epoch) throw new ResetRequired('Invalid registry run');
      runs = replace(runs, event.run);
      if (event.run.id === this.state.selectedRunId && event.run.status === 'invalid') { this.runAbort?.abort(); this.runGeneration++; this.publish({ runConnection: 'error', error: 'Selected run is no longer valid' }); }
    }
    this.publish({ registry: { ...current, seq: event.seq, runs }, updatedAt: Date.now() });
  }
  /** Read one current registry Run without selecting it or opening a stream. */
  async readRunSnapshot(runId: string, signal: AbortSignal): Promise<RunSnapshot> {
    if (this.disposed) throw new Error('Dashboard client is disposed');
    if (!this.state.registry || !this.registryAbort || this.registryAbort.signal.aborted) throw new Error('Dashboard client must connect before reading a Run');
    const epoch = this.state.registry.epoch;
    const lifetime = AbortSignal.any([signal, this.lifetime.signal]);
    const current = () => {
      lifetime.throwIfAborted();
      if (this.state.epoch !== epoch || this.state.registry?.epoch !== epoch) throw new ResetRequired('Run snapshot epoch changed');
      if (!this.state.registry.runs.some(run => run.id === runId && run.epoch === epoch && run.status !== 'invalid')) throw new DashboardRequestError(404, 'run-unavailable', 'Run is unavailable');
    };
    current();
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.request(`/api/runs/${encodeURIComponent(runId)}`, lifetime, { cache: 'no-store' });
        const value = decodeSnapshot(await response.json(), runId);
        current();
        if (value.run.epoch !== epoch) throw new ResetRequired('Run snapshot epoch changed');
        if (value.run.status === 'invalid') throw new DashboardRequestError(404, 'run-unavailable', 'Run is unavailable');
        return value;
      } catch (error) {
        current();
        if (!(error instanceof ResetRequired) || attempt !== 0) throw error;
      }
    }
  }
  async selectRun(runId: string): Promise<void> {
    if (this.disposed) throw new Error('Dashboard client is disposed');
    await this.connect(); this.runAbort?.abort();
    const generation = ++this.runGeneration, controller = new AbortController(); this.runAbort = controller;
    this.publish({ selectedRunId: runId, snapshot: null, runConnection: 'connecting', error: null });
    try {
      await this.loadRun(runId, generation, controller.signal);
      if (generation !== this.runGeneration || controller.signal.aborted) return;
      this.publish({ runConnection: 'connected' });
      void this.runLoop(runId, generation, controller).catch(error => this.fatal(error));
    } catch (error) {
      if (generation !== this.runGeneration || controller.signal.aborted) return;
      if (error instanceof IncompatibleProtocol) { this.fatal(error); throw error; }
      if (error instanceof ResetRequired) { void this.runLoop(runId, generation, controller, true).catch(failure => this.fatal(failure)); return; }
      this.publish({ runConnection: 'error', error: message(error) }); throw error;
    }
  }
  private async loadRun(runId: string, generation: number, signal: AbortSignal): Promise<void> {
    const response = await this.request(`/api/runs/${encodeURIComponent(runId)}`, signal), value = decodeSnapshot(await response.json(), runId);
    signal.throwIfAborted(); if (generation !== this.runGeneration) return;
    if (value.run.epoch !== this.state.epoch) { await this.authenticate(); throw new ResetRequired('Run epoch changed'); }
    this.publish({ snapshot: value, updatedAt: Date.now(), update: { kind: 'snapshot', generation, seq: value.seq } });
  }
  private async runLoop(runId: string, generation: number, controller: AbortController, baseline = false): Promise<void> {
    while (!controller.signal.aborted && generation === this.runGeneration && !this.disposed) {
      try {
        if (baseline || this.state.snapshot?.run.epoch !== this.state.epoch) {
          await this.loadRegistry(controller.signal);
          if (!this.state.registry?.runs.some(run => run.id === runId && run.status !== 'invalid')) throw new Error('Selected run is no longer valid');
          await this.loadRun(runId, generation, controller.signal); baseline = false;
        }
        if (generation !== this.runGeneration || controller.signal.aborted) return;
        const snapshot = this.state.snapshot!;
        const response = await this.request(`/api/runs/${encodeURIComponent(runId)}/events?after=${snapshot.seq}&epoch=${encodeURIComponent(snapshot.run.epoch)}`, controller.signal);
        if (generation !== this.runGeneration || controller.signal.aborted) { await response.body?.cancel(); return; }
        const replayThrough = replayWatermark(response, snapshot.seq);
        this.publish({ runConnection: 'connected', error: null });
        await consumeSse(response, controller.signal, raw => { if (generation === this.runGeneration) this.applyRun(raw, runId, generation, replayThrough); });
        throw new Error('Dashboard run stream disconnected');
      } catch (error) {
        if (controller.signal.aborted || generation !== this.runGeneration || this.disposed) return;
        if (error instanceof IncompatibleProtocol) throw error;
        baseline = baseline || error instanceof ResetRequired;
        this.publish({ runConnection: 'reconnecting', error: message(error) });
        await this.delay(controller.signal);
      }
    }
  }
  private applyRun(raw: unknown, runId: string, generation: number, replayThrough: number): void {
    let event: ReturnType<typeof decodeRunEvent>;
    try { event = decodeRunEvent(raw); } catch (error) { throw new ResetRequired(message(error)); }
    if (event.runId !== runId) throw new ResetRequired('Invalid run event');
    const current = this.state.snapshot!;
    if (current.run.epoch !== this.state.epoch) throw new ResetRequired('Run epoch changed');
    if (event.seq <= current.seq) return;
    if (event.seq !== current.seq + 1) throw new ResetRequired('Run sequence gap');
    const next: RunSnapshot = { ...current, seq: event.seq };
    if ('node' in event) next.nodes = replace(current.nodes, event.node);
    else if ('group' in event) next.groups = replace(current.groups, event.group);
    else if ('assignment' in event) next.assignments = replace(current.assignments, event.assignment);
    else if ('operation' in event) next.operations = replace(current.operations, event.operation);
    else if ('run' in event) {
      if (event.run.id !== runId || event.run.epoch !== current.run.epoch) throw new ResetRequired('Invalid run record');
      next.run = event.run;
    }
    this.publish({ snapshot: next, updatedAt: Date.now(), update: { kind: event.seq <= replayThrough ? 'replay' : 'live', generation, seq: event.seq, eventType: event.type } });
  }
  async stop(runId: string, request: StopRequest): Promise<OperationAccepted> {
    if (this.disposed) throw new Error('Dashboard client is disposed');
    let response: Response;
    try { response = await this.request(`/api/runs/${encodeURIComponent(runId)}/stop`, this.lifetime.signal, { method: 'POST', body: JSON.stringify(request) }); }
    catch (error) { if (!(error instanceof ResetRequired)) throw error; await this.loadRegistry(this.lifetime.signal); response = await this.request(`/api/runs/${encodeURIComponent(runId)}/stop`, this.lifetime.signal, { method: 'POST', body: JSON.stringify(request) }); }
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || !('operationId' in value) || !('status' in value) || value.operationId !== request.operationId || value.status !== 'accepted') throw new Error('Invalid stop acceptance');
    return { operationId: request.operationId, status: 'accepted' };
  }
  private delay(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, this.options.reconnectDelayMs ?? 500); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done(); });
  }
  private fatal(error: unknown): void {
    this.registryAbort?.abort(); this.runAbort?.abort(); this.registryAbort = undefined; this.runAbort = undefined;
    this.registryGeneration++; this.runGeneration++;
    if (!this.disposed) this.publish({ connection: 'error', registryConnection: 'error', runConnection: 'error', error: message(error) });
  }
  dispose(): void {
    if (this.disposed) return;
    this.publish({ connection: 'disposed', registryConnection: 'disposed', runConnection: 'disposed' });
    this.disposed = true; this.lifetime.abort(); this.registryAbort?.abort(); this.runAbort?.abort(); this.runGeneration++; this.registryGeneration++; this.listeners.clear();
  }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

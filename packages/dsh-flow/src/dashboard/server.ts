import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { RunService } from '../run/run.js';
import type { DashboardProjector } from './projector.js';
import { PROTOCOL_VERSION, type RegistryEvent, type RunEvent } from './protocol.js';
import { JournalCursorError } from './events.js';
import { DashboardOperations, decodeStopRequest, OperationRequestError } from './operations.js';

interface Options { projector: DashboardProjector; service: RunService; port?: number; allowedOrigins?: readonly string[]; staticDirectory?: string; tokenLifetimeMs?: number; maxSseBytes?: number }
class HttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
function loopback(address: string | undefined): boolean { return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'; }
function header(request: IncomingMessage, name: string): string | undefined { const value = request.headers[name]; return typeof value === 'string' ? value : undefined; }
function sameToken(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
export class DashboardServer {
  private readonly server: Server;
  private readonly operations: DashboardOperations;
  private readonly tokens = new Map<string, number>();
  private readonly origins = new Set<string>();
  private readonly streams = new Set<ServerResponse>();
  private readonly streamRuns = new Map<ServerResponse, string | undefined>();
  private readonly unsubscribeReset: () => void;
  private host = '';
  private disposal?: Promise<void>;
  private endpoint = '';
  private constructor(private readonly options: Options) {
    this.operations = new DashboardOperations(options.projector, options.service);
    this.origins.add('dsh-app://app');
    for (const origin of options.allowedOrigins ?? []) {
      if (origin !== 'dsh-app://app') {
        const parsed = new URL(origin);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new TypeError('Expected an exact allowed origin');
      }
      this.origins.add(origin);
    }
    if (options.tokenLifetimeMs !== undefined && (!Number.isSafeInteger(options.tokenLifetimeMs) || options.tokenLifetimeMs <= 0)) throw new TypeError('Invalid token lifetime');
    if (options.maxSseBytes !== undefined && (!Number.isSafeInteger(options.maxSseBytes) || options.maxSseBytes <= 0)) throw new TypeError('Invalid SSE byte bound');
    this.unsubscribeReset = options.projector.observeReset(runId => { for (const response of this.streams) if (this.streamRuns.get(response) === runId) response.destroy(); });
    this.server = createServer((request, response) => { void this.handle(request, response).catch(error => this.fail(response, error)); });
    this.server.on('clientError', (_error, socket) => { socket.destroy(); });
  }
  static async create(options: Options): Promise<DashboardServer> {
    const instance = new DashboardServer(options);
    try { await new Promise<void>((yes, no) => { instance.server.once('error', no); instance.server.listen(options.port ?? 0, '127.0.0.1', () => { instance.server.off('error', no); yes(); }); }); }
    catch (error) { instance.unsubscribeReset(); if (instance.server.listening) await new Promise<void>(yes => instance.server.close(() => yes())); instance.server.removeAllListeners(); throw error; }
    const bound = instance.server.address();
    if (!bound || typeof bound === 'string') throw new Error('Dashboard did not bind a TCP port');
    instance.host = `127.0.0.1:${bound.port}`; instance.endpoint = `http://${instance.host}`; instance.origins.add(instance.endpoint);
    return instance;
  }
  get address(): string { return this.endpoint; }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.unsubscribeReset();
    this.disposal = new Promise<void>((yes, no) => { this.server.close(error => error ? no(error) : yes()); this.server.closeIdleConnections(); });
    for (const response of this.streams) response.destroy();
    return this.disposal;
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    if (!loopback(request.socket.remoteAddress) || header(request, 'host') !== this.host) throw new HttpError(403, 'forbidden', 'Expected the exact local dashboard address');
    const raw = request.url ?? '/';
    const url = new URL(raw, this.endpoint);
    if (url.origin !== this.endpoint) throw new HttpError(403, 'forbidden', 'Unexpected request address');
    const origin = header(request, 'origin');
    if (origin !== undefined && !this.origins.has(origin)) throw new HttpError(403, 'forbidden-origin', 'Origin is not allowed');
    if (origin !== undefined) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
    const path = url.pathname;
    const runMatch = /^\/api\/runs\/([^/]+)(?:\/(events|stop))?$/.exec(path);
    const known = path === '/api/token' || path === '/api/runs' || path === '/api/events' || runMatch !== null;
    if (request.method === 'OPTIONS' && known) {
      if (!origin) throw new HttpError(403, 'forbidden-origin', 'Origin is required');
      response.setHeader('Access-Control-Allow-Methods', path.endsWith('/stop') ? 'POST' : 'GET');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); response.writeHead(204).end(); return;
    }
    if (path === '/api/token' && request.method === 'GET') {
      if (!origin && !this.sameOriginPage(request)) throw new HttpError(403, 'forbidden-origin', 'A declared origin or same-origin page is required');
      const now = Date.now();
      for (const [token, expiry] of this.tokens) if (expiry <= now) this.tokens.delete(token);
      const token = randomBytes(32).toString('base64url'); this.tokens.set(token, now + (this.options.tokenLifetimeMs ?? 60_000));
      this.json(response, 200, { token, epoch: this.options.service.epoch, version: PROTOCOL_VERSION }); return;
    }
    if (known) {
      this.authenticate(request);
      if (path === '/api/runs' && request.method === 'GET') { this.json(response, 200, this.options.projector.registry()); return; }
      if (path === '/api/events' && request.method === 'GET') { this.sse(request, response, listener => this.options.projector.subscribeRegistry(this.cursor(url), this.epoch(url), listener)); return; }
      if (runMatch) {
        let id: string;
        try { id = decodeURIComponent(runMatch[1]!); } catch { throw new HttpError(400, 'invalid-request', 'Invalid Run ID'); }
        if (!id || id.includes('/')) throw new HttpError(400, 'invalid-request', 'Invalid Run ID');
        const action = runMatch[2];
        if (!action && request.method === 'GET') { this.json(response, 200, this.options.projector.snapshot(id)); return; }
        if (action === 'events' && request.method === 'GET') { this.sse(request, response, listener => this.options.projector.subscribeRun(id, this.cursor(url), this.epoch(url), listener), id); return; }
        if (action === 'stop' && request.method === 'POST') {
          if (!origin) throw new HttpError(403, 'forbidden-origin', 'Origin is required for stop');
          if (header(request, 'content-type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'invalid-request', 'Expected application/json');
          this.json(response, 202, this.operations.stop(id, decodeStopRequest(await this.body(request)))); return;
        }
      }
      throw new HttpError(405, 'method-not-allowed', 'Method is not allowed');
    }
    if (path.startsWith('/api/')) throw new HttpError(404, 'not-found', 'Route does not exist');
    if (request.method !== 'GET' || !this.options.staticDirectory) throw new HttpError(404, 'not-found', 'Route does not exist');
    await this.staticFile(raw, path, response);
  }
  private sameOriginPage(request: IncomingMessage): boolean {
    if (header(request, 'sec-fetch-site') !== 'same-origin') return false;
    try { return new URL(header(request, 'referer') ?? '').origin === this.endpoint; } catch { return false; }
  }
  private authenticate(request: IncomingMessage): void {
    const authorization = header(request, 'authorization');
    if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'unauthorized', 'Bearer token is required');
    const token = authorization.slice(7); const expiry = [...this.tokens].find(([issued]) => sameToken(issued, token))?.[1];
    if (expiry === undefined || expiry <= Date.now()) throw new HttpError(401, 'unauthorized', 'Bearer token expired or is invalid');
  }
  private cursor(url: URL): number { const value = url.searchParams.get('after'); if (value === null || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new JournalCursorError('Invalid event cursor'); return Number(value); }
  private epoch(url: URL): string { const epoch = url.searchParams.get('epoch'); if (!epoch) throw new JournalCursorError('Epoch is required'); return epoch; }
  private sse<T extends RegistryEvent | RunEvent>(request: IncomingMessage, response: ServerResponse, subscribe: (listener: (event: T) => void) => () => void, runId?: string): void {
    const max = this.options.maxSseBytes ?? 128 * 1024;
    let ready = false; let closed = false; let pending: string[] = []; let bytes = 0;
    const send = (payload: string) => { if (closed) return; if (response.writableLength + Buffer.byteLength(payload) > max) { response.destroy(); return; } response.write(payload); };
    const unsubscribe = subscribe(event => {
      const payload = `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
      if (ready) send(payload); else { bytes += Buffer.byteLength(payload); if (bytes > max) throw new HttpError(409, 'reset-required', 'Event replay exceeds the connection byte bound'); pending.push(payload); }
    });
    if (bytes > max) { unsubscribe(); throw new HttpError(409, 'reset-required', 'Event replay exceeds the connection byte bound'); }
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    this.streams.add(response); this.streamRuns.set(response, runId); ready = true; send(': connected\n\n'); for (const payload of pending) send(payload); pending = [];
    const timer = setInterval(() => send(': heartbeat\n\n'), 15_000); timer.unref();
    response.on('close', () => { closed = true; clearInterval(timer); unsubscribe(); this.streams.delete(response); this.streamRuns.delete(response); });
    request.on('aborted', () => response.destroy());
  }
  private async body(request: IncomingMessage): Promise<unknown> {
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) { const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length; if (bytes > 16 * 1024) throw new HttpError(413, 'invalid-request', 'Request body is too large'); chunks.push(buffer); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid-request', 'Invalid JSON'); }
  }
  private async staticFile(raw: string, path: string, response: ServerResponse): Promise<void> {
    let decoded: string;
    try { decoded = decodeURIComponent(raw.split('?')[0]!); } catch { throw new HttpError(400, 'invalid-request', 'Invalid path'); }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) throw new HttpError(403, 'forbidden', 'Invalid static path');
    const root = await realpath(this.options.staticDirectory!);
    let file: string;
    try { file = await realpath(resolve(root, `.${path === '/' ? '/index.html' : decodeURIComponent(path)}`)); } catch { throw new HttpError(404, 'not-found', 'File does not exist'); }
    const difference = relative(root, file);
    if (difference === '..' || difference.startsWith(`..${sep}`) || isAbsolute(difference)) throw new HttpError(403, 'forbidden', 'Static path leaves its root');
    if (!(await stat(file)).isFile()) throw new HttpError(404, 'not-found', 'File does not exist');
    const data = await readFile(file);
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
    response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }).end(data);
  }
  private json(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value)); }
  private fail(response: ServerResponse, error: unknown): void {
    if (response.headersSent) { response.destroy(); return; }
    if (error instanceof HttpError || error instanceof OperationRequestError) { this.json(response, error.status, { error: { code: error.code, message: error.message } }); return; }
    if (error instanceof JournalCursorError) { this.json(response, 409, { error: { code: 'reset-required', message: error.message } }); return; }
    this.json(response, 404, { error: { code: 'unavailable', message: error instanceof Error ? error.message : String(error) } });
  }
}

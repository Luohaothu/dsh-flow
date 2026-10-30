import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';

const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const versioned = value => value?.version?.major === 1 && Number.isSafeInteger(value.version.minor) && value.version.minor >= 1 && Number.isSafeInteger(value.seq) && value.seq >= 0;
const ownerKey = origin => JSON.stringify([origin?.backend, origin?.callerSessionId]);
const fault = code => Object.assign(new Error(code), { code });
const terminalAssignments = new Set(['submitted', 'failed', 'cancelled']);

function endpoint(value) {
  if (typeof value !== 'string') throw fault('dashboard-address-missing');
  let url;
  try { url = new URL(value); } catch { throw fault('dashboard-address-invalid'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1 || url.username || url.password || value !== url.origin) throw fault('dashboard-address-invalid');
  return url.origin;
}

function preserveIdentities(snapshot, previous = { nodes: new Map(), assignments: new Map(), groups: new Map() }) {
  if (!['nodes', 'assignments', 'groups'].every(key => Array.isArray(snapshot[key]))) throw fault('snapshot-identity-collections-invalid');
  const current = {
    nodes: snapshot.nodes.map(node => [node?.id, [node?.sessionID]]),
    assignments: snapshot.assignments.map(job => [job?.id, [job?.runId, job?.recipientSessionID, job?.recipientInstanceId]]),
    groups: snapshot.groups.map(group => [group?.id, []]),
  };
  for (const [kind, rows] of Object.entries(current)) {
    const seen = new Map();
    for (const [id, identity] of rows) {
      if (!text(id) || !identity.every(text) || seen.has(id)) throw fault('snapshot-identity-invalid-or-duplicate');
      if (kind === 'assignments' && identity[0] !== snapshot.run.id) throw fault('snapshot-assignment-run-invalid');
      const encoded = JSON.stringify(identity);
      if (previous[kind].has(id) && previous[kind].get(id) !== encoded) throw fault('snapshot-identity-changed');
      seen.set(id, encoded);
    }
    if ([...previous[kind].keys()].some(id => !seen.has(id))) throw fault('snapshot-observed-identity-missing');
    for (const [id, value] of seen) previous[kind].set(id, value);
  }
  return previous;
}

function readResponse(url, method, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers, signal, agent: false }, response => {
      if (response.statusCode !== (method === 'POST' ? 202 : 200)) {
        response.destroy(); reject(fault(`dashboard-http-${response.statusCode}`)); return;
      }
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.once('error', reject);
      response.once('aborted', () => reject(fault('dashboard-response-aborted')));
      response.once('end', () => resolve({ status: response.statusCode, raw }));
    });
    request.once('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function clean(snapshot, operationId) {
  const operation = snapshot.operations.find(item => item.id === operationId);
  if (operation?.status === 'failed') throw fault('stop-operation-failed');
  return operation?.status === 'completed' && operation.target?.scope === 'run' && operation.target.agentId === undefined
    && ['stopped', 'failed'].includes(snapshot.run.status) && snapshot.run.pendingAssignmentCount === 0 && snapshot.run.storageError === undefined
    && !snapshot.degraded
    && snapshot.nodes.every(node => node.status === 'terminated' && node.cleanup?.phase === 'complete' && node.cleanup.persistenceError === undefined)
    && snapshot.assignments.every(assignment => terminalAssignments.has(assignment.status))
    && snapshot.groups.every(group => group.dissolved === true);
}

export async function drainFlow({ evidence, origin, write, signal, timeoutMs = 150_000, stableMs = 1000, refreshEvidence = () => evidence, boundaryEvidence }) {
  const receipt = { schema: 'flow-natural-technical-drain/v1', status: 'pending', startedAt: Date.now(), timeoutMs, stableWindowMs: stableMs,
    scope: 'observed-and-registry-owned-runs', ...(boundaryEvidence ? { boundaryEvidence } : {}), businessBoundary: { status: evidence.status, reason: evidence.reason, endedAt: evidence.endedAt }, targets: [], responses: [], tokenRefreshes: 0 };
  const controller = new AbortController();
  const interrupted = () => controller.abort();
  signal?.addEventListener('abort', interrupted, { once: true });
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const issuedTokens = new Set();
  let token;
  try {
    const snapshots = evidence.snapshots ?? [];
    if (!Array.isArray(snapshots)) throw fault('observed-snapshots-invalid');
    if (!evidence.dashboardAddress && snapshots.length === 0) {
      receipt.status = 'skipped'; receipt.reason = 'no-observed-flow';
      return receipt;
    }
    const base = endpoint(evidence.dashboardAddress);
    const owners = new Set((evidence.mains ?? []).map(main => ownerKey({ backend: 'dsh', callerSessionId: main.sessionId })));
    if (!owners.size) throw fault('owned-main-missing');
    const observed = new Map(), identities = new Map();
    for (const snapshot of snapshots) {
      const run = snapshot?.run;
      if (!text(run?.id) || !text(run.epoch) || !owners.has(ownerKey(run.entry))) throw fault('observed-run-owner-invalid');
      if (observed.has(run.id)) throw fault('observed-run-duplicate');
      observed.set(run.id, run); identities.set(run.id, preserveIdentities(snapshot));
    }
    const saved = new Map();
    let sequence = 0;
    const request = async (path, { method = 'GET', body, kind, target } = {}, retryAuthentication = true) => {
      const headers = { Origin: origin, ...(token && path !== '/api/token' ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
      let response;
      try { response = await readResponse(base + path, method, headers, body, controller.signal); }
      catch (error) {
        if (error.code !== 'dashboard-http-401' || !token || path === '/api/token' || !retryAuthentication) throw error;
        await renewAuthentication();
        return request(path, { method, body, kind, target }, false);
      }
      const { status, raw } = response;
      let value;
      try { value = JSON.parse(raw); } catch { throw fault('dashboard-json-invalid'); }
      if (kind) {
        if ([...issuedTokens].some(issued => raw.includes(issued))) throw fault('dashboard-credential-in-response');
        const sha256 = createHash('sha256').update(raw).digest('hex');
        const key = JSON.stringify([kind, target, sha256]);
        let record = saved.get(key);
        if (!record) {
          const file = `flow-drain-${kind}-${String(++sequence).padStart(4, '0')}.json`;
          write(file, raw);
          record = { file, kind, ...(target ? { runId: target } : {}), sha256, httpStatus: status, observedAt: Date.now() };
          saved.set(key, record); receipt.responses.push(record);
        }
        return { value, file: record.file };
      }
      return { value };
    };
    const renewAuthentication = async () => {
      const bootstrap = (await request('/api/token')).value;
      if (!text(bootstrap?.token) || !text(bootstrap.epoch) || bootstrap.version?.major !== 1 || !Number.isInteger(bootstrap.version.minor) || bootstrap.version.minor < 1) throw fault('dashboard-token-protocol-invalid');
      if (receipt.epoch !== undefined && bootstrap.epoch !== receipt.epoch) throw fault('dashboard-token-epoch-changed');
      if (token) receipt.tokenRefreshes++;
      token = bootstrap.token; issuedTokens.add(token);
      receipt.epoch = bootstrap.epoch;
    };
    await renewAuthentication();
    if ([...observed.values()].some(run => run.epoch !== receipt.epoch)) throw fault('observed-epoch-mismatch');
    const targets = new Map();
    let stableSince, previousIds;
    for (;;) {
      controller.signal.throwIfAborted();
      const registryResponse = await request('/api/runs', { kind: 'registry' });
      const registry = registryResponse.value;
      if (!versioned(registry) || registry.epoch !== receipt.epoch || !Array.isArray(registry.runs) || registry.degraded) throw fault('registry-protocol-or-epoch-invalid');
      receipt.registryFile = registryResponse.file;
      const ids = new Set();
      for (const run of registry.runs) {
        if (!text(run?.id) || !text(run.epoch) || !text(run.entry?.backend) || !text(run.entry.callerSessionId) || ids.has(run.id)) throw fault('registry-run-invalid');
        ids.add(run.id);
        if (!owners.has(ownerKey(run.entry))) continue;
        if (run.epoch !== receipt.epoch || run.status === 'invalid') throw fault('owned-registry-epoch-invalid');
        if (observed.has(run.id) && ownerKey(observed.get(run.id).entry) !== ownerKey(run.entry)) throw fault('observed-run-owner-changed');
        if (!targets.has(run.id)) {
          const target = { runId: run.id, epoch: run.epoch, origin: run.entry, operationId: randomUUID(), status: 'pending' };
          targets.set(run.id, target); receipt.targets.push(target);
        } else if (ownerKey(targets.get(run.id).origin) !== ownerKey(run.entry)) throw fault('owned-run-owner-changed');
      }
      if ([...observed.keys(), ...targets.keys()].some(id => !ids.has(id))) throw fault('owned-run-missing');
      for (const target of targets.values()) {
        const path = `/api/runs/${encodeURIComponent(target.runId)}`;
        const snapshotResponse = await request(path, { kind: 'snapshot', target: target.runId });
        const snapshot = snapshotResponse.value;
        if (!versioned(snapshot) || snapshot.run?.id !== target.runId || snapshot.run.epoch !== target.epoch || ownerKey(snapshot.run.entry) !== ownerKey(target.origin)
          || !['nodes', 'groups', 'assignments', 'prices', 'operations'].every(key => Array.isArray(snapshot[key]))) throw fault('snapshot-protocol-or-owner-invalid');
        target.status = 'pending';
        const required = preserveIdentities(snapshot, identities.get(target.runId));
        identities.set(target.runId, required);
        target.observedIdentities = {
          nodes: [...required.nodes].map(([id, value]) => ({ id, sessionID: JSON.parse(value)[0] })),
          assignments: [...required.assignments].map(([id, value]) => { const [runId, recipientSessionID, recipientInstanceId] = JSON.parse(value); return { id, runId, recipientSessionID, recipientInstanceId }; }),
          groups: [...required.groups.keys()],
        };
        target.snapshotFile = snapshotResponse.file;
        if (!target.acceptedFile) {
          const accepted = await request(path + '/stop', { method: 'POST', body: { operationId: target.operationId, targetEpoch: target.epoch, scope: 'run' }, kind: 'operation', target: target.runId });
          if (accepted.value?.operationId !== target.operationId || accepted.value.status !== 'accepted') throw fault('stop-acceptance-invalid');
          target.acceptedFile = accepted.file;
        } else if (clean(snapshot, target.operationId)) {
          target.status = 'completed'; target.terminalSnapshotFile = snapshotResponse.file;
        } else target.status = 'pending';
      }
      receipt.lastObservedAt = Date.now();
      const current = refreshEvidence();
      const requestsSettled = Array.isArray(current?.requests) && current.requests.every(request => ['completed', 'failed', 'cancelled'].includes(request.status));
      receipt.runningRequests = Array.isArray(current?.requests) ? current.requests.filter(request => request.status === 'running').length : null;
      receipt.requestBoundary = { requests: current?.requests?.length ?? null, totalReportedTokens: current?.totalReportedTokens ?? null, usageMissingRequests: current?.usageMissingRequests ?? null,
        ...(current?.requestEvidence ? { source: current.requestEvidence } : {}) };
      const currentIds = JSON.stringify([...targets.keys()].sort());
      const complete = requestsSettled && [...targets.values()].every(target => target.status === 'completed');
      if (complete && previousIds === currentIds) stableSince ??= Date.now();
      else stableSince = undefined;
      previousIds = currentIds;
      if (stableSince !== undefined && Date.now() - stableSince >= stableMs) {
        receipt.status = 'completed'; receipt.stableSince = stableSince; receipt.reason = 'observed-owned-runs-drained';
        break;
      }
      await pause(100, undefined, { signal: controller.signal });
    }
  } catch (error) {
    for (const target of receipt.targets) target.status = 'pending';
    receipt.reason = timedOut ? 'drain-timeout' : controller.signal.aborted ? 'drain-interrupted' : typeof error.code === 'string' && /^(dashboard-|owned-|observed-|registry-|snapshot-|stop-|evidence-)/.test(error.code) ? error.code : 'drain-request-or-output-error';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', interrupted);
    token = undefined;
    issuedTokens.clear();
    receipt.endedAt = Date.now();
    write('flow-drain.json', JSON.stringify(receipt, null, 2));
  }
  return receipt;
}

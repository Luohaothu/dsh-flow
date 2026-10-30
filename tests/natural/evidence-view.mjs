import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const settlement = new Set(['status', 'usage', 'finishReason', 'output', 'error', 'endedAt']);
const phases = new Set(['post-boundary-stream', 'agent-disposed', 'observer-dispose', 'process-exit']);
const fault = code => Object.assign(new Error(code), { code });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = request => Object.fromEntries(Object.entries(request).filter(([key]) => !settlement.has(key)));

function requestsByNumber(requests) {
  if (!Array.isArray(requests)) throw fault('evidence-request-list-invalid');
  const result = new Map();
  for (const request of requests) {
    if (!request || !Number.isSafeInteger(request.number) || request.number < 1 || result.has(request.number)
      || request.status !== 'running' && !terminal.has(request.status)) throw fault('evidence-request-invalid-or-duplicate');
    result.set(request.number, request);
  }
  return result;
}

export function mergeRequestSettlements(boundary, latest, previous = boundary) {
  const originals = requestsByNumber(boundary.requests), current = requestsByNumber(latest.requests), prior = requestsByNumber(previous.requests);
  if (originals.size !== current.size || [...originals.keys()].some(number => !current.has(number))) throw fault('evidence-request-set-changed');
  const requests = [];
  for (const [number, original] of originals) {
    const next = current.get(number), before = prior.get(number);
    if (!before || !isDeepStrictEqual(identity(original), identity(next))) throw fault('evidence-request-identity-changed');
    if (original.status !== 'running' && !isDeepStrictEqual(original, next)
      || before.status !== 'running' && !isDeepStrictEqual(before, next)) throw fault('evidence-request-terminal-changed');
    if (next.usage !== undefined && (!next.usage || typeof next.usage !== 'object' || Array.isArray(next.usage))) throw fault('evidence-request-usage-invalid');
    if (next.usage?.totalTokens !== undefined && (!Number.isFinite(next.usage.totalTokens) || next.usage.totalTokens < 0)) throw fault('evidence-request-usage-invalid');
    requests.push(structuredClone(next));
  }
  return { requests, totalReportedTokens: requests.reduce((total, request) => total + (request.usage?.totalTokens ?? 0), 0),
    usageMissingRequests: requests.filter(request => request.status !== 'running' && request.usage?.totalTokens === undefined).map(request => request.number) };
}

export function createDrainEvidenceReader({ boundary, read, preserve }) {
  const frozen = JSON.parse(boundary.bytes.toString('utf8'));
  if (!isDeepStrictEqual(frozen, boundary.value)) throw fault('evidence-boundary-record-invalid');
  const digest = sha256(boundary.bytes);
  let previous = frozen, sawShutdown = false;
  return () => {
    const current = read('evidence.json'), shutdown = read('shutdown-evidence.json');
    if (shutdown) sawShutdown = true;
    if (sawShutdown && !shutdown) throw fault('evidence-shutdown-missing');
    if (!current || current.pending || shutdown?.pending) return;
    let latest = current.value, source = { file: 'evidence.json', sha256: sha256(current.bytes), bytes: current.bytes.length, mode: 'legacy-observer' };
    if (shutdown) {
      const witness = shutdown.value, binding = witness?.businessBoundary;
      if (witness?.schema !== 'flow-natural-shutdown/v1' || witness.scoringEligible !== false || !phases.has(witness.phase)
        || !Number.isSafeInteger(witness.observedAt) || !Number.isSafeInteger(witness.capturedAt)
        || !Array.isArray(witness.histories) || !Array.isArray(witness.snapshots) || !Array.isArray(witness.captureErrors)) throw fault('evidence-shutdown-schema-invalid');
      if (binding?.file !== 'evidence.json' || binding.sha256 !== digest || sha256(current.bytes) !== digest
        || !['status', 'reason', 'endedAt'].every(key => isDeepStrictEqual(binding[key], frozen[key]))) throw fault('evidence-shutdown-boundary-mismatch');
      if (witness.captureErrors.length) throw fault('evidence-shutdown-capture-errors');
      latest = witness;
      source = { file: 'shutdown-evidence.json', sha256: sha256(shutdown.bytes), bytes: shutdown.bytes.length, phase: witness.phase, mode: 'shutdown-witness', scoringEligible: false, businessSha256: digest };
    } else if (!['status', 'reason', 'endedAt'].every(key => isDeepStrictEqual(current.value?.[key], frozen[key]))) throw fault('evidence-business-boundary-changed');
    const view = mergeRequestSettlements(frozen, latest, previous);
    if (preserve) source = { ...source, frozenFile: preserve(shutdown ?? current, source) };
    previous = view;
    return { ...view, requestEvidence: source };
  };
}

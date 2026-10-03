/**
 * Shared vocabulary for the development and acceptance chain.
 *
 * This module is development-only: it is not part of the published plugin, and
 * it deliberately depends on nothing but the standard library so that the root
 * Host program can check it without the package having been built. The plugin's
 * own wire DTOs live in the package; the case fixtures and the runner's report
 * are shaped here, where the runner owns them.
 */
import type { Serializable } from 'node:child_process';

import type { MockRequestRecord, MockScenario } from './mock-model.ts';

/** The directories of one exclusive run, created by {@link createRunLayout}. */
export interface RunLayout {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
  readonly data: string;
  readonly workspace: string;
  readonly artifacts: string;
  readonly logs: string;
}

/** Every development operation the acceptance runner may send over IPC. */
export type DshHostOp =
  | 'ping' | 'start' | 'list' | 'read' | 'events' | 'control' | 'report'
  | 'query' | 'settle' | 'tick' | 'single' | 'recover' | 'dispose';

/**
 * One request sent to the host process. `op` is the development operation and
 * `requestId` is the envelope correlation id; the cluster id travels separately
 * in `cluster`, or it would overwrite the correlation id and the reply could
 * never be matched to this request.
 */
export interface DshIpcRequest {
  flow: true;
  requestId: string;
  op: DshHostOp;
  cluster?: string;
  payload?: Serializable;
}

/** The host's readiness note, sent once the cluster service is live. */
export interface DshIpcReady {
  flow: true;
  ready: true;
}

/** One completed operation. */
export interface DshIpcReply {
  flow: true;
  requestId: string;
  ok: true;
  result: unknown;
}

/** One refused operation. */
export interface DshIpcFailure {
  flow: true;
  requestId: string;
  ok: false;
  error: { message?: string; status?: number; code?: string };
}

/** Everything the host may send back to the runner. */
export type DshIpcOutbound = DshIpcReady | DshIpcReply | DshIpcFailure;

/** The one-workstream transaction fixture a case starts with. */
export type CaseTransactionFixture = Record<string, unknown>;

/** How a case's workspace is prepared before the host starts. */
export interface CaseWorkspaceConfig {
  kind?: 'empty' | 'seed' | 'generated-corpus' | 'copy-repo';
  seed?: string;
  source?: string;
  exclude?: readonly string[];
  hashExclude?: readonly string[];
  allowedLinkRoots?: readonly string[];
  prepare?: string;
  [key: string]: unknown;
}

/** The generated corpus one scale case reads. */
export interface CaseDataset {
  file?: string;
  count?: number;
  [key: string]: unknown;
}

/** The per-tier knobs a scale case overrides. */
export interface CaseScaleFixture {
  workers?: number;
  worker_model_requests?: number;
  worker_max_tokens?: number;
  concurrency_probe?: boolean;
  concurrency_probe_window_ms?: number;
  generated_tier?: number;
  [key: string]: unknown;
}

/** How a recovery case kills and restarts its host. */
export interface CaseRecovery {
  require_restart?: boolean;
  kill_after_ms?: number;
  kill_on_event?: string;
  kill_on_hold?: string;
  restart_delay_ms?: number;
  [key: string]: unknown;
}

/**
 * One acceptance case definition, as its `cases/<id>.json` file declares it.
 * Every field but `id` is optional so one shape covers all cases; `id` is
 * attached by the runner from the file name.
 */
export interface CaseDefinition {
  readonly id: string;
  readonly title?: string;
  readonly objective?: string;
  readonly capabilities?: readonly string[];
  readonly limits?: Record<string, unknown>;
  readonly budget?: Record<string, unknown>;
  readonly timeout_ms?: number;
  readonly initial_transactions?: readonly CaseTransactionFixture[];
  readonly acceptance_criteria?: readonly string[];
  readonly delegation?: readonly CaseTransactionFixture[];
  readonly message_fixture?: readonly CaseTransactionFixture[];
  readonly patches?: readonly string[];
  readonly patch?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly workspace?: CaseWorkspaceConfig;
  readonly dataset?: CaseDataset;
  readonly scale_fixture?: CaseScaleFixture;
  readonly recovery?: CaseRecovery;
  readonly live_first?: boolean;
  readonly modes?: readonly string[];
  readonly generated_tier?: number;
  readonly verification?: unknown;
  readonly referenceClock?: string;
  readonly allowed_hosts?: readonly string[];
  readonly dimensions?: readonly string[];
  readonly minimum_pages?: number;
  readonly minimum_pages_per_project?: number;
  readonly seed_urls?: readonly string[];
  readonly [key: string]: unknown;
}

/** One run's full report, written to `report.json` beside its artifacts. */
export interface RunReport {
  run_id: string;
  case: string;
  mode: string;
  title?: string;
  started_at: string;
  validation_mode: 'mock-api' | 'live-model';
  model_route: unknown;
  patch?: string;
  patches: readonly string[];
  profile: string;
  paths: RunLayout;
  build_hashes: unknown;
  input_hashes: unknown;
  mechanism_pass: string;
  scenario_status: string;
  quality_checks: unknown[];
  failure_class: string | null;
  notes: string[];
  finished_at?: string;
  wall_time_ms?: number;
  cluster_id?: string;
  web_url?: string | null;
  host_exit?: unknown;
  preparation?: unknown;
  baseline?: unknown;
  mock?: unknown;
  mock_fixture?: unknown;
  mock_requests?: unknown[];
  mock_concurrency?: unknown;
  fixture_id_map?: unknown;
  spec?: unknown;
  single?: unknown;
  report?: unknown;
  ledger?: unknown;
  failure?: unknown;
  concurrency_probe?: unknown;
  restart?: unknown;
  kill_trigger?: unknown;
  live_checks?: unknown;
  limit_reached?: unknown;
  budget_proximity?: unknown;
  mechanism_notes?: readonly string[];
  unmeasured_invariants?: readonly string[];
  not_exercised_invariants?: readonly string[];
  scale_validation?: unknown;
  scale_metrics?: unknown;
  measured_per_file?: unknown;
  build_drift?: unknown;
  not_comparable?: boolean;
  experiment?: unknown;
  [key: string]: unknown;
}

/** What one run returns to its caller. */
export interface RunResult {
  run_id: string;
  mode: string;
  scenario_status: string;
  mechanism_pass: string;
  failure_class: string | null;
  wall_time_ms?: number;
  cluster_id: string | null;
  report: string;
}

/** One recorded provider request, as the mock model exposes it. */
export type MockRequest = MockRequestRecord;

export type { MockScenario };
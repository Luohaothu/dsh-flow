/**
 * Hierarchical budget ledger.
 *
 * Every scope (root cluster → management node → transaction/agent) owns one
 * row with `limit / reserved / spent` per dimension. Transfers only move
 * unused AND unreserved budget. Wall time is an absolute deadline inherited
 * from the earliest ancestor; pause or restart never resets it.
 */
import { fail } from '../errors.ts';
import { BUDGET_KEYS, integer, objectField, rejectUnknownFields } from '../validation.ts';
import type {
  FlowBudgetDimensionView,
  FlowBudgetEvaluation,
  FlowBudgetInput,
  FlowBudgetView,
  FlowScopeKind,
} from '../types.ts';
import type { BudgetPatch, BudgetRecord } from './model.ts';
import type { ClusterStore } from './store.ts';

/**
 * The three dimensions the ledger funds. `agents` and `max_active_agents` are
 * *capacity*, not consumable resources: a slot is held while an identity exists
 * and returned when it is released, so there is nothing to consume.
 */
export type BudgetDimension = 'tool_calls' | 'agents' | 'max_active_agents';

/** Every numeric column of a budget row: one per dimension role. */
export type BudgetNumericColumn =
  | 'tool_calls_limit' | 'tool_calls_reserved' | 'tool_calls_spent'
  | 'agents_limit' | 'agents_reserved'
  | 'max_active_limit' | 'max_active_reserved';

/**
 * One dimension's columns. `spent` is `null` for pure capacity dimensions:
 * `settleChain`/`spendChain` skip them instead of silently discarding a write
 * into a column that does not exist.
 */
export interface DimensionSpec {
  readonly key: BudgetDimension;
  readonly limit: BudgetNumericColumn;
  readonly reserved: BudgetNumericColumn;
  readonly spent: BudgetNumericColumn | null;
}

const TOOL_CALLS: DimensionSpec = { key: 'tool_calls', limit: 'tool_calls_limit', reserved: 'tool_calls_reserved', spent: 'tool_calls_spent' };
const AGENTS: DimensionSpec = { key: 'agents', limit: 'agents_limit', reserved: 'agents_reserved', spent: null };
const MAX_ACTIVE_AGENTS: DimensionSpec = { key: 'max_active_agents', limit: 'max_active_limit', reserved: 'max_active_reserved', spent: null };

export const DIMENSIONS: readonly DimensionSpec[] = [TOOL_CALLS, AGENTS, MAX_ACTIVE_AGENTS];

/** Named lookup so a proven dimension literal needs no re-listing. */
const DIMENSION_SPECS: Record<BudgetDimension, DimensionSpec> = {
  tool_calls: TOOL_CALLS,
  agents: AGENTS,
  max_active_agents: MAX_ACTIVE_AGENTS,
};

/** A patch under construction: the wire patch is readonly, the builder is not. */
type MutableBudgetPatch = { -readonly [K in keyof BudgetPatch]?: BudgetPatch[K] };

/** Look one dimension up by an untrusted key (a raw JSON property name). */
function specByKey(key: string): DimensionSpec | null {
  for (const spec of DIMENSIONS) if (spec.key === key) return spec;
  return null;
}

export class BudgetError extends Error {
  readonly status: number;
  readonly code: string;
  scope: string | null = null;
  scope_kind: FlowScopeKind | null = null;
  dimension: string | null = null;
  requested: number | null = null;
  available: number | null = null;
  label: string | null = null;

  constructor(message: string, status = 409, code = 'LIMIT_REACHED') {
    super(message);
    this.name = 'BudgetError';
    this.status = status;
    this.code = code;
  }
}

/** Everything `createBudget` needs; unlike the wire budget it carries scope identity. */
export interface CreateBudgetInput {
  readonly cluster_id: string;
  readonly scope_kind: FlowScopeKind;
  readonly scope_id: string;
  readonly node_id?: string | null;
  readonly parent_budget_id?: string | null;
  readonly limit?: FlowBudgetInput;
  readonly reserved?: FlowBudgetInput;
  readonly spent?: FlowBudgetInput;
  readonly wall_limit_ms?: number;
  readonly wall_deadline?: number | null;
}

export function createBudget(store: ClusterStore, {
  cluster_id, scope_kind, scope_id, node_id = null, parent_budget_id = null,
  limit = {}, reserved = {}, spent = {}, wall_limit_ms = 0, wall_deadline = null,
}: CreateBudgetInput): BudgetRecord {
  for (const [label, values] of [['limit', limit], ['reserved', reserved], ['spent', spent]] as const) {
    rejectUnknownFields(objectField(values, label), BUDGET_KEYS, label);
  }
  const existing = store.budgetForScope(cluster_id, scope_kind, scope_id);
  if (existing) return existing;
  const inserted = store.insertBudget({
    id: `${cluster_id}:${scope_kind}:${scope_id}`,
    cluster_id, scope_kind, scope_id, node_id, parent_budget_id,
    tool_calls_limit: limit.tool_calls ?? 0, tool_calls_reserved: reserved.tool_calls ?? 0, tool_calls_spent: spent.tool_calls ?? 0,
    agents_limit: limit.agents ?? 0, agents_reserved: reserved.agents ?? 0,
    max_active_limit: limit.max_active_agents ?? 0, max_active_reserved: reserved.max_active_agents ?? 0,
    wall_limit_ms,
    wall_deadline: wall_deadline ?? (wall_limit_ms > 0 ? store.now() + wall_limit_ms : null),
  });
  if (!inserted) fail('Budget not found', 404);
  return inserted;
}

/** Read one dimension through the single column mapping. */
function dimensionView(row: BudgetRecord, spec: DimensionSpec): FlowBudgetDimensionView {
  const limit = row[spec.limit] ?? 0;
  const reserved = row[spec.reserved] ?? 0;
  const spent = spec.spent === null ? 0 : row[spec.spent] ?? 0;
  return { limit, reserved, spent, available: Math.max(0, limit - reserved - spent) };
}

/** Project a row that is already known to exist. */
function projectBudget(row: BudgetRecord): FlowBudgetView {
  const dimensions: Record<BudgetDimension, FlowBudgetDimensionView> = {
    tool_calls: dimensionView(row, DIMENSION_SPECS.tool_calls),
    agents: dimensionView(row, DIMENSION_SPECS.agents),
    max_active_agents: dimensionView(row, DIMENSION_SPECS.max_active_agents),
  };
  return {
    id: row.id,
    scope_kind: row.scope_kind,
    scope_id: row.scope_id,
    node_id: row.node_id,
    parent_budget_id: row.parent_budget_id,
    revision: row.revision,
    ...dimensions,
    wall_limit_ms: row.wall_limit_ms,
    wall_deadline: row.wall_deadline,
  };
}

export function budgetView(row: BudgetRecord | null | undefined): FlowBudgetView | null {
  return row ? projectBudget(row) : null;
}

export function dimensionAvailable(row: BudgetRecord, key: string): number {
  const dim = specByKey(key);
  if (!dim) fail(`Unknown budget dimension: ${key}`);
  return dimensionView(row, dim).available;
}

function applyDeltas(store: ClusterStore, budgetId: string, deltas: ReadonlyMap<BudgetNumericColumn, number>): BudgetRecord {
  const row = store.getBudget(budgetId);
  if (!row) fail('Budget not found', 404);
  const patch: MutableBudgetPatch = {};
  let changed = false;
  for (const [column, delta] of deltas) {
    if (!delta) continue;
    const next = (row[column] ?? 0) + delta;
    if (next < 0) fail(`Budget ${budgetId} would go negative on ${column}`, 409);
    if (!Number.isSafeInteger(next)) fail(`Budget ${budgetId} exceeds safe integer range on ${column}`, 409);
    patch[column] = next;
    changed = true;
  }
  if (!changed) return row;
  const updated = store.updateBudget(budgetId, patch);
  if (!updated) fail('Budget not found', 404);
  return updated;
}

/** Validate once at the ledger seam, before any scope is changed. */
function budgetAmounts(amounts: unknown, label: string): Map<BudgetDimension, number> {
  const source = objectField(amounts, label);
  const result = new Map<BudgetDimension, number>();
  for (const [key, value] of Object.entries(source)) {
    const dim = specByKey(key);
    if (!dim) fail(`Unknown budget dimension: ${key}`);
    const amount = integer(value ?? 0, 0, Number.MAX_SAFE_INTEGER, `${label}.${key}`);
    if (amount > 0) result.set(dim.key, amount);
  }
  return result;
}

function chainRows(store: ClusterStore, budgetIds: readonly string[]): BudgetRecord[] {
  if (!Array.isArray(budgetIds)) fail('Budget scopes must be an array');
  const seen = new Set<string>();
  return budgetIds.map(id => {
    if (seen.has(id)) fail(`Duplicate budget scope: ${id}`, 409);
    seen.add(id);
    const row = store.getBudget(id);
    if (!row) fail(`Budget not found: ${id}`, 404);
    return row;
  });
}

/** Reserve on a whole ancestor chain atomically; nothing is written if any scope is short. */
export function reserveChain(
  store: ClusterStore,
  budgetIds: readonly string[],
  amounts: unknown,
  { label = 'resource reservation' }: { label?: string } = {},
): string[] {
  const wanted = budgetAmounts(amounts, 'reservation');
  return store.tx(() => {
    const rows = chainRows(store, budgetIds);
    for (const row of rows) {
      for (const spec of DIMENSIONS) {
        const amount = wanted.get(spec.key);
        if (!amount) continue;
        const available = dimensionAvailable(row, spec.key);
        if (available < amount) {
          const error = new BudgetError(
            `${row.scope_kind} ${row.scope_id} budget exhausted for ${spec.key}: requested ${amount}, available ${available} (${label})`,
            409, 'LIMIT_REACHED',
          );
          // Structured facts ride the error: a refusal the ledger can classify
          // without parsing prose.
          error.scope = row.scope_id;
          error.scope_kind = row.scope_kind;
          error.dimension = spec.key;
          error.requested = amount;
          error.available = available;
          error.label = label;
          throw error;
        }
      }
      const deadline = effectiveDeadline(store, row);
      if (deadline !== null && deadline <= store.now()) {
        const error = new BudgetError(`${row.scope_kind} ${row.scope_id} wall-time deadline passed (${label})`, 409, 'LIMIT_REACHED');
        error.scope = row.scope_id;
        error.scope_kind = row.scope_kind;
        error.dimension = 'wall_time_ms';
        error.requested = null;
        error.available = 0;
        error.label = label;
        throw error;
      }
    }
    for (const row of rows) {
      const deltas = new Map<BudgetNumericColumn, number>();
      for (const spec of DIMENSIONS) {
        const amount = wanted.get(spec.key);
        if (amount) deltas.set(spec.reserved, amount);
      }
      applyDeltas(store, row.id, deltas);
    }
    return rows.map(r => r.id);
  });
}

/** Settle a reservation: move `reserved` into `spent` by the actually consumed amount. */
export function settleChain(
  store: ClusterStore,
  budgetIds: readonly string[],
  { reservedAmounts = {}, consumed = {} }: { reservedAmounts?: unknown; consumed?: unknown } = {},
): void {
  const reserved = budgetAmounts(reservedAmounts, 'settlement reservation');
  const used = budgetAmounts(consumed, 'consumption');
  store.tx(() => {
    for (const row of chainRows(store, budgetIds)) {
      const deltas = new Map<BudgetNumericColumn, number>();
      for (const spec of DIMENSIONS) {
        const reservedAmount = reserved.get(spec.key);
        if (reservedAmount) deltas.set(spec.reserved, -reservedAmount);
        const usedAmount = used.get(spec.key);
        if (usedAmount && spec.spent) deltas.set(spec.spent, usedAmount);
      }
      applyDeltas(store, row.id, deltas);
    }
  });
}

/** Release a reservation without consumption (abort before send, failed admission). */
export function releaseChain(store: ClusterStore, budgetIds: readonly string[], amounts: unknown = {}): void {
  settleChain(store, budgetIds, { reservedAmounts: amounts });
}

export function spendChain(store: ClusterStore, budgetIds: readonly string[], consumed: unknown = {}): void {
  settleChain(store, budgetIds, { consumed });
}

/** Transfer unused + unreserved budget between scopes in one cluster. */
export function transferBudget(
  store: ClusterStore,
  fromId: string,
  toId: string,
  amounts: unknown = {},
): { from: BudgetRecord; to: BudgetRecord } {
  const give = budgetAmounts(amounts, 'rebalance');
  return store.tx(() => {
    const from = store.getBudget(fromId);
    const to = store.getBudget(toId);
    if (!from || !to) fail('Budget not found', 404);
    if (from.cluster_id !== to.cluster_id) fail('Cannot transfer budget between clusters', 403);
    for (const [key, amount] of give) {
      const available = dimensionAvailable(from, key);
      if (available < amount) {
        const error = new BudgetError(`cannot move ${amount} ${key} from ${from.scope_id}: only ${available} unused-unreserved remains`, 409, 'LIMIT_REACHED');
        error.scope = from.scope_id;
        error.scope_kind = from.scope_kind;
        error.dimension = key;
        error.requested = amount;
        error.available = available;
        error.label = 'transfer';
        throw error;
      }
    }
    if (fromId === toId) return { from, to };
    for (const [key, amount] of give) {
      const spec = DIMENSION_SPECS[key];
      applyDeltas(store, fromId, new Map([[spec.limit, -amount]]));
      applyDeltas(store, toId, new Map([[spec.limit, amount]]));
    }
    const settledFrom = store.getBudget(fromId);
    const settledTo = store.getBudget(toId);
    if (!settledFrom || !settledTo) fail('Budget not found', 404);
    return { from: settledFrom, to: settledTo };
  });
}

/** Reclaim capacity (agents / max_active) when an identity is released or replaced. */
export function reclaimCapacity(store: ClusterStore, budgetId: string, amounts: FlowBudgetInput = {}): BudgetRecord | null {
  const deltas = new Map<BudgetNumericColumn, number>();
  if (amounts.agents) deltas.set('agents_reserved', -amounts.agents);
  if (amounts.max_active_agents) deltas.set('max_active_reserved', -amounts.max_active_agents);
  if (!deltas.size) return store.getBudget(budgetId);
  const row = store.getBudget(budgetId);
  if (!row) fail('Budget not found', 404);
  const safe: MutableBudgetPatch = {};
  for (const [column, delta] of deltas) {
    safe[column] = Math.max(0, (row[column] ?? 0) + delta);
  }
  return store.updateBudget(budgetId, safe);
}

export function lineageBudgets(store: ClusterStore, budget: BudgetRecord): BudgetRecord[] {
  const chain: BudgetRecord[] = [];
  let cursor: BudgetRecord | null = budget;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor.id)) fail('Budget lineage cycle', 409);
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.parent_budget_id ? store.getBudget(cursor.parent_budget_id) : null;
  }
  return chain;
}

export function effectiveDeadline(store: ClusterStore, budget: BudgetRecord): number | null {
  let deadline: number | null = null;
  for (const row of lineageBudgets(store, budget)) {
    if (row.wall_deadline === null) continue;
    deadline = deadline === null ? row.wall_deadline : Math.min(deadline, row.wall_deadline);
  }
  return deadline;
}

export function lineageIds(store: ClusterStore, budget: BudgetRecord): string[] {
  return lineageBudgets(store, budget).map(r => r.id);
}

/** One dimension of a cluster-wide rollup: summed `limit`/`reserved`/`spent`. */
export interface FlowBudgetRollupDimension {
  limit: number;
  reserved: number;
  spent: number;
}

export type FlowBudgetRollup = Record<BudgetDimension, FlowBudgetRollupDimension>;

/**
 * Sum every scope in one cluster: the same money counted once. Grants move
 * `limit` downward, so root + descendants always equals the original total.
 */
export function rollupBudgets(store: ClusterStore, clusterId: string): FlowBudgetRollup {
  const total: FlowBudgetRollup = {
    tool_calls: { limit: 0, reserved: 0, spent: 0 },
    agents: { limit: 0, reserved: 0, spent: 0 },
    max_active_agents: { limit: 0, reserved: 0, spent: 0 },
  };
  for (const row of store.listBudgets(clusterId)) {
    for (const spec of DIMENSIONS) {
      total[spec.key].limit += row[spec.limit] ?? 0;
      total[spec.key].reserved += row[spec.reserved] ?? 0;
      total[spec.key].spent += spec.spent === null ? 0 : row[spec.spent] ?? 0;
    }
  }
  return total;
}

/** One evaluated tree row: the projection plus its depth, deadline and parent scope. */
export interface FlowBudgetEvaluationNode extends FlowBudgetEvaluation {
  readonly parent: string | null;
}

export function evaluateTree(store: ClusterStore, clusterId: string): FlowBudgetEvaluationNode[] {
  const rows: BudgetRecord[] = store.listBudgets(clusterId);
  const byId = new Map<string, BudgetRecord>(rows.map(r => [r.id, r]));
  return rows.map(row => ({
    ...projectBudget(row),
    depth: lineageBudgets(store, row).length - 1,
    effective_deadline: effectiveDeadline(store, row),
    parent: row.parent_budget_id ? byId.get(row.parent_budget_id)?.scope_id ?? null : null,
  }));
}

/** True when the scope has no capacity left in any hard dimension. */
export function exhausted(
  store: ClusterStore,
  budget: string | BudgetRecord,
  dimensions: readonly BudgetDimension[] = ['tool_calls'],
): boolean {
  const row = typeof budget === 'string' ? store.getBudget(budget) : budget;
  if (!row) return true;
  const deadline = effectiveDeadline(store, row);
  if (deadline !== null && deadline <= store.now()) return true;
  return dimensions.every(key => dimensionAvailable(row, key) <= 0);
}

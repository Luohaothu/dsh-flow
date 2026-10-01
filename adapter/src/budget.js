/**
 * Hierarchical budget ledger.
 *
 * Every scope (root cluster → management node → transaction/agent) owns one
 * row with `limit / reserved / spent` per dimension. Transfers only move
 * unused AND unreserved budget. Wall time is an absolute deadline inherited
 * from the earliest ancestor; pause or restart never resets it.
 */
import { fail, integer } from './store.js';

export const DIMENSIONS = [
  { key: 'tokens', limit: 'tokens_limit', reserved: 'tokens_reserved', spent: 'tokens_spent' },
  { key: 'model_requests', limit: 'requests_limit', reserved: 'requests_reserved', spent: 'requests_spent' },
  { key: 'tool_calls', limit: 'tool_calls_limit', reserved: 'tool_calls_reserved', spent: 'tool_calls_spent' },
  // `agents` and `max_active_agents` are *capacity*, not consumable resources:
  // a slot is held while an identity exists and returned when it is released,
  // so there is nothing to consume and no `spent` column to write. Declaring
  // them `spent: null` makes `settleChain`/`spendChain` skip them instead of
  // silently discarding a write into a column that does not exist.
  { key: 'agents', limit: 'agents_limit', reserved: 'agents_reserved', spent: null },
  { key: 'max_active_agents', limit: 'max_active_limit', reserved: 'max_active_reserved', spent: null },
];

const DIMENSION_BY_KEY = new Map(DIMENSIONS.map(d => [d.key, d]));

export class BudgetError extends Error {
  constructor(message, status = 409, code = 'LIMIT_REACHED') {
    super(message);
    this.name = 'BudgetError';
    this.status = status;
    this.code = code;
  }
}

export const limitReached = message => {
  throw new BudgetError(message, 409, 'LIMIT_REACHED');
};

export function createBudget(store, {
  cluster_id, scope_kind, scope_id, node_id = null, parent_budget_id = null,
  limit = {}, reserved = {}, spent = {}, wall_limit_ms = 0, wall_deadline = null,
}) {
  const existing = store.budgetForScope(cluster_id, scope_kind, scope_id);
  if (existing) return existing;
  return store.insertBudget({
    id: `${cluster_id}:${scope_kind}:${scope_id}`,
    cluster_id, scope_kind, scope_id, node_id, parent_budget_id,
    tokens_limit: limit.tokens ?? 0, tokens_reserved: reserved.tokens ?? 0, tokens_spent: spent.tokens ?? 0,
    requests_limit: limit.model_requests ?? 0, requests_reserved: reserved.model_requests ?? 0, requests_spent: spent.model_requests ?? 0,
    tool_calls_limit: limit.tool_calls ?? 0, tool_calls_reserved: reserved.tool_calls ?? 0, tool_calls_spent: spent.tool_calls ?? 0,
    agents_limit: limit.agents ?? 0, agents_reserved: reserved.agents ?? 0,
    max_active_limit: limit.max_active_agents ?? 0, max_active_reserved: reserved.max_active_agents ?? 0,
    wall_limit_ms,
    wall_deadline: wall_deadline ?? (wall_limit_ms > 0 ? store.now() + wall_limit_ms : null),
  });
}

export function budgetView(row) {
  if (!row) return null;
  const out = { id: row.id, scope_kind: row.scope_kind, scope_id: row.scope_id, node_id: row.node_id, parent_budget_id: row.parent_budget_id, revision: row.revision };
  for (const dim of DIMENSIONS) {
    const limit = row[dim.limit] ?? 0;
    const reserved = row[dim.reserved] ?? 0;
    const spent = row[dim.spent] ?? 0;
    out[dim.key] = { limit, reserved, spent, available: Math.max(0, limit - reserved - spent) };
  }
  out.wall_limit_ms = row.wall_limit_ms;
  out.wall_deadline = row.wall_deadline;
  return out;
}

export function dimensionAvailable(row, key) {
  const dim = DIMENSION_BY_KEY.get(key);
  if (!dim) fail(`Unknown budget dimension: ${key}`);
  return Math.max(0, (row[dim.limit] ?? 0) - (row[dim.reserved] ?? 0) - (row[dim.spent] ?? 0));
}

function applyDeltas(store, budgetId, deltas) {
  const row = store.getBudget(budgetId);
  if (!row) fail('Budget not found', 404);
  const patch = {};
  let changed = false;
  for (const [column, delta] of Object.entries(deltas)) {
    if (!delta) continue;
    const next = (row[column] ?? 0) + delta;
    if (next < 0) fail(`Budget ${budgetId} would go negative on ${column}`, 409);
    patch[column] = next;
    changed = true;
  }
  return changed ? store.updateBudget(budgetId, patch) : row;
}

/** Reserve on a whole ancestor chain atomically; nothing is written if any scope is short. */
export function reserveChain(store, budgetIds, amounts, { label = 'model request' } = {}) {
  const wanted = {};
  for (const dim of DIMENSIONS) {
    const amount = amounts[dim.key] ?? 0;
    if (amount < 0) fail(`Negative reservation for ${dim.key}`);
    if (amount > 0) wanted[dim.key] = amount;
  }
  const rows = budgetIds.map(id => {
    const row = store.getBudget(id);
    if (!row) fail(`Budget not found: ${id}`, 404);
    return row;
  });
  for (const row of rows) {
    for (const [key, amount] of Object.entries(wanted)) {
      const available = dimensionAvailable(row, key);
      if (available < amount) {
        const error = new BudgetError(
          `${row.scope_kind} ${row.scope_id} budget exhausted for ${key}: requested ${amount}, available ${available} (${label})`,
          409, 'LIMIT_REACHED',
        );
        // Structured facts ride the error: a refusal the ledger can classify
        // without parsing prose.
        error.scope = row.scope_id;
        error.scope_kind = row.scope_kind;
        error.dimension = key;
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
    const deltas = {};
    for (const [key, amount] of Object.entries(wanted)) {
      deltas[DIMENSION_BY_KEY.get(key).reserved] = amount;
    }
    applyDeltas(store, row.id, deltas);
  }
  return rows.map(r => r.id);
}

/** Settle a reservation: move `reserved` into `spent` by the actually consumed amount. */
export function settleChain(store, budgetIds, { reservedAmounts = {}, consumed = {} } = {}) {
  for (const id of budgetIds) {
    const row = store.getBudget(id);
    if (!row) continue;
    const deltas = {};
    for (const dim of DIMENSIONS) {
      const held = reservedAmounts[dim.key] ?? 0;
      if (held) deltas[dim.reserved] = -held;
      const used = consumed[dim.key] ?? 0;
      if (used && dim.spent) deltas[dim.spent] = used;
    }
    applyDeltas(store, id, deltas);
  }
}

/** Release a reservation without consumption (abort before send, failed admission). */
export function releaseChain(store, budgetIds, amounts = {}) {
  for (const id of budgetIds) {
    const deltas = {};
    for (const dim of DIMENSIONS) {
      const amount = amounts[dim.key] ?? 0;
      if (amount) deltas[dim.reserved] = -amount;
    }
    if (Object.keys(deltas).length) applyDeltas(store, id, deltas);
  }
}

export function spendChain(store, budgetIds, consumed = {}) {
  for (const id of budgetIds) {
    const deltas = {};
    for (const dim of DIMENSIONS) {
      const amount = consumed[dim.key] ?? 0;
      if (amount && dim.spent) deltas[dim.spent] = amount;
    }
    if (Object.keys(deltas).length) applyDeltas(store, id, deltas);
  }
}

/** Transfer unused + unreserved budget from one sibling scope to another. */
export function transferBudget(store, fromId, toId, amounts = {}) {
  const from = store.getBudget(fromId);
  const to = store.getBudget(toId);
  if (!from || !to) fail('Budget not found', 404);
  const give = {};
  for (const dim of DIMENSIONS) {
    const amount = amounts[dim.key] ?? 0;
    if (amount === 0) continue;
    integer(amount, 1, 2 ** 40, `rebalance.${dim.key}`);
    const available = dimensionAvailable(from, dim.key);
    if (available < amount) {
      const error = new BudgetError(`cannot move ${amount} ${dim.key} from ${from.scope_id}: only ${available} unused-unreserved remains`, 409, 'LIMIT_REACHED');
      error.scope = from.scope_id;
      error.scope_kind = from.scope_kind;
      error.dimension = dim.key;
      error.requested = amount;
      error.available = available;
      error.label = 'transfer';
      throw error;
    }
    give[dim.key] = amount;
  }
  for (const [key, amount] of Object.entries(give)) {
    const dim = DIMENSION_BY_KEY.get(key);
    applyDeltas(store, fromId, { [dim.limit]: -amount });
    applyDeltas(store, toId, { [dim.limit]: amount });
  }
  return { from: store.getBudget(fromId), to: store.getBudget(toId) };
}

/** Reclaim capacity (agents / max_active) when an identity is released or replaced. */
export function reclaimCapacity(store, budgetId, amounts = {}) {
  const deltas = {};
  if (amounts.agents) deltas.agents_reserved = -amounts.agents;
  if (amounts.max_active_agents) deltas.max_active_reserved = -amounts.max_active_agents;
  if (!Object.keys(deltas).length) return store.getBudget(budgetId);
  const row = store.getBudget(budgetId);
  const safe = {};
  for (const [column, delta] of Object.entries(deltas)) {
    const next = Math.max(0, (row[column] ?? 0) + delta);
    safe[column] = next;
  }
  return store.updateBudget(budgetId, safe);
}

export function lineageBudgets(store, budget) {
  const chain = [];
  let cursor = budget;
  const seen = new Set();
  while (cursor) {
    if (seen.has(cursor.id)) fail('Budget lineage cycle', 409);
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.parent_budget_id ? store.getBudget(cursor.parent_budget_id) : null;
  }
  return chain;
}

export function effectiveDeadline(store, budget) {
  let deadline = null;
  for (const row of lineageBudgets(store, budget)) {
    if (row.wall_deadline === null) continue;
    deadline = deadline === null ? row.wall_deadline : Math.min(deadline, row.wall_deadline);
  }
  return deadline;
}

export function lineageIds(store, budget) {
  return lineageBudgets(store, budget).map(r => r.id);
}

/**
 * Sum every scope in one cluster: the same money counted once. Grants move
 * `limit` downward, so root + descendants always equals the original total.
 */
export function rollupBudgets(store, clusterId) {
  const total = {
    tokens: { limit: 0, reserved: 0, spent: 0 },
    model_requests: { limit: 0, reserved: 0, spent: 0 },
    tool_calls: { limit: 0, reserved: 0, spent: 0 },
    agents: { limit: 0, reserved: 0, spent: 0 },
    max_active_agents: { limit: 0, reserved: 0, spent: 0 },
  };
  for (const row of store.listBudgets(clusterId)) {
    for (const dim of DIMENSIONS) {
      total[dim.key].limit += row[dim.limit] ?? 0;
      total[dim.key].reserved += row[dim.reserved] ?? 0;
      total[dim.key].spent += row[dim.spent] ?? 0;
    }
  }
  return total;
}

export function evaluateTree(store, clusterId) {
  const rows = store.listBudgets(clusterId);
  const byId = new Map(rows.map(r => [r.id, r]));
  return rows.map(row => {
    const view = budgetView(row);
    return {
      ...view,
      depth: lineageBudgets(store, row).length - 1,
      effective_deadline: effectiveDeadline(store, row),
      parent: row.parent_budget_id ? byId.get(row.parent_budget_id)?.scope_id ?? null : null,
    };
  });
}

/** True when the scope has no capacity left in any hard dimension. */
export function exhausted(store, budget, dimensions = ['tokens', 'model_requests', 'tool_calls']) {
  const row = typeof budget === 'string' ? store.getBudget(budget) : budget;
  if (!row) return true;
  const deadline = effectiveDeadline(store, row);
  if (deadline !== null && deadline <= store.now()) return true;
  return dimensions.every(key => dimensionAvailable(row, key) <= 0);
}
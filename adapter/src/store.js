/**
 * ClusterStore: the single writer for the dsh-flow cluster state database.
 *
 * Every mutation path in the cluster goes through one SQLite transaction that
 * commits state + command idempotency record + events together. No transaction
 * body may await model, network or file IO; callers must do all IO outside.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isAsyncFunction, isPromise } from 'node:util/types';

export const SCHEMA_VERSION = 2;

export class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

export const fail = (message, status = 400) => {
  throw new StoreError(message, status);
};

export function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`Invalid ${label}: expected integer ${min}..${max}`);
  return value;
}

export function textField(value, label, max = 1 << 16) {
  if (typeof value !== 'string' || !value.length || value.length > max) fail(`Invalid ${label}`);
  return value;
}

export function objectField(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Invalid ${label}`);
  return value;
}

export function pickDefined(source, keys) {
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

export function normalizeLimit(value, fallback = 100, max = 500) {
  if (value === undefined || value === null) return fallback;
  return integer(value, 1, max, 'limit');
}

export const nowMs = () => Date.now();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clusters(
  id TEXT PRIMARY KEY, objective TEXT NOT NULL, workspace TEXT NOT NULL,
  capabilities TEXT NOT NULL, limits TEXT NOT NULL, budget TEXT NOT NULL,
  spec TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS nodes(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, parent_id TEXT, kind TEXT NOT NULL,
  depth INTEGER NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
  scope TEXT NOT NULL, capabilities TEXT NOT NULL, owner_management_id TEXT,
  delegated_transaction_id TEXT, max_children INTEGER, path TEXT NOT NULL,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(cluster_id,parent_id);
CREATE INDEX IF NOT EXISTS nodes_status ON nodes(cluster_id,status);
CREATE TABLE IF NOT EXISTS agents(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, node_id TEXT NOT NULL, role TEXT NOT NULL,
  session_id TEXT NOT NULL, status TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0, stagnation INTEGER NOT NULL DEFAULT 0,
  capabilities TEXT NOT NULL, cwd TEXT, meta TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agents_node ON agents(cluster_id,node_id,role);
CREATE INDEX IF NOT EXISTS agents_status ON agents(cluster_id,status);
CREATE TABLE IF NOT EXISTS transactions(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, node_id TEXT NOT NULL,
  owner_management_id TEXT NOT NULL, parent_transaction_id TEXT,
  objective TEXT NOT NULL, inputs TEXT NOT NULL, constraints TEXT NOT NULL,
  expected_output TEXT NOT NULL, acceptance_criteria TEXT NOT NULL, needs TEXT NOT NULL,
  priority INTEGER NOT NULL, capabilities TEXT NOT NULL, status TEXT NOT NULL,
  revision INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, result TEXT,
  result_revision INTEGER, validation TEXT, plan_approved_revision INTEGER,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS transactions_owner ON transactions(cluster_id,node_id,status);
CREATE INDEX IF NOT EXISTS transactions_status ON transactions(cluster_id,status);
CREATE INDEX IF NOT EXISTS transactions_parent ON transactions(cluster_id,parent_transaction_id);
CREATE INDEX IF NOT EXISTS transactions_ready ON transactions(cluster_id,status,priority,created,id);
CREATE TABLE IF NOT EXISTS dependencies(
  transaction_id TEXT NOT NULL, depends_on TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY(transaction_id, depends_on));
CREATE INDEX IF NOT EXISTS dependencies_dep ON dependencies(depends_on);
CREATE TABLE IF NOT EXISTS allocations(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, node_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  transaction_id TEXT, capabilities TEXT NOT NULL, write_scope TEXT NOT NULL,
  write_scope_canonical TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS allocations_tx ON allocations(transaction_id);
CREATE INDEX IF NOT EXISTS allocations_agent ON allocations(agent_id);
CREATE TABLE IF NOT EXISTS leases(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, agent_id TEXT NOT NULL, node_id TEXT NOT NULL,
  purpose TEXT NOT NULL, epoch INTEGER NOT NULL, expires INTEGER NOT NULL,
  event_upper_bound INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS leases_agent ON leases(agent_id);
CREATE INDEX IF NOT EXISTS leases_expiry ON leases(expires);
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, cluster_id TEXT NOT NULL, type TEXT NOT NULL,
  data TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS events_cluster ON events(cluster_id,seq);
CREATE TABLE IF NOT EXISTS commands(
  command_id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  hash TEXT NOT NULL, revision INTEGER, result TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS commands_cluster ON commands(cluster_id,at);
CREATE TABLE IF NOT EXISTS inbox(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL,
  payload TEXT NOT NULL, status TEXT NOT NULL, coalesce_key TEXT, dedupe_key TEXT,
  created INTEGER NOT NULL, consumed INTEGER);
CREATE INDEX IF NOT EXISTS inbox_recipient ON inbox(cluster_id,recipient,status);
CREATE UNIQUE INDEX IF NOT EXISTS inbox_dedupe ON inbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS budgets(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
  node_id TEXT, parent_budget_id TEXT,
  tokens_limit INTEGER NOT NULL DEFAULT 0, tokens_reserved INTEGER NOT NULL DEFAULT 0, tokens_spent INTEGER NOT NULL DEFAULT 0,
  requests_limit INTEGER NOT NULL DEFAULT 0, requests_reserved INTEGER NOT NULL DEFAULT 0, requests_spent INTEGER NOT NULL DEFAULT 0,
  tool_calls_limit INTEGER NOT NULL DEFAULT 0, tool_calls_reserved INTEGER NOT NULL DEFAULT 0, tool_calls_spent INTEGER NOT NULL DEFAULT 0,
  wall_limit_ms INTEGER NOT NULL DEFAULT 0, wall_deadline INTEGER,
  agents_limit INTEGER NOT NULL DEFAULT 0, agents_reserved INTEGER NOT NULL DEFAULT 0,
  max_active_limit INTEGER NOT NULL DEFAULT 0, max_active_reserved INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS budgets_scope ON budgets(cluster_id,scope_kind,scope_id);
CREATE INDEX IF NOT EXISTS budgets_node ON budgets(cluster_id,node_id);
CREATE TABLE IF NOT EXISTS usage_receipts(
  request_id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, agent_id TEXT, node_id TEXT,
  transaction_id TEXT, role TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT, model TEXT,
  status TEXT NOT NULL, reservation_tokens INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER,
  reasoning_tokens INTEGER, total_tokens INTEGER, overshoot INTEGER NOT NULL DEFAULT 0,
  turn_seq INTEGER, attempt INTEGER NOT NULL DEFAULT 1, note TEXT,
  created INTEGER NOT NULL, settled INTEGER);
CREATE INDEX IF NOT EXISTS usage_cluster ON usage_receipts(cluster_id,created);
CREATE INDEX IF NOT EXISTS usage_agent ON usage_receipts(agent_id,status);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, from_agent TEXT, from_node TEXT,
  kind TEXT NOT NULL, content TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_cluster ON messages(cluster_id,created);
CREATE TABLE IF NOT EXISTS recipients(
  message_id TEXT NOT NULL, recipient TEXT NOT NULL, delivery_seq INTEGER NOT NULL,
  status TEXT NOT NULL, created INTEGER NOT NULL, acked INTEGER,
  PRIMARY KEY(message_id, recipient));
CREATE INDEX IF NOT EXISTS recipients_pending ON recipients(recipient,status);
CREATE TABLE IF NOT EXISTS counters(
  scope TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS groups(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS groups_name ON groups(cluster_id,name);
CREATE TABLE IF NOT EXISTS group_members(
  group_id TEXT NOT NULL, agent_id TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY(group_id, agent_id));
CREATE TABLE IF NOT EXISTS blackboard(
  cluster_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, revision INTEGER NOT NULL,
  updated_by TEXT, updated INTEGER NOT NULL, PRIMARY KEY(cluster_id, key));
CREATE TABLE IF NOT EXISTS subscriptions(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, agent_id TEXT NOT NULL, pattern TEXT NOT NULL,
  mode TEXT NOT NULL, active INTEGER NOT NULL, cursor TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS subscriptions_agent ON subscriptions(cluster_id,agent_id,active);
CREATE TABLE IF NOT EXISTS checkpoints(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
  flushed_seq INTEGER, events_seq INTEGER, transaction_id TEXT, transaction_revision INTEGER,
  inbox_ack_cursor TEXT, usage_watermark INTEGER, turn_seq INTEGER, data TEXT NOT NULL,
  created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS checkpoints_agent ON checkpoints(cluster_id,agent_id,created);
CREATE TABLE IF NOT EXISTS summaries(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, node_id TEXT, transaction_id TEXT,
  as_of_seq INTEGER NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS summaries_node ON summaries(cluster_id,node_id,created);
CREATE INDEX IF NOT EXISTS summaries_tx ON summaries(cluster_id,transaction_id,created);
CREATE TABLE IF NOT EXISTS tool_call_receipts(
  call_id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT,
  turn_seq INTEGER, tool TEXT NOT NULL, args_hash TEXT NOT NULL, command_id TEXT,
  budget_scope_id TEXT, dispatch_status TEXT NOT NULL, result_body TEXT, error TEXT,
  created INTEGER NOT NULL, settled INTEGER);
CREATE INDEX IF NOT EXISTS tool_call_agent ON tool_call_receipts(cluster_id,agent_id,dispatch_status);
CREATE TABLE IF NOT EXISTS health(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, node_id TEXT, evaluation_window TEXT,
  signals TEXT NOT NULL, scores TEXT NOT NULL, weights TEXT NOT NULL,
  decided INTEGER NOT NULL, decided_by TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS health_cluster ON health(cluster_id,created);
CREATE TABLE IF NOT EXISTS effects(
  call_id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, agent_id TEXT NOT NULL, node_id TEXT,
  lease_epoch INTEGER NOT NULL, session_id TEXT, turn_seq INTEGER, tool TEXT NOT NULL,
  args TEXT NOT NULL, status TEXT NOT NULL, body TEXT, error TEXT, job_id TEXT,
  created INTEGER NOT NULL, settled INTEGER);
CREATE INDEX IF NOT EXISTS effects_agent ON effects(cluster_id,agent_id,status);
CREATE TABLE IF NOT EXISTS sources(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, agent_id TEXT NOT NULL, node_id TEXT,
  transaction_id TEXT, request_url TEXT NOT NULL, final_url TEXT NOT NULL, status_code INTEGER,
  fetched_at INTEGER NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sources_cluster ON sources(cluster_id,fetched_at);
CREATE TABLE IF NOT EXISTS audits(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, transaction_id TEXT NOT NULL, node_id TEXT NOT NULL,
  kind TEXT NOT NULL, target_revision INTEGER NOT NULL, decision TEXT NOT NULL,
  auditor_agent_id TEXT, evidence TEXT NOT NULL, created INTEGER NOT NULL, decided INTEGER);
CREATE INDEX IF NOT EXISTS audits_target ON audits(cluster_id,transaction_id,kind,target_revision);
CREATE TABLE IF NOT EXISTS issues(
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, node_id TEXT NOT NULL, transaction_id TEXT,
  reporter_agent_id TEXT, target_revision INTEGER NOT NULL, severity TEXT NOT NULL,
  evidence TEXT NOT NULL, required_change TEXT NOT NULL, status TEXT NOT NULL,
  corrections INTEGER NOT NULL DEFAULT 0, reviewed_revision INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS issues_status ON issues(cluster_id,status);
`;

const LEGACY_TABLES = ['workflows', 'idem', 'result_messages', 'controller_workflows'];

export class ClusterStore {
  constructor(path, { now = nowMs } = {}) {
    this.path = path;
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec('PRAGMA busy_timeout=5000');
    this.#assertFresh();
    this.db.exec(SCHEMA);
    this.#migrateColumns();
    this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    this.stmts = new Map();
  }

  #assertFresh() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > SCHEMA_VERSION) fail(`cluster database schema ${version} is newer than supported ${SCHEMA_VERSION}; choose another dataDir`, 409);
    const names = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    if (version === 0 && LEGACY_TABLES.some(t => names.includes(t))) {
      fail('legacy workflow database detected; choose a new dataDir (this store never migrates or deletes user data)', 409);
    }
  }

  /**
   * Additive migrations for databases created by an earlier schema: a staged
   * Worker proposal must be bound to the turn that produced it, and adding the
   * binding must not require discarding an existing run.
   */
  #migrateColumns() {
    const additions = [
      ['transactions', 'result_staged_epoch', 'INTEGER'],
      ['transactions', 'result_staged_turn', 'INTEGER'],
      ['transactions', 'result_staged_agent', 'TEXT'],
      ['allocations', 'write_scope_canonical', "TEXT NOT NULL DEFAULT '[]'"],
      ['usage_receipts', 'budget_scope_id', 'TEXT'],
      ['issues', 'reviewed_revision', 'INTEGER'],
      ['clusters', 'declared_limits', 'TEXT'],
      // A checkpoint records the *native* session offset separately from the
      // cluster's own event cursor: they are different logs, and conflating them
      // made a checkpoint unable to say where the session really stood.
      ['checkpoints', 'events_seq', 'INTEGER'],
      ['transactions', 'pre_pause_status', 'TEXT'],
      ['transactions', 'pre_pause_revision', 'INTEGER'],
    ];
    for (const [table, column, type] of additions) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
      if (columns.includes(column)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    // Ownership used to be stored only when a caller supplied it, so a database
    // written by an earlier schema can hold `null` owners and transactions
    // pointing at the branch above them. Both are derived facts now, and a
    // reader that trusts the column must not see two answers for one fact.
    // Normalise in one transaction: idempotent, no business column touched, no
    // schema-version bump, and a failure rolls the whole repair back.
    this.tx(() => {
      this.db.exec(`
        UPDATE nodes SET owner_management_id =
          CASE WHEN kind='management' THEN id ELSE parent_id END
        WHERE owner_management_id IS NOT (CASE WHEN kind='management' THEN id ELSE parent_id END)`);
      this.db.exec(`
        UPDATE transactions SET owner_management_id = node_id
        WHERE owner_management_id IS NOT node_id`);
    });
  }

  close() {
    this.stmts.clear();
    this.db.close();
  }

  #stmt(sql) {
    let stmt = this.stmts.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * SQLite binds `null`, never `undefined`; a model-supplied hole in an
   * argument list must not turn into a driver-level crash.
   */
  #bind(args) {
    return args.map(value => (value === undefined ? null : value));
  }

  run(sql, ...args) {
    return this.#stmt(sql).run(...this.#bind(args));
  }

  all(sql, ...args) {
    return this.#stmt(sql).all(...this.#bind(args));
  }

  get(sql, ...args) {
    return this.#stmt(sql).get(...this.#bind(args));
  }

  #callSync(fn) {
    // Refuse declared async callbacks before they can start IO or schedule a
    // continuation. A promise-returning synchronous callback is also invalid;
    // its synchronous writes are rolled back by the owning transaction.
    if (isAsyncFunction(fn)) fail('Store callbacks must be synchronous');
    const value = fn();
    if (value && typeof value.then === 'function') {
      if (isPromise(value)) value.catch(() => {});
      fail('Store callbacks must be synchronous');
    }
    return value;
  }

  /**
   * Run synchronous work atomically. Nested callers own a savepoint, so a
   * caught inner failure cannot leave half of that operation in the outer
   * commit. A successful inner operation still rolls back with its caller.
   */
  tx(fn) {
    const savepoint = this.#txDepth > 0 ? `cluster_store_tx_${this.#txDepth}` : null;
    this.db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.#txDepth += 1;
    try {
      const value = this.#callSync(fn);
      this.db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
      return value;
    } catch (error) {
      try {
        if (savepoint) {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } else this.db.exec('ROLLBACK');
      } catch {
        /* connection already unwound */
      }
      throw error;
    } finally {
      this.#txDepth -= 1;
    }
  }

  /** Whether a write transaction is currently open on this connection. */
  get inTransaction() {
    return this.#txDepth > 0;
  }

  #txDepth = 0;

  // ---------------------------------------------------------------- clusters

  createCluster(spec, budget) {
    const id = spec.id ?? randomUUID();
    const at = this.now();
    this.run(
      `INSERT INTO clusters(id,objective,workspace,capabilities,limits,budget,spec,declared_limits,status,revision,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, spec.objective, spec.workspace, j(spec.capabilities), j(spec.limits), j(budget), j(spec),
      j(spec.limits), 'RUNNING', 1, at, at,
    );
    return this.getCluster(id);
  }

  getCluster(id) {
    return decodeCluster(this.get('SELECT * FROM clusters WHERE id=?', id));
  }

  listClusters({ status, limit, offset } = {}) {
    const sql = `SELECT * FROM clusters ${status ? 'WHERE status=?' : ''} ORDER BY created, id LIMIT ? OFFSET ?`;
    const args = status ? [status, normalizeLimit(limit), offset ?? 0] : [normalizeLimit(limit), offset ?? 0];
    return this.all(sql, ...args).map(decodeCluster);
  }

  /** The limits the run declared: they are a ceiling, not a starting point. */
  declaredLimits(clusterId) {
    const row = this.get('SELECT limits, declared_limits FROM clusters WHERE id=?', clusterId);
    if (!row) return {};
    try {
      return JSON.parse(row.declared_limits ?? '{}') ?? {};
    } catch {
      try { return JSON.parse(row.limits ?? '{}'); } catch { return {}; }
    }
  }

  updateCluster(id, patch) {
    const row = this.get('SELECT revision FROM clusters WHERE id=?', id);
    if (!row) fail('Cluster not found', 404);
    const sets = [];
    const args = [];
    for (const [key, column] of [['status', 'status'], ['objective', 'objective'], ['workspace', 'workspace'], ['limits', 'limits'], ['capabilities', 'capabilities']]) {
      if (patch[key] !== undefined) {
        sets.push(`${column}=?`);
        args.push(key === 'status' || key === 'objective' || key === 'workspace' ? patch[key] : j(patch[key]));
      }
    }
    if (!sets.length) return this.getCluster(id);
    sets.push('revision=?', 'updated=?');
    args.push(row.revision + 1, this.now(), id);
    this.run(`UPDATE clusters SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getCluster(id);
  }

  // ------------------------------------------------------------------ events

  appendEvent(clusterId, type, data = {}) {
    const at = this.now();
    const info = this.run('INSERT INTO events(cluster_id,type,data,at) VALUES(?,?,?,?)', clusterId, type, j(data), at);
    return { seq: Number(info.lastInsertRowid), cluster_id: clusterId, type, data, at };
  }

  readEvents(clusterId, { since = 0, limit } = {}) {
    const rows = this.all('SELECT * FROM events WHERE cluster_id=? AND seq>? ORDER BY seq LIMIT ?', clusterId, integer(since, 0, Number.MAX_SAFE_INTEGER, 'since'), normalizeLimit(limit));
    return rows.map(r => ({ seq: Number(r.seq), type: r.type, data: p(r.data), at: r.at }));
  }

  /** A reported refusal counts only when the guard recorded it for this transaction's Worker. */
  hasConfirmedWriteRefusal(clusterId, transactionId, evidence) {
    if (!transactionId) return false;
    const seqs = Array.isArray(evidence?.refusal_seqs) ? evidence.refusal_seqs : [evidence?.refusal_seq];
    return seqs.some(seq => Number.isInteger(seq) && Boolean(this.get(
      `SELECT 1 AS present FROM events e JOIN allocations a
         ON a.cluster_id=e.cluster_id AND a.agent_id=json_extract(e.data,'$.agent_id')
        WHERE e.cluster_id=? AND e.seq=? AND e.type='write-refused'
          AND a.transaction_id=? LIMIT 1`, clusterId, seq, transactionId,
    )));
  }

  /** The latest Worker proposal preceding an issue is objective evidence of incomplete work. */
  issueHasIncompleteWorkerResult(clusterId, issue) {
    if (!issue.transaction_id) return false;
    const result = this.get(
      `SELECT json_extract(e.data,'$.result_completed') AS completed
         FROM events e
        WHERE e.cluster_id=? AND e.type='result-submitted'
          AND json_extract(e.data,'$.transaction_id')=?
          AND e.seq < (SELECT MIN(seq) FROM events opened
                        WHERE opened.cluster_id=? AND opened.type='issue-opened'
                          AND json_extract(opened.data,'$.issue_id')=?)
        ORDER BY e.seq DESC LIMIT 1`,
      clusterId, issue.transaction_id, clusterId, issue.id,
    );
    return result?.completed === 0;
  }

  /** A blocked Worker issue has a new executable grant or result, not just new prose. */
  issueHasNewWorkerEvidence(clusterId, issue) {
    if (!issue.transaction_id) return false;
    return Boolean(this.get(
      `SELECT 1 AS present FROM events e
        WHERE e.cluster_id=? AND e.seq > (
          SELECT MIN(seq) FROM events opened
           WHERE opened.cluster_id=? AND opened.type='issue-opened'
             AND json_extract(opened.data,'$.issue_id')=?
        )
          AND json_extract(e.data,'$.transaction_id')=?
          AND (e.type='agent-allocated'
            OR (e.type='result-submitted' AND json_extract(e.data,'$.result_completed') IS NOT 0))
        LIMIT 1`,
      clusterId, clusterId, issue.id, issue.transaction_id,
    ));
  }

  latestEventSeq(clusterId) {
    const row = this.get('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE cluster_id=?', clusterId);
    return Number(row.seq);
  }

  /**
   * Highest sequence of an event that represents cluster state, not scheduler
   * bookkeeping. Exhaustive by construction: it is one indexed MAX over the
   * whole event table, never a bounded page.
   */
  latestProgressSeq(clusterId, skipTypes = []) {
    const placeholders = skipTypes.map(() => '?').join(',');
    const sql = skipTypes.length
      ? `SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE cluster_id=? AND type NOT IN (${placeholders})`
      : 'SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE cluster_id=?';
    const row = this.get(sql, clusterId, ...skipTypes);
    return Number(row.seq);
  }

  /** Every root transaction of a cluster, with no page limit. */
  rootTransactions(clusterId) {
    return this.all('SELECT * FROM transactions WHERE cluster_id=? AND parent_transaction_id IS NULL', clusterId).map(decodeTransaction);
  }

  /** Number of transactions in a cluster, optionally restricted. */
  countTransactions(clusterId, { status, node_id, parent_transaction_id } = {}) {
    const where = ['cluster_id=?'];
    const args = [clusterId];
    if (status !== undefined) {
      where.push(Array.isArray(status) ? `status IN (${status.map(() => '?').join(',')})` : 'status=?');
      Array.isArray(status) ? args.push(...status) : args.push(status);
    }
    if (node_id) {
      where.push('node_id=?');
      args.push(node_id);
    }
    if (parent_transaction_id !== undefined) {
      where.push(parent_transaction_id === null ? 'parent_transaction_id IS NULL' : 'parent_transaction_id=?');
      if (parent_transaction_id !== null) args.push(parent_transaction_id);
    }
    return Number(this.get(`SELECT COUNT(*) AS c FROM transactions WHERE ${where.join(' AND ')}`, ...args).c);
  }

  // ---------------------------------------------------------------- commands

  findCommand(commandId) {
    const row = this.get('SELECT * FROM commands WHERE command_id=?', commandId);
    return row ? { command_id: row.command_id, cluster_id: row.cluster_id, actor: p(row.actor), action: row.action, hash: row.hash, revision: row.revision, result: p(row.result), at: row.at } : null;
  }

  /**
   * Idempotent command execution. `apply` runs inside the same transaction that
   * records the command and its events. Synchronous only.
   */
  runCommand({ cluster_id, command_id, actor, action, expected_revision, params }, apply) {
    textField(command_id, 'command_id', 256);
    return this.tx(() => {
      const hash = canonical({ action, params: params ?? null });
      const existing = this.findCommand(command_id);
      if (existing) {
        // A command identity belongs to one cluster and authenticated actor.
        // The lease epoch is transient, so a retried turn can recover its own
        // receipt without letting another actor replay it across domains.
        const identity = value => canonical(pickDefined(value ?? {}, ['role', 'agent_id', 'node_id']));
        if (existing.cluster_id !== cluster_id || identity(existing.actor) !== identity(actor)) {
          fail('command_id belongs to another cluster or actor', 409);
        }
        if (existing.hash !== hash) fail('command_id reused with different payload', 409);
        return { result: existing.result, revision: existing.revision, deduped: true };
      }
      const result = this.#callSync(apply);
      this.run(
        'INSERT INTO commands(command_id,cluster_id,actor,action,hash,revision,result,at) VALUES(?,?,?,?,?,?,?,?)',
        command_id, cluster_id, j(actor), action, hash, result?.revision ?? null, j(result), this.now(),
      );
      return { result, revision: result?.revision ?? null, deduped: false };
    });
  }

  // ------------------------------------------------------------------- nodes

  /**
   * A node's management owner is derived from its place in the tree, never
   * supplied: a management node owns itself, a Worker belongs to the
   * management node directly above it, and the standalone Worker of a
   * single-mode cluster has no management parent at all. This is the same
   * relation the effect queries already report, so storing anything else made
   * two readers of one fact disagree. A caller that passes a conflicting owner
   * is refused rather than silently overridden.
   */
  static nodeOwner(kind, id, parentId) {
    return kind === 'management' ? id : parentId ?? null;
  }

  insertNode(node) {
    const at = this.now();
    const parentId = node.parent_id ?? null;
    const owner = ClusterStore.nodeOwner(node.kind, node.id, parentId);
    if (node.owner_management_id !== undefined && node.owner_management_id !== owner) {
      fail(`node ${node.id} declares owner ${String(node.owner_management_id)} but a ${node.kind} node is owned by ${String(owner)}`, 409);
    }
    this.run(
      `INSERT INTO nodes(id,cluster_id,parent_id,kind,depth,status,revision,scope,capabilities,owner_management_id,delegated_transaction_id,max_children,path,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      node.id, node.cluster_id, parentId, node.kind, node.depth, node.status, 1,
      j(node.scope ?? {}), j(node.capabilities ?? []), owner,
      node.delegated_transaction_id ?? null, node.max_children ?? null, node.path, at, at,
    );
    return this.getNode(node.id);
  }

  getNode(id) {
    return decodeNode(this.get('SELECT * FROM nodes WHERE id=?', id));
  }

  listNodes(clusterId, { status, parent_id, limit } = {}) {
    const where = ['cluster_id=?'];
    const args = [clusterId];
    if (status) {
      where.push('status=?');
      args.push(status);
    }
    if (parent_id !== undefined) {
      where.push(parent_id === null ? 'parent_id IS NULL' : 'parent_id=?');
      if (parent_id !== null) args.push(parent_id);
    }
    args.push(normalizeLimit(limit));
    return this.all(`SELECT * FROM nodes WHERE ${where.join(' AND ')} ORDER BY path,id LIMIT ?`, ...args).map(decodeNode);
  }

  /** All active management roles, without the public list's page ceiling. */
  activeManagementNodes(clusterId) {
    return this.all(
      "SELECT * FROM nodes WHERE cluster_id=? AND status='ACTIVE' AND kind='management' ORDER BY path,id",
      clusterId,
    ).map(decodeNode);
  }

  childrenOf(nodeId) {
    return this.all('SELECT * FROM nodes WHERE parent_id=? ORDER BY created,id', nodeId).map(decodeNode);
  }

  updateNode(id, patch) {
    const row = this.get('SELECT revision, kind, parent_id FROM nodes WHERE id=?', id);
    if (!row) fail('Node not found', 404);
    // Moving a node is the one edit that can change who owns it, and the owner
    // follows the new parent deterministically. Deriving it here is what keeps
    // a reparented Worker pointing at the management node it really runs under
    // instead of the source branch it was created in.
    if (patch.parent_id !== undefined) {
      const owner = ClusterStore.nodeOwner(row.kind, id, patch.parent_id ?? null);
      if (patch.owner_management_id !== undefined && patch.owner_management_id !== owner) {
        fail(`node ${id} declares owner ${String(patch.owner_management_id)} but a ${row.kind} node moved under ${String(patch.parent_id)} is owned by ${String(owner)}`, 409);
      }
      patch = { ...patch, owner_management_id: owner };
    }
    const columns = {
      status: 'status', scope: 'scope', capabilities: 'capabilities', max_children: 'max_children',
      delegated_transaction_id: 'delegated_transaction_id', parent_id: 'parent_id', depth: 'depth',
      path: 'path',
      // Ownership is a real column with a real reader: without it here, a
      // reparent's ownership update was silently discarded.
      owner_management_id: 'owner_management_id',
    };
    const sets = [];
    const args = [];
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      sets.push(`${column}=?`);
      args.push(key === 'scope' || key === 'capabilities' ? j(patch[key]) : patch[key]);
    }
    if (!sets.length) return this.getNode(id);
    sets.push('revision=?', 'updated=?');
    args.push(row.revision + 1, this.now(), id);
    this.run(`UPDATE nodes SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getNode(id);
  }

  // ------------------------------------------------------------------ agents

  insertAgent(agent) {
    const at = this.now();
    this.run(
      `INSERT INTO agents(id,cluster_id,node_id,role,session_id,status,epoch,turns,stagnation,capabilities,cwd,meta,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      agent.id, agent.cluster_id, agent.node_id, agent.role, agent.session_id, agent.status,
      agent.epoch ?? 0, 0, 0, j(agent.capabilities ?? []), agent.cwd ?? null, j(agent.meta ?? {}), at, at,
    );
    return this.getAgent(agent.id);
  }

  getAgent(id) {
    return decodeAgent(this.get('SELECT * FROM agents WHERE id=?', id));
  }

  getAgentBySession(sessionId) {
    return decodeAgent(this.get('SELECT * FROM agents WHERE session_id=?', sessionId));
  }

  listAgents(clusterId, { status, node_id, role, live, limit, offset } = {}) {
    const where = ['cluster_id=?'];
    const args = [clusterId];
    if (status) {
      where.push(Array.isArray(status) ? `status IN (${status.map(() => '?').join(',')})` : 'status=?');
      Array.isArray(status) ? args.push(...status) : args.push(status);
    }
    if (live) where.push("status<>'TERMINATED'");
    if (node_id) {
      where.push('node_id=?');
      args.push(node_id);
    }
    if (role) {
      where.push('role=?');
      args.push(role);
    }
    args.push(normalizeLimit(limit, 200, 500), offset ?? 0);
    return this.all(`SELECT * FROM agents WHERE ${where.join(' AND ')} ORDER BY created,id LIMIT ? OFFSET ?`, ...args).map(decodeAgent);
  }

  countAgents(clusterId, { live = false, status } = {}) {
    const where = ['cluster_id=?'];
    const args = [clusterId];
    if (live) where.push("status<>'TERMINATED'");
    if (status) {
      where.push(Array.isArray(status) ? `status IN (${status.map(() => '?').join(',')})` : 'status=?');
      Array.isArray(status) ? args.push(...status) : args.push(status);
    }
    return Number(this.get(`SELECT COUNT(*) AS c FROM agents WHERE ${where.join(' AND ')}`, ...args).c);
  }

  updateAgent(id, patch) {
    const columns = { status: 'status', epoch: 'epoch', turns: 'turns', stagnation: 'stagnation', capabilities: 'capabilities', session_id: 'session_id', cwd: 'cwd', meta: 'meta', node_id: 'node_id' };
    const sets = [];
    const args = [];
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      sets.push(`${column}=?`);
      args.push(['capabilities', 'meta'].includes(key) ? j(patch[key]) : patch[key]);
    }
    if (!sets.length) return this.getAgent(id);
    sets.push('updated=?');
    args.push(this.now(), id);
    this.run(`UPDATE agents SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getAgent(id);
  }

  // ------------------------------------------------------------ transactions

  insertTransaction(tx) {
    const at = this.now();
    this.run(
      `INSERT INTO transactions(id,cluster_id,node_id,owner_management_id,parent_transaction_id,objective,inputs,constraints,expected_output,acceptance_criteria,needs,priority,capabilities,status,revision,attempts,result,result_revision,validation,plan_approved_revision,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      tx.id, tx.cluster_id, tx.node_id, tx.owner_management_id, tx.parent_transaction_id ?? null,
      tx.objective, j(tx.inputs ?? {}), j(tx.constraints ?? []), tx.expected_output ?? '',
      j(tx.acceptance_criteria ?? []), j(tx.needs ?? {}), tx.priority ?? 0, j(tx.capabilities ?? []),
      tx.status ?? 'DRAFT', 1, 0, tx.result === undefined ? null : j(tx.result), tx.result_revision ?? null,
      tx.validation === undefined ? null : j(tx.validation), null, at, at,
    );
    return this.getTransaction(tx.id);
  }

  getTransaction(id) {
    return decodeTransaction(this.get('SELECT * FROM transactions WHERE id=?', id));
  }

  listTransactions({ cluster_id, node_id, status, parent_transaction_id, limit, offset } = {}) {
    const where = ['cluster_id=?'];
    const args = [cluster_id];
    if (node_id) {
      where.push('node_id=?');
      args.push(node_id);
    }
    if (status) {
      where.push(Array.isArray(status) ? `status IN (${status.map(() => '?').join(',')})` : 'status=?');
      Array.isArray(status) ? args.push(...status) : args.push(status);
    }
    if (parent_transaction_id !== undefined) {
      where.push(parent_transaction_id === null ? 'parent_transaction_id IS NULL' : 'parent_transaction_id=?');
      if (parent_transaction_id !== null) args.push(parent_transaction_id);
    }
    args.push(normalizeLimit(limit), offset ?? 0);
    return this.all(`SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY created,id LIMIT ? OFFSET ?`, ...args).map(decodeTransaction);
  }

  /** Filter by a role's subtree before applying a public page boundary. */
  transactionsForDomain(clusterId, { scope_node_id, node_id, parent_id, status, limit, offset = 0 } = {}) {
    const scope = scope_node_id
      ? `WITH RECURSIVE sub(id) AS (
           SELECT id FROM nodes WHERE cluster_id=? AND id=?
           UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id=sub.id WHERE n.cluster_id=?
         ) `
      : '';
    const where = ['t.cluster_id=?'];
    const args = scope_node_id ? [clusterId, scope_node_id, clusterId, clusterId] : [clusterId];
    if (scope_node_id) where.push('t.node_id IN (SELECT id FROM sub)');
    if (node_id) {
      where.push('t.node_id=?');
      args.push(node_id);
    }
    if (parent_id !== undefined) {
      where.push('t.parent_transaction_id IS ?');
      args.push(parent_id);
    }
    if (status) {
      where.push(Array.isArray(status) ? `t.status IN (${status.map(() => '?').join(',')})` : 't.status=?');
      Array.isArray(status) ? args.push(...status) : args.push(status);
    }
    const filter = `FROM transactions t WHERE ${where.join(' AND ')}`;
    const total = Number(this.get(`${scope}SELECT COUNT(*) AS c ${filter}`, ...args).c);
    const items = this.all(`${scope}SELECT t.* ${filter} ORDER BY t.created,t.id LIMIT ? OFFSET ?`,
      ...args, normalizeLimit(limit), offset).map(decodeTransaction);
    return { items, total };
  }

  updateTransaction(id, patch) {
    const row = this.get('SELECT revision FROM transactions WHERE id=?', id);
    if (!row) fail('Transaction not found', 404);
    const columns = {
      objective: 'objective', inputs: 'inputs', constraints: 'constraints', expected_output: 'expected_output',
      acceptance_criteria: 'acceptance_criteria', needs: 'needs', priority: 'priority', capabilities: 'capabilities',
      status: 'status', attempts: 'attempts', result: 'result', result_revision: 'result_revision',
      validation: 'validation', plan_approved_revision: 'plan_approved_revision', node_id: 'node_id',
      pre_pause_status: 'pre_pause_status', pre_pause_revision: 'pre_pause_revision',
      owner_management_id: 'owner_management_id', parent_transaction_id: 'parent_transaction_id',
      result_staged_epoch: 'result_staged_epoch', result_staged_turn: 'result_staged_turn',
      result_staged_agent: 'result_staged_agent',
    };
    const jsonColumns = new Set(['inputs', 'constraints', 'acceptance_criteria', 'needs', 'capabilities', 'result', 'validation']);
    const sets = [];
    const args = [];
    const bump = patch.__bump_revision !== false;
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      sets.push(`${column}=?`);
      const value = patch[key];
      args.push(jsonColumns.has(key) && value !== null ? j(value) : value);
    }
    if (!sets.length) return this.getTransaction(id);
    if (bump) sets.push('revision=?'), args.push(row.revision + 1);
    sets.push('updated=?');
    args.push(this.now(), id);
    this.run(`UPDATE transactions SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getTransaction(id);
  }

  // ------------------------------------------------------------ dependencies

  addDependency(transactionId, dependsOn) {
    this.run('INSERT OR IGNORE INTO dependencies(transaction_id,depends_on,created) VALUES(?,?,?)', transactionId, dependsOn, this.now());
  }

  removeDependency(transactionId, dependsOn) {
    this.run('DELETE FROM dependencies WHERE transaction_id=? AND depends_on=?', transactionId, dependsOn);
  }

  dependenciesOf(transactionId) {
    return this.all('SELECT depends_on FROM dependencies WHERE transaction_id=? ORDER BY depends_on', transactionId).map(r => r.depends_on);
  }

  dependentsOf(transactionId) {
    return this.all('SELECT transaction_id FROM dependencies WHERE depends_on=? ORDER BY transaction_id', transactionId).map(r => r.transaction_id);
  }

  allDependencies(clusterId) {
    return this.all('SELECT d.transaction_id,d.depends_on FROM dependencies d JOIN transactions t ON t.id=d.transaction_id WHERE t.cluster_id=?', clusterId);
  }

  // ------------------------------------------------------------- allocations

  insertAllocation(allocation) {
    const at = this.now();
    this.run(
      `INSERT INTO allocations(id,cluster_id,node_id,agent_id,transaction_id,capabilities,write_scope,write_scope_canonical,status,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      allocation.id, allocation.cluster_id, allocation.node_id, allocation.agent_id,
      allocation.transaction_id ?? null, j(allocation.capabilities ?? []), j(allocation.write_scope ?? []),
      j(allocation.write_scope_canonical ?? []),
      allocation.status ?? 'ACTIVE', at, at,
    );
    return this.getAllocation(allocation.id);
  }

  getAllocation(id) {
    return decodeAllocation(this.get('SELECT * FROM allocations WHERE id=?', id));
  }

  listAllocations({ cluster_id, agent_id, transaction_id, status, limit } = {}) {
    const where = ['cluster_id=?'];
    const args = [cluster_id];
    for (const [column, value] of [['agent_id', agent_id], ['transaction_id', transaction_id], ['status', status]]) {
      if (value !== undefined && value !== null) {
        where.push(`${column}=?`);
        args.push(value);
      }
    }
    args.push(normalizeLimit(limit, 200, 500));
    return this.all(`SELECT * FROM allocations WHERE ${where.join(' AND ')} ORDER BY created,id LIMIT ?`, ...args).map(decodeAllocation);
  }

  activeAllocationForTransaction(transactionId) {
    return decodeAllocation(this.get("SELECT * FROM allocations WHERE transaction_id=? AND status='ACTIVE' ORDER BY created DESC LIMIT 1", transactionId));
  }

  activeAllocationForAgent(agentId) {
    return decodeAllocation(this.get("SELECT * FROM allocations WHERE agent_id=? AND status='ACTIVE' ORDER BY created DESC LIMIT 1", agentId));
  }

  /** An allocation binds to the transaction plan that existed at its grant event. */
  allocationOutdated(clusterId, allocation) {
    if (!allocation?.transaction_id) return false;
    const events = this.get(
      `SELECT
         (SELECT MAX(seq) FROM events
           WHERE cluster_id=? AND type='transaction-adjusted'
             AND json_extract(data,'$.transaction_id')=?) AS revised,
         (SELECT MAX(seq) FROM events
           WHERE cluster_id=? AND type='agent-allocated'
             AND json_extract(data,'$.transaction_id')=?
             AND json_extract(data,'$.agent_id')=?) AS granted`,
      clusterId, allocation.transaction_id, clusterId, allocation.transaction_id, allocation.agent_id,
    );
    return Number(events?.revised ?? 0) > Number(events?.granted ?? 0);
  }

  updateAllocation(id, patch) {
    const sets = [];
    const args = [];
    for (const [key, column] of [
      ['status', 'status'], ['write_scope', 'write_scope'],
      ['write_scope_canonical', 'write_scope_canonical'], ['capabilities', 'capabilities'],
      ['transaction_id', 'transaction_id'], ['agent_id', 'agent_id'],
    ]) {
      if (patch[key] === undefined) continue;
      sets.push(`${column}=?`);
      args.push(['write_scope', 'write_scope_canonical', 'capabilities'].includes(key) ? j(patch[key]) : patch[key]);
    }
    if (!sets.length) return this.getAllocation(id);
    sets.push('updated=?');
    args.push(this.now(), id);
    this.run(`UPDATE allocations SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getAllocation(id);
  }

  writeScopes(clusterId) {
    return this.all("SELECT id,agent_id,node_id,write_scope FROM allocations WHERE cluster_id=? AND status='ACTIVE'", clusterId)
      .map(r => ({ id: r.id, agent_id: r.agent_id, node_id: r.node_id, write_scope: p(r.write_scope) }));
  }

  // ------------------------------------------------------------------ leases

  createLease(lease) {
    this.run(
      'INSERT INTO leases(id,cluster_id,agent_id,node_id,purpose,epoch,expires,event_upper_bound,created) VALUES(?,?,?,?,?,?,?,?,?)',
      lease.id, lease.cluster_id, lease.agent_id, lease.node_id, lease.purpose ?? 'turn',
      lease.epoch, lease.expires, lease.event_upper_bound ?? 0, this.now(),
    );
    return this.get('SELECT * FROM leases WHERE id=?', lease.id);
  }

  getLease(id) {
    return this.get('SELECT * FROM leases WHERE id=?', id) ?? null;
  }

  leaseForAgent(agentId) {
    return this.get('SELECT * FROM leases WHERE agent_id=?', agentId) ?? null;
  }

  listLeases(clusterId, { expiredBefore } = {}) {
    if (expiredBefore !== undefined) return this.all('SELECT * FROM leases WHERE cluster_id=? AND expires<=?', clusterId, expiredBefore);
    return this.all('SELECT * FROM leases WHERE cluster_id=?', clusterId);
  }

  expiredLeases(at) {
    return this.all('SELECT * FROM leases WHERE expires<=?', at);
  }

  touchLease(id, expires) {
    this.run('UPDATE leases SET expires=? WHERE id=?', expires, id);
  }

  deleteLease(id) {
    this.run('DELETE FROM leases WHERE id=?', id);
  }

  // ------------------------------------------ exhaustive reads and aggregates
  //
  // Every method below answers an *exhaustive* question in SQL. Internal
  // traversal (scheduling, recovery, summaries, reports) must never take a
  // bounded page and treat it as the whole set: a page of 200 is a page of 200
  // whether or not a 201st row exists, and silently acting on the page is how a
  // large cluster loses work.

  /** Non-terminal clusters, one keyset page at a time. */
  listOpenClusters({ afterId = '', limit = 200 } = {}) {
    return this.all(
      `SELECT * FROM clusters WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED') AND id > ?
       ORDER BY id LIMIT ?`, afterId, integer(limit, 1, 1000, 'limit'),
    ).map(decodeCluster);
  }

  countNodes(clusterId, { status, kind } = {}) {
    const where = ['cluster_id=?'];
    const args = [clusterId];
    if (status) { where.push('status=?'); args.push(status); }
    if (kind) { where.push('kind=?'); args.push(kind); }
    return Number(this.get(`SELECT COUNT(*) AS c FROM nodes WHERE ${where.join(' AND ')}`, ...args).c);
  }

  maxNodeDepth(clusterId) {
    return Number(this.get('SELECT COALESCE(MAX(depth),0) AS d FROM nodes WHERE cluster_id=?', clusterId).d);
  }

  /** Node ids of a subtree (the whole cluster when `nodeId` is null). */
  nodesInSubtree(clusterId, nodeId = null) {
    if (!nodeId) return this.all('SELECT * FROM nodes WHERE cluster_id=? ORDER BY path,id', clusterId).map(decodeNode);
    return this.all(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)
       SELECT n.* FROM nodes n JOIN sub ON sub.id = n.id ORDER BY n.path, n.id`, nodeId,
    ).map(decodeNode);
  }

  /** Direct children counts per node, without loading any node row. */
  subtreeSizes(clusterId) {
    return this.all(
      `WITH RECURSIVE walk(ancestor, id) AS (
         SELECT parent_id, id FROM nodes WHERE cluster_id=? AND parent_id IS NOT NULL
         UNION ALL
         SELECT w.ancestor, n.id FROM nodes n JOIN walk w ON n.parent_id = w.id
       )
       SELECT ancestor AS node_id, COUNT(*) AS size FROM walk GROUP BY ancestor`, clusterId);
  }

  /** The depth-1 ancestor of every node: the management domain it belongs to. */
  domainRoots(clusterId) {
    return this.all(
      `WITH RECURSIVE root_of(id, root) AS (
         SELECT id, id FROM nodes WHERE cluster_id=? AND (parent_id IS NULL OR depth = 0)
         UNION ALL
         SELECT n.id, r.root FROM nodes n JOIN root_of r ON n.parent_id = r.id WHERE n.cluster_id = ?
       )
       SELECT id, root FROM root_of`, clusterId, clusterId);
  }

  countTransactionsByStatus(clusterId, { nodeId = null } = {}) {
    const where = ['cluster_id=?'];
    const args = [clusterId];
    if (nodeId) { where.push('node_id=?'); args.push(nodeId); }
    return this.all(`SELECT status, COUNT(*) AS c FROM transactions WHERE ${where.join(' AND ')} GROUP BY status`, ...args);
  }

  childrenOfTransaction(clusterId, parentTransactionId) {
    return this.all(
      'SELECT * FROM transactions WHERE cluster_id=? AND parent_transaction_id=? ORDER BY created, id',
      clusterId, parentTransactionId,
    ).map(decodeTransaction);
  }

  /** Status counts inside one subtree (the whole cluster when `nodeId` is null). */
  countTransactionsInSubtree(clusterId, nodeId = null) {
    if (!nodeId) return this.countTransactionsByStatus(clusterId);
    return this.all(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)
       SELECT t.status, COUNT(*) AS c FROM transactions t JOIN sub ON sub.id = t.node_id
        WHERE t.cluster_id=? GROUP BY t.status`, nodeId, clusterId);
  }

  transactionsInSubtree(clusterId, nodeId = null, { status = null } = {}) {
    const where = ['t.cluster_id=?'];
    const args = [clusterId];
    if (status) { where.push('t.status=?'); args.push(status); }
    const scope = nodeId
      ? 'AND t.node_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id) SELECT id FROM sub)'
      : '';
    if (nodeId) args.push(nodeId);
    return this.all(`SELECT t.* FROM transactions t WHERE ${where.join(' AND ')} ${scope}`, ...args).map(decodeTransaction);
  }

  allocationsForNode(nodeId, { status = 'ACTIVE' } = {}) {
    return this.all('SELECT * FROM allocations WHERE node_id=? AND status=? ORDER BY created,id', nodeId, status).map(decodeAllocation);
  }

  allocationsInSubtree(clusterId, nodeId = null, { status = 'ACTIVE' } = {}) {
    if (!nodeId) return this.all('SELECT * FROM allocations WHERE cluster_id=? AND status=? ORDER BY created,id', clusterId, status).map(decodeAllocation);
    return this.all(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)
       SELECT * FROM allocations WHERE cluster_id=? AND status=? AND node_id IN (SELECT id FROM sub)
       ORDER BY created, id`, nodeId, clusterId, status,
    ).map(decodeAllocation);
  }

  agentsInSubtree(clusterId, nodeId = null, { status = null, role = null } = {}) {
    const where = ['a.cluster_id=?'];
    const args = [clusterId];
    if (status) { where.push('a.status=?'); args.push(status); }
    if (role) { where.push('a.role=?'); args.push(role); }
    const scope = nodeId
      ? 'AND a.node_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id) SELECT id FROM sub)'
      : '';
    if (nodeId) args.push(nodeId);
    return this.all(`SELECT a.* FROM agents a WHERE ${where.join(' AND ')} ${scope} ORDER BY a.created, a.id`, ...args).map(decodeAgent);
  }

  countAgentsByRole(clusterId) {
    return this.all(
      `SELECT role, COUNT(*) AS c, SUM(CASE WHEN status<>'TERMINATED' THEN 1 ELSE 0 END) AS live,
              SUM(CASE WHEN turns>0 THEN 1 ELSE 0 END) AS activated, SUM(turns) AS turns
       FROM agents WHERE cluster_id=? GROUP BY role`, clusterId);
  }

  /** Every effect of a cluster in one state, with no page limit. */
  effectsAll(clusterId, { status = null } = {}) {
    const where = ['cluster_id=?'];
    const args = [clusterId];
    if (status) { where.push('status=?'); args.push(status); }
    return this.all(`SELECT * FROM effects WHERE ${where.join(' AND ')} ORDER BY created`, ...args);
  }

  /** Every usage receipt of one identity in one state, with no page limit. */
  usageReceiptsAll(clusterId, { agent_id = null, status = null } = {}) {
    const where = ['cluster_id=?'];
    const args = [clusterId];
    if (agent_id) { where.push('agent_id=?'); args.push(agent_id); }
    if (status) { where.push('status=?'); args.push(status); }
    return this.all(`SELECT * FROM usage_receipts WHERE ${where.join(' AND ')} ORDER BY created, request_id`, ...args);
  }

  /** Number of rows changed by the last `run`, for a caller that reports counts. */
  changed() {
    return Number(this.db.prepare('SELECT changes() AS c').get().c ?? 0);
  }

  /** Identities whose turn died with a provider request still reserved. */
  agentsWithReservedReceipts(clusterId) {
    return this.all(
      `SELECT DISTINCT a.* FROM agents a JOIN usage_receipts u ON u.agent_id = a.id AND u.status='RESERVED'
       WHERE a.cluster_id=? AND a.status<>'TERMINATED'`, clusterId).map(decodeAgent);
  }

  /** Every effect call id in one state, with no page limit. */
  effectIds(clusterId, status) {
    return this.all('SELECT call_id FROM effects WHERE cluster_id=? AND status=? ORDER BY created', clusterId, status).map(row => row.call_id);
  }

  /**
   * READY transactions that already hold an ACTIVE allocation, in the order the
   * scheduler wants them. Keyset-paged on `(priority DESC, created, id)` so a
   * pass that starts turns while paging cannot skip the row a mutation pushed
   * across a page boundary.
   */
  readyForWorker(clusterId, { after = null, limit = 100 } = {}) {
    const where = [
      't.cluster_id=?',
      "t.status='READY'",
      'EXISTS (SELECT 1 FROM allocations a WHERE a.transaction_id = t.id AND a.status=\'ACTIVE\')',
      // A delegated parent is always an aggregation task, not a Worker task;
      // accepting its last child must not revive a preexisting Worker grant.
      "NOT EXISTS (SELECT 1 FROM transactions c WHERE c.cluster_id=t.cluster_id AND c.parent_transaction_id=t.id)",
      // `set_dependency` orders work, and the declared contract is that a
      // dependent pauses until its dependency is settled ("its dependents pause
      // until you answer the issue"). Holding the dependency only in the digest
      // made the edge advisory: a dependent ran, and could only ever read an
      // artifact its dependency had not produced yet. A dependency that is not
      // ACCEPTED — including one that failed and will never be accepted — keeps
      // the dependent out of the Worker frontier.
      `NOT EXISTS (
         SELECT 1 FROM dependencies d
           LEFT JOIN transactions p ON p.id = d.depends_on AND p.cluster_id = t.cluster_id
          WHERE d.transaction_id = t.id
            AND (p.id IS NULL OR p.status <> 'ACCEPTED'))`,
    ];
    const args = [clusterId];
    if (after) {
      where.push('(t.priority < ? OR (t.priority = ? AND (t.created > ? OR (t.created = ? AND t.id > ?))))');
      args.push(after.priority, after.priority, after.created, after.created, after.id);
    }
    args.push(integer(limit, 1, 500, 'limit'));
    return this.all(
      `SELECT t.* FROM transactions t WHERE ${where.join(' AND ')}
       ORDER BY t.priority DESC, t.created ASC, t.id ASC LIMIT ?`, ...args,
    ).map(decodeTransaction);
  }

  /**
   * Parents in one management node whose children have all been accepted
   * and whose own result has not yet been submitted. A SUBMITTED/VALIDATING
   * parent is waiting for its Auditor, not eligible for another aggregation.
   */
  aggregatableParents(clusterId, nodeId, { limit = 64 } = {}) {
    return this.all(
      `SELECT p.id AS parent_id, COUNT(*) AS children
         FROM transactions c JOIN transactions p ON p.id = c.parent_transaction_id
        WHERE c.cluster_id=? AND p.node_id=? AND p.status='READY'
        GROUP BY p.id
       HAVING SUM(CASE WHEN c.status='ACCEPTED' THEN 0 ELSE 1 END) = 0
        ORDER BY p.created, p.id LIMIT ?`, clusterId, nodeId, integer(limit, 1, 500, 'limit'),
    );
  }

  /**
   * Transactions that have delegated children still unfinished: their own work must
   * not be executed or validated while the delegation they handed out is open.
   */
  parentsAwaitingChildren(clusterId, nodeId = null) {
    const where = ['c.cluster_id=?', "c.status NOT IN ('ACCEPTED','CANCELLED','SUPERSEDED','FAILED')",
      "p.status NOT IN ('ACCEPTED','CANCELLED','SUPERSEDED','FAILED')"];
    const args = [clusterId];
    if (nodeId) {
      where.push('p.node_id=?');
      args.push(nodeId);
    }
    return this.all(
      `SELECT DISTINCT p.id AS parent_id FROM transactions c JOIN transactions p ON p.id = c.parent_transaction_id
        WHERE ${where.join(' AND ')}`, ...args,
    ).map(row => row.parent_id);
  }

  /** Deliveries in one cluster, with the sender node and the recipient's node. */
  deliveryTraffic(clusterId) {
    const total = Number(this.get(
      `SELECT COUNT(*) AS c FROM recipients r JOIN messages m ON m.id=r.message_id WHERE m.cluster_id=?`, clusterId).c);
    const cross = Number(this.get(
      `WITH RECURSIVE root_of(id, root) AS (
         SELECT id, id FROM nodes WHERE cluster_id=? AND (parent_id IS NULL OR depth = 0)
         UNION ALL
         SELECT n.id, r.root FROM nodes n JOIN root_of r ON n.parent_id = r.id WHERE n.cluster_id = ?
       )
       SELECT COUNT(*) AS c
         FROM recipients rc
         JOIN messages m ON m.id = rc.message_id
         JOIN agents a ON a.id = rc.recipient
         LEFT JOIN root_of s ON s.id = m.from_node
         LEFT JOIN root_of t ON t.id = a.node_id
        WHERE m.cluster_id=? AND s.root IS NOT NULL AND t.root IS NOT NULL AND s.root <> t.root`,
      clusterId, clusterId, clusterId).c);
    return { deliveries: total, cross_subtree: cross };
  }

  /** Latest measured context per orchestrator identity, read from its turns. */
  latestOrchestratorContext(clusterId) {
    return this.all(
      `SELECT e.data AS data, json_extract(e.data,'$.agent_id') AS agent_id,
              json_extract(e.data,'$.context.totalTokens') AS tokens
         FROM (SELECT json_extract(data,'$.agent_id') AS agent_id, MAX(seq) AS seq
                 FROM events WHERE cluster_id=? AND type='turn-end'
                  AND json_extract(data,'$.role')='orchestrator'
                  AND json_extract(data,'$.context.totalTokens') IS NOT NULL
                GROUP BY 1) latest
         JOIN events e ON e.seq = latest.seq`, clusterId,
    );
  }

  /** Inbox rows one role received since a timestamp. */
  countInboxSince(clusterId, { role, since }) {
    return Number(this.get(
      `SELECT COUNT(*) AS c FROM inbox i
        WHERE i.cluster_id=? AND i.created>=?
          AND i.recipient IN (SELECT id FROM agents WHERE cluster_id=? AND role=?)`,
      clusterId, since, clusterId, role).c);
  }

  // ------------------------------------------------------------------ inbox

  insertInbox(item) {
    const at = this.now();
    const id = item.id ?? randomUUID();
    const info = this.run(
      'INSERT OR IGNORE INTO inbox(id,cluster_id,recipient,subject,payload,status,coalesce_key,dedupe_key,created) VALUES(?,?,?,?,?,?,?,?,?)',
      id, item.cluster_id, item.recipient, item.subject, j(item.payload ?? {}), 'PENDING',
      item.coalesce_key ?? null, item.dedupe_key ?? null, at,
    );
    if (!info.changes) {
      const existing = this.get('SELECT * FROM inbox WHERE dedupe_key=?', item.dedupe_key);
      return existing ? decodeInbox(existing) : null;
    }
    if (item.coalesce_key) {
      this.run(
        "DELETE FROM inbox WHERE cluster_id=? AND recipient=? AND coalesce_key=? AND status='PENDING' AND id<>?",
        item.cluster_id, item.recipient, item.coalesce_key, id,
      );
    }
    return decodeInbox(this.get('SELECT * FROM inbox WHERE id=?', id));
  }

  listInbox(clusterId, { recipient, status = 'PENDING', limit, priority = null } = {}) {
    const where = ['cluster_id=?'];
    const args = [clusterId];
    if (recipient) {
      where.push('recipient=?');
      args.push(recipient);
    }
    if (status) {
      where.push('status=?');
      args.push(status);
    }
    // Optional subject priority: the page is what a role sees, so the subjects
    // it must act on have to be inside it. Without this, a handful of older
    // informational rows (a `plan-approved` for an unrelated transaction) fill
    // every page and the later `message`/`agent-anomaly` rows behind them are
    // never shown — the page is a *window*, not a filter, so the ordering is
    // what decides who starves.
    let order = 'created,id';
    const ranked = (Array.isArray(priority) ? priority : []).filter(subject => /^[a-z][a-z0-9-]*$/.test(subject));
    if (ranked.length) {
      // Interpolated, not bound: the values are the plugin's own subject
      // constants, and the parameter order of the WHERE clause stays the
      // caller's — a bound CASE list would silently shift every argument.
      const cases = ranked.map((subject, index) => `WHEN '${subject}' THEN ${index}`).join(' ');
      order = `(CASE subject ${cases} ELSE ${ranked.length} END), created, id`;
    }
    args.push(normalizeLimit(limit, 200, 500));
    return this.all(`SELECT * FROM inbox WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`, ...args).map(decodeInbox);
  }

  countInbox(clusterId, { recipient, status = 'PENDING' } = {}) {
    const where = ['cluster_id=?', 'status=?'];
    const args = [clusterId, status];
    if (recipient) {
      where.push('recipient=?');
      args.push(recipient);
    }
    return Number(this.get(`SELECT COUNT(*) AS c FROM inbox WHERE ${where.join(' AND ')}`, ...args).c);
  }

  consumeInbox(ids) {
    for (const id of ids) this.run("UPDATE inbox SET status='CONSUMED',consumed=? WHERE id=?", this.now(), id);
  }

  /**
   * Put consumed messages back in the queue. A turn that consumed its inbox and
   * then never admitted its prompt did not answer them, and a consumed message is
   * never re-offered.
   */
  reopenInbox(ids) {
    let changed = 0;
    for (const id of ids) {
      this.run("UPDATE inbox SET status='PENDING', consumed=NULL WHERE id=? AND status='CONSUMED'", id);
      changed += this.changed();
    }
    return changed;
  }

  // ----------------------------------------------------------------- budgets

  insertBudget(budget) {
    const at = this.now();
    this.run(
      `INSERT INTO budgets(id,cluster_id,scope_kind,scope_id,node_id,parent_budget_id,
        tokens_limit,tokens_reserved,tokens_spent,requests_limit,requests_reserved,requests_spent,
        tool_calls_limit,tool_calls_reserved,tool_calls_spent,wall_limit_ms,wall_deadline,
        agents_limit,agents_reserved,max_active_limit,max_active_reserved,revision,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      budget.id, budget.cluster_id, budget.scope_kind, budget.scope_id, budget.node_id ?? null, budget.parent_budget_id ?? null,
      budget.tokens_limit ?? 0, budget.tokens_reserved ?? 0, budget.tokens_spent ?? 0,
      budget.requests_limit ?? 0, budget.requests_reserved ?? 0, budget.requests_spent ?? 0,
      budget.tool_calls_limit ?? 0, budget.tool_calls_reserved ?? 0, budget.tool_calls_spent ?? 0,
      budget.wall_limit_ms ?? 0, budget.wall_deadline ?? null,
      budget.agents_limit ?? 0, budget.agents_reserved ?? 0, budget.max_active_limit ?? 0, budget.max_active_reserved ?? 0,
      1, at, at,
    );
    return this.getBudget(budget.id);
  }

  getBudget(id) {
    return this.get('SELECT * FROM budgets WHERE id=?', id) ?? null;
  }

  budgetForScope(clusterId, scopeKind, scopeId) {
    return this.get('SELECT * FROM budgets WHERE cluster_id=? AND scope_kind=? AND scope_id=?', clusterId, scopeKind, scopeId) ?? null;
  }

  listBudgets(clusterId, { parent_budget_id, scope_kind } = {}) {
    const where = ['cluster_id=?'];
    const args = [clusterId];
    if (parent_budget_id !== undefined) {
      where.push(parent_budget_id === null ? 'parent_budget_id IS NULL' : 'parent_budget_id=?');
      if (parent_budget_id !== null) args.push(parent_budget_id);
    }
    if (scope_kind) {
      where.push('scope_kind=?');
      args.push(scope_kind);
    }
    return this.all(`SELECT * FROM budgets WHERE ${where.join(' AND ')} ORDER BY created`, ...args);
  }

  childBudgets(parentId) {
    return this.all('SELECT * FROM budgets WHERE parent_budget_id=? ORDER BY created', parentId);
  }

  updateBudget(id, patch) {
    const row = this.get('SELECT revision FROM budgets WHERE id=?', id);
    if (!row) fail('Budget not found', 404);
    const numeric = [
      'tokens_limit', 'tokens_reserved', 'tokens_spent', 'requests_limit', 'requests_reserved', 'requests_spent',
      'tool_calls_limit', 'tool_calls_reserved', 'tool_calls_spent', 'wall_limit_ms', 'wall_deadline',
      'agents_limit', 'agents_reserved', 'max_active_limit', 'max_active_reserved',
    ];
    const sets = [];
    const args = [];
    for (const column of numeric) {
      if (patch[column] === undefined) continue;
      sets.push(`${column}=?`);
      args.push(patch[column]);
    }
    if (patch.parent_budget_id !== undefined) {
      sets.push('parent_budget_id=?');
      args.push(patch.parent_budget_id);
    }
    if (!sets.length) return this.getBudget(id);
    sets.push('revision=?', 'updated=?');
    args.push(row.revision + 1, this.now(), id);
    this.run(`UPDATE budgets SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getBudget(id);
  }

  bumpBudget(id, deltas, { reset = false } = {}) {
    const row = this.getBudget(id);
    if (!row) fail('Budget not found', 404);
    const patch = { revision: undefined };
    for (const [column, delta] of Object.entries(deltas)) {
      patch[column] = reset ? delta : row[column] + delta;
    }
    return this.updateBudget(id, patch);
  }

  // ---------------------------------------------------------------- usage

  insertUsageReceipt(receipt) {
    this.run(
      `INSERT INTO usage_receipts(request_id,cluster_id,agent_id,node_id,transaction_id,role,kind,provider,model,status,
        reservation_tokens,prompt_tokens,completion_tokens,cached_tokens,reasoning_tokens,total_tokens,overshoot,turn_seq,attempt,note,budget_scope_id,created,settled)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      receipt.request_id, receipt.cluster_id, receipt.agent_id ?? null, receipt.node_id ?? null,
      receipt.transaction_id ?? null, receipt.role, receipt.kind, receipt.provider ?? null, receipt.model ?? null,
      receipt.status, receipt.reservation_tokens ?? 0, receipt.prompt_tokens ?? null, receipt.completion_tokens ?? null,
      receipt.cached_tokens ?? null, receipt.reasoning_tokens ?? null, receipt.total_tokens ?? null,
      receipt.overshoot ?? 0, receipt.turn_seq ?? null, receipt.attempt ?? 1, receipt.note ?? null,
      receipt.budget_scope_id ?? null, this.now(), null,
    );
    return this.getUsageReceipt(receipt.request_id);
  }

  getUsageReceipt(requestId) {
    return this.get('SELECT * FROM usage_receipts WHERE request_id=?', requestId) ?? null;
  }

  settleUsageReceipt(requestId, settlement) {
    const row = this.getUsageReceipt(requestId);
    if (!row) fail('Usage receipt not found', 404);
    if (row.status === 'SETTLED') return row;
    const sets = ['status=?', 'settled=?'];
    const args = [settlement.status ?? 'SETTLED', this.now()];
    for (const column of ['prompt_tokens', 'completion_tokens', 'cached_tokens', 'reasoning_tokens', 'total_tokens', 'overshoot', 'note']) {
      if (settlement[column] === undefined) continue;
      sets.push(`${column}=?`);
      args.push(settlement[column]);
    }
    args.push(requestId);
    this.run(`UPDATE usage_receipts SET ${sets.join(',')} WHERE request_id=?`, ...args);
    return this.getUsageReceipt(requestId);
  }

  listUsageReceipts(clusterId, { agent_id, status, limit, offset } = {}) {
    const where = ['cluster_id=?'];
    const args = [clusterId];
    if (agent_id) {
      where.push('agent_id=?');
      args.push(agent_id);
    }
    if (status) {
      where.push('status=?');
      args.push(status);
    }
    args.push(normalizeLimit(limit), offset ?? 0);
    return this.all(`SELECT * FROM usage_receipts WHERE ${where.join(' AND ')} ORDER BY created,request_id LIMIT ? OFFSET ?`, ...args);
  }

  /** Domain-filtered receipts: neither the count nor offset crosses siblings. */
  usageReceiptsForDomain(clusterId, { scope_node_id, agent_id, status, limit, offset = 0 } = {}) {
    const scope = scope_node_id
      ? `WITH RECURSIVE sub(id) AS (
           SELECT id FROM nodes WHERE cluster_id=? AND id=?
           UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id=sub.id WHERE n.cluster_id=?
         ) `
      : '';
    const where = ['r.cluster_id=?'];
    const args = scope_node_id ? [clusterId, scope_node_id, clusterId, clusterId] : [clusterId];
    if (scope_node_id) where.push('r.node_id IN (SELECT id FROM sub)');
    if (agent_id) { where.push('r.agent_id=?'); args.push(agent_id); }
    if (status) { where.push('r.status=?'); args.push(status); }
    const filter = `FROM usage_receipts r WHERE ${where.join(' AND ')}`;
    const total = Number(this.get(`${scope}SELECT COUNT(*) AS c ${filter}`, ...args).c);
    const items = this.all(`${scope}SELECT r.* ${filter} ORDER BY r.created,r.request_id LIMIT ? OFFSET ?`,
      ...args, normalizeLimit(limit), offset);
    return { items, total };
  }

  /** How many provider requests this identity really dispatched. */
  countWorkerRequests(clusterId, agentId) {
    // A request that never left the client (`NOT_SENT`) is not an attempt: it
    // consumed no allowance and must not make the next real request look like
    // the one that broke the ceiling.
    return Number(this.get(
      "SELECT COUNT(*) AS c FROM usage_receipts WHERE cluster_id=? AND agent_id=? AND kind='worker' AND status<>'NOT_SENT'",
      clusterId, agentId).c ?? 0);
  }

  /** How many provider requests this identity has made, by kind. */
  countUsageReceipts(clusterId, agentId, { kind = null } = {}) {
    const row = kind
      ? this.get('SELECT COUNT(*) AS c FROM usage_receipts WHERE cluster_id=? AND agent_id=? AND kind=?', clusterId, agentId, kind)
      : this.get('SELECT COUNT(*) AS c FROM usage_receipts WHERE cluster_id=? AND agent_id=?', clusterId, agentId);
    return Number(row?.c ?? 0);
  }



  usageSummary(clusterId, { nodeId = null } = {}) {
    const scope = nodeId
      ? `WITH RECURSIVE sub(id) AS (
           SELECT id FROM nodes WHERE cluster_id=? AND id=?
           UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id=sub.id WHERE n.cluster_id=?
         ) `
      : '';
    const args = nodeId ? [clusterId, nodeId, clusterId, clusterId] : [clusterId];
    const row = this.get(
      `${scope}SELECT COUNT(*) AS requests,
              SUM(COALESCE(total_tokens,0)) AS total_tokens,
              SUM(COALESCE(prompt_tokens,0)) AS prompt_tokens,
              SUM(COALESCE(completion_tokens,0)) AS completion_tokens,
              SUM(COALESCE(cached_tokens,0)) AS cached_tokens,
              SUM(COALESCE(reasoning_tokens,0)) AS reasoning_tokens,
              SUM(CASE WHEN status='UNKNOWN' THEN 1 ELSE 0 END) AS unknown_requests,
              SUM(COALESCE(overshoot,0)) AS overshoot
       FROM usage_receipts WHERE cluster_id=?${nodeId ? ' AND node_id IN (SELECT id FROM sub)' : ''}`, ...args);
    return {
      requests: Number(row.requests ?? 0),
      total_tokens: Number(row.total_tokens ?? 0),
      prompt_tokens: Number(row.prompt_tokens ?? 0),
      completion_tokens: Number(row.completion_tokens ?? 0),
      cached_tokens: Number(row.cached_tokens ?? 0),
      reasoning_tokens: Number(row.reasoning_tokens ?? 0),
      unknown_requests: Number(row.unknown_requests ?? 0),
      overshoot: Number(row.overshoot ?? 0),
      // The design's fifth cost dimension. This deployment is locally served, so
      // there is no price to multiply by and no honest number to invent: the
      // field is derived, says so, and is not a ledger column that could silently
      // read as a real charge. See README's deviation table.
      api_cost: { amount: 0, currency: 'USD', pricing: 'local-unpriced' },
    };
  }

  // ------------------------------------------------- messages and recipients

  insertMessage(message) {
    this.run('INSERT INTO messages(id,cluster_id,from_agent,from_node,kind,content,created) VALUES(?,?,?,?,?,?,?)',
      message.id, message.cluster_id, message.from_agent ?? null, message.from_node ?? null, message.kind, j(message.content), this.now());
    return message.id;
  }

  getMessage(id) {
    return this.get('SELECT * FROM messages WHERE id=?', id) ?? null;
  }

  insertRecipient(messageId, recipient) {
    const seq = this.nextCounter(`recipient:${recipient}`);
    this.run('INSERT INTO recipients(message_id,recipient,delivery_seq,status,created) VALUES(?,?,?,?,?)',
      messageId, recipient, seq, 'PENDING', this.now());
    return seq;
  }

  pendingDeliveries(agentId) {
    return this.all("SELECT r.*,m.content,m.from_agent,m.from_node,m.kind,m.created AS message_created FROM recipients r JOIN messages m ON m.id=r.message_id WHERE r.recipient=? AND r.status='PENDING' ORDER BY r.delivery_seq", agentId);
  }

  deliveryFor(messageId, recipient) {
    return this.get('SELECT * FROM recipients WHERE message_id=? AND recipient=?', messageId, recipient) ?? null;
  }

  ackDelivery(messageId, recipient) {
    this.run("UPDATE recipients SET status='ACKED',acked=? WHERE message_id=? AND recipient=? AND status<>'ACKED'", this.now(), messageId, recipient);
  }

  markDeliveryInjected(messageId, recipient) {
    this.run("UPDATE recipients SET status='DELIVERED' WHERE message_id=? AND recipient=? AND status='PENDING'", messageId, recipient);
  }

  counter(name) {
    return this.get('SELECT value FROM counters WHERE scope=?', name)?.value ?? 0;
  }

  nextCounter(name) {
    this.run('INSERT INTO counters(scope,value) VALUES(?,1) ON CONFLICT(scope) DO UPDATE SET value=value+1', name);
    return Number(this.get('SELECT value FROM counters WHERE scope=?', name).value);
  }

  // ---------------------------------------------------------------- groups

  insertGroup(group) {
    this.run('INSERT INTO groups(id,cluster_id,name,status,created,updated) VALUES(?,?,?,?,?,?)',
      group.id, group.cluster_id, group.name, 'OPEN', this.now(), this.now());
    return this.getGroup(group.id);
  }

  getGroup(id) {
    return this.get('SELECT * FROM groups WHERE id=?', id) ?? null;
  }

  groupByName(clusterId, name) {
    return this.get('SELECT * FROM groups WHERE cluster_id=? AND name=?', clusterId, name) ?? null;
  }

  listGroups(clusterId) {
    return this.all('SELECT * FROM groups WHERE cluster_id=? ORDER BY created', clusterId);
  }

  updateGroup(id, patch) {
    const sets = [];
    const args = [];
    for (const [key, column] of [['status', 'status'], ['name', 'name']]) {
      if (patch[key] === undefined) continue;
      sets.push(`${column}=?`);
      args.push(patch[key]);
    }
    if (!sets.length) return this.getGroup(id);
    sets.push('updated=?');
    args.push(this.now(), id);
    this.run(`UPDATE groups SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getGroup(id);
  }

  addGroupMember(groupId, agentId) {
    this.run('INSERT OR IGNORE INTO group_members(group_id,agent_id,created) VALUES(?,?,?)', groupId, agentId, this.now());
  }

  removeGroupMember(groupId, agentId) {
    this.run('DELETE FROM group_members WHERE group_id=? AND agent_id=?', groupId, agentId);
  }

  groupMembers(groupId) {
    return this.all('SELECT agent_id FROM group_members WHERE group_id=? ORDER BY created', groupId).map(r => r.agent_id);
  }

  groupsOfAgent(agentId) {
    return this.all('SELECT g.* FROM groups g JOIN group_members m ON m.group_id=g.id WHERE m.agent_id=?', agentId);
  }

  // ------------------------------------------------------------ blackboard

  blackboardEntry(clusterId, key) {
    return this.get('SELECT * FROM blackboard WHERE cluster_id=? AND key=?', clusterId, key) ?? null;
  }

  blackboardList(clusterId, prefix) {
    // Match the same literal, case-sensitive prefix used for notifications.
    if (prefix) return this.all('SELECT * FROM blackboard WHERE cluster_id=? AND instr(key,?)=1 ORDER BY key', clusterId, prefix);
    return this.all('SELECT * FROM blackboard WHERE cluster_id=? ORDER BY key', clusterId);
  }

  setBlackboard(clusterId, key, value, expectedRevision, updatedBy) {
    const row = this.blackboardEntry(clusterId, key);
    if (!row) {
      this.run('INSERT INTO blackboard(cluster_id,key,value,revision,updated_by,updated) VALUES(?,?,?,?,?,?)',
        clusterId, key, j(value), 1, updatedBy ?? null, this.now());
      return this.blackboardEntry(clusterId, key);
    }
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== row.revision) {
      fail(`blackboard revision conflict: expected ${expectedRevision}, current ${row.revision}`, 409);
    }
    this.run('UPDATE blackboard SET value=?,revision=?,updated_by=?,updated=? WHERE cluster_id=? AND key=?',
      j(value), row.revision + 1, updatedBy ?? null, this.now(), clusterId, key);
    return this.blackboardEntry(clusterId, key);
  }

  // ---------------------------------------------------------- subscriptions

  insertSubscription(sub) {
    this.run('INSERT INTO subscriptions(id,cluster_id,agent_id,pattern,mode,active,cursor,created) VALUES(?,?,?,?,?,?,?,?)',
      sub.id, sub.cluster_id, sub.agent_id, sub.pattern, sub.mode, 1, sub.cursor ?? null, this.now());
    return this.get('SELECT * FROM subscriptions WHERE id=?', sub.id);
  }

  listSubscriptions(clusterId, { agent_id, active } = {}) {
    const where = ['cluster_id=?'];
    const args = [clusterId];
    if (agent_id) {
      where.push('agent_id=?');
      args.push(agent_id);
    }
    if (active !== undefined) {
      where.push('active=?');
      args.push(active ? 1 : 0);
    }
    return this.all(`SELECT * FROM subscriptions WHERE ${where.join(' AND ')} ORDER BY created`, ...args);
  }

  setSubscriptionActive(id, active) {
    this.run('UPDATE subscriptions SET active=? WHERE id=?', active ? 1 : 0, id);
    return this.get('SELECT * FROM subscriptions WHERE id=?', id) ?? null;
  }

  // ------------------------------------------------------------- checkpoints

  insertCheckpoint(checkpoint) {
    this.run(
      `INSERT INTO checkpoints(id,cluster_id,agent_id,session_id,flushed_seq,events_seq,transaction_id,transaction_revision,inbox_ack_cursor,usage_watermark,turn_seq,data,created)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      checkpoint.id, checkpoint.cluster_id, checkpoint.agent_id, checkpoint.session_id,
      checkpoint.flushed_seq ?? null, checkpoint.events_seq ?? null,
      checkpoint.transaction_id ?? null, checkpoint.transaction_revision ?? null,
      checkpoint.inbox_ack_cursor ?? null, checkpoint.usage_watermark ?? null, checkpoint.turn_seq ?? null,
      j(checkpoint.data ?? {}), this.now(),
    );
    return this.get('SELECT * FROM checkpoints WHERE id=?', checkpoint.id);
  }

  getCheckpoint(id) {
    return this.get('SELECT * FROM checkpoints WHERE id=?', id) ?? null;
  }

  latestCheckpoint(clusterId, agentId) {
    return this.get('SELECT * FROM checkpoints WHERE cluster_id=? AND agent_id=? ORDER BY created DESC,rowid DESC LIMIT 1', clusterId, agentId) ?? null;
  }

  listCheckpoints(clusterId, { limit } = {}) {
    return this.all('SELECT * FROM checkpoints WHERE cluster_id=? ORDER BY created DESC LIMIT ?', clusterId, normalizeLimit(limit, 100, 500));
  }

  deleteCheckpointsAfter(clusterId, agentId, checkpointId) {
    this.run('DELETE FROM checkpoints WHERE cluster_id=? AND agent_id=? AND id<>?', clusterId, agentId, checkpointId);
  }

  // --------------------------------------------------------------- summaries

  insertSummary(summary) {
    this.run('INSERT INTO summaries(id,cluster_id,node_id,transaction_id,as_of_seq,data,created) VALUES(?,?,?,?,?,?,?)',
      summary.id, summary.cluster_id, summary.node_id ?? null, summary.transaction_id ?? null,
      summary.as_of_seq ?? 0, j(summary.data), this.now());
    return this.get('SELECT * FROM summaries WHERE id=?', summary.id);
  }

  latestSummary(clusterId, { node_id, transaction_id } = {}) {
    const row = transaction_id
      ? this.get('SELECT * FROM summaries WHERE cluster_id=? AND transaction_id=? ORDER BY created DESC,rowid DESC LIMIT 1', clusterId, transaction_id)
      : this.get('SELECT * FROM summaries WHERE cluster_id=? AND node_id=? ORDER BY created DESC,rowid DESC LIMIT 1', clusterId, node_id);
    return row ? { ...row, data: p(row.data) } : null;
  }

  listSummaries(clusterId, { node_id, transaction_id, limit } = {}) {
    const where = ['cluster_id=?'];
    const args = [clusterId];
    if (node_id) {
      where.push('node_id=?');
      args.push(node_id);
    }
    if (transaction_id) {
      where.push('transaction_id=?');
      args.push(transaction_id);
    }
    args.push(normalizeLimit(limit, 100, 500));
    return this.all(`SELECT * FROM summaries WHERE ${where.join(' AND ')} ORDER BY created DESC LIMIT ?`, ...args
    ).map(r => ({ ...r, data: p(r.data) }));
  }

  // ----------------------------------------------------------------- effects

  insertEffect(effect) {
    this.run(
      `INSERT INTO effects(call_id,cluster_id,agent_id,node_id,lease_epoch,session_id,turn_seq,tool,args,status,body,error,job_id,created,settled)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      effect.call_id, effect.cluster_id, effect.agent_id, effect.node_id ?? null, effect.lease_epoch,
      effect.session_id ?? null, effect.turn_seq ?? null, effect.tool, j(effect.args ?? {}),
      effect.status ?? 'STARTED', effect.body === undefined ? null : j(effect.body), effect.error ?? null,
      effect.job_id ?? null, this.now(), null,
    );
    return this.getEffect(effect.call_id);
  }

  getEffect(callId) {
    return this.get('SELECT * FROM effects WHERE call_id=?', callId) ?? null;
  }

  settleEffect(callId, settlement) {
    const row = this.getEffect(callId);
    if (!row) fail('Effect receipt not found', 404);
    const sets = ['status=?', 'settled=?'];
    const args = [settlement.status ?? 'SETTLED', this.now()];
    for (const column of ['body', 'error', 'job_id']) {
      if (settlement[column] === undefined) continue;
      sets.push(`${column}=?`);
      args.push(column === 'body' && settlement[column] !== null ? j(settlement[column]) : settlement[column]);
    }
    args.push(callId);
    this.run(`UPDATE effects SET ${sets.join(',')} WHERE call_id=?`, ...args);
    return this.getEffect(callId);
  }

  effects(clusterId, { agent_id, status, limit } = {}) {
    const where = ['e.cluster_id=?'];
    const args = [clusterId];
    if (agent_id) {
      where.push('e.agent_id=?');
      args.push(agent_id);
    }
    if (status) {
      where.push('e.status=?');
      args.push(status);
    }
    args.push(normalizeLimit(limit, 200, 500));
    // The physical author of a Worker effect lives on its child Worker node.
    // The management owner is the parent of that node, not e.node_id itself.
    return this.all(`SELECT e.*, CASE WHEN n.kind='worker' THEN n.parent_id ELSE n.id END AS owner_management_id
      FROM effects e LEFT JOIN nodes n ON n.id=e.node_id AND n.cluster_id=e.cluster_id
      WHERE ${where.join(' AND ')} ORDER BY e.created DESC LIMIT ?`, ...args);
  }

  effectByCallIdPrefix(clusterId, callId) {
    return this.get('SELECT * FROM effects WHERE cluster_id=? AND call_id=?', clusterId, callId) ?? null;
  }

  // -------------------------------------------------- tool call receipts

  /**
   * A durable receipt per admitted tool call: which call, which turn, which
   * budget scope paid for it and how far it got. `dispatch_status` is the state
   * machine — `ADMITTED` (quota reserved, effect not started), `DISPATCHED`
   * (the tool is running), `SETTLED`/`FAILED`/`CANCELLED` (finished), or
   * `UNKNOWN` (the process died with it in flight).
   */
  insertToolCallReceipt(receipt) {
    this.run(
      `INSERT INTO tool_call_receipts(call_id,cluster_id,agent_id,session_id,turn_seq,tool,args_hash,command_id,budget_scope_id,dispatch_status,result_body,error,created,settled)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      receipt.call_id, receipt.cluster_id, receipt.agent_id, receipt.session_id ?? null,
      receipt.turn_seq ?? null, receipt.tool, receipt.args_hash, receipt.command_id ?? null,
      receipt.budget_scope_id ?? null, receipt.dispatch_status ?? 'ADMITTED',
      receipt.result_body ?? null, receipt.error ?? null, this.now(), null,
    );
    return this.getToolCallReceipt(receipt.call_id);
  }

  getToolCallReceipt(callId) {
    return this.get('SELECT * FROM tool_call_receipts WHERE call_id=?', callId) ?? null;
  }

  settleToolCallReceipt(callId, settlement = {}) {
    const row = this.getToolCallReceipt(callId);
    if (!row) fail('Tool call receipt not found', 404);
    const sets = ['settled=?'];
    const args = [this.now()];
    for (const column of ['dispatch_status', 'result_body', 'error']) {
      if (settlement[column] === undefined) continue;
      sets.push(`${column}=?`);
      args.push(settlement[column]);
    }
    args.push(callId);
    this.run(`UPDATE tool_call_receipts SET ${sets.join(',')} WHERE call_id=?`, ...args);
    return this.getToolCallReceipt(callId);
  }

  toolCallReceipts(clusterId, { agent_id = null, status = null } = {}) {
    const where = ['cluster_id=?'];
    const args = [clusterId];
    if (agent_id) { where.push('agent_id=?'); args.push(agent_id); }
    if (status) { where.push('dispatch_status=?'); args.push(status); }
    return this.all(`SELECT * FROM tool_call_receipts WHERE ${where.join(' AND ')} ORDER BY created, call_id`, ...args);
  }

  // ----------------------------------------------------------------- health

  insertHealth(row) {
    this.run(
      'INSERT INTO health(id,cluster_id,node_id,evaluation_window,signals,scores,weights,decided,decided_by,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
      row.id, row.cluster_id, row.node_id ?? null, row.evaluation_window ?? null,
      j(row.signals ?? {}), j(row.scores ?? {}), j(row.weights ?? {}), row.decided ? 1 : 0,
      row.decided_by ?? null, this.now(),
    );
    return this.latestHealth(row.cluster_id, {});
  }

  latestHealth(clusterId, { node_id = null } = {}) {
    const row = node_id
      ? this.get('SELECT * FROM health WHERE cluster_id=? AND node_id=? ORDER BY created DESC, rowid DESC LIMIT 1', clusterId, node_id)
      : this.get('SELECT * FROM health WHERE cluster_id=? ORDER BY created DESC, rowid DESC LIMIT 1', clusterId);
    if (!row) return null;
    return { ...row, signals: p(row.signals), scores: p(row.scores), weights: p(row.weights) };
  }

  listHealth(clusterId, { limit = 20 } = {}) {
    return this.all('SELECT * FROM health WHERE cluster_id=? ORDER BY created DESC LIMIT ?', clusterId, normalizeLimit(limit, 20, 200))
      .map(row => ({ ...row, signals: p(row.signals), scores: p(row.scores), weights: p(row.weights) }));
  }

  // ----------------------------------------------------------------- sources

  insertSource(source) {
    this.run(
      `INSERT INTO sources(id,cluster_id,agent_id,node_id,transaction_id,request_url,final_url,status_code,fetched_at,hash,bytes,text)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      source.id, source.cluster_id, source.agent_id, source.node_id ?? null, source.transaction_id ?? null,
      source.request_url, source.final_url, source.status_code ?? null, source.fetched_at,
      source.hash, source.bytes, source.text,
    );
    return this.get('SELECT * FROM sources WHERE id=?', source.id);
  }

  getSource(id) {
    return this.get('SELECT * FROM sources WHERE id=?', id) ?? null;
  }

  listSources(clusterId, { limit, offset } = {}) {
    return this.all('SELECT id,cluster_id,agent_id,transaction_id,request_url,final_url,status_code,fetched_at,hash,bytes FROM sources WHERE cluster_id=? ORDER BY fetched_at,id LIMIT ? OFFSET ?',
      clusterId, normalizeLimit(limit, 200, 500), offset ?? 0);
  }

  countSources(clusterId) {
    return Number(this.get('SELECT COUNT(*) AS c FROM sources WHERE cluster_id=?', clusterId).c);
  }

  // ------------------------------------------------------------------ audits

  insertAudit(audit) {
    this.run(
      `INSERT INTO audits(id,cluster_id,transaction_id,node_id,kind,target_revision,decision,auditor_agent_id,evidence,created,decided)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      audit.id, audit.cluster_id, audit.transaction_id, audit.node_id, audit.kind, audit.target_revision,
      audit.decision ?? 'PENDING', audit.auditor_agent_id ?? null, j(audit.evidence ?? {}), this.now(), null,
    );
    return this.getAudit(audit.id);
  }

  getAudit(id) {
    const row = this.get('SELECT * FROM audits WHERE id=?', id);
    return row ? { ...row, evidence: p(row.evidence) } : null;
  }

  auditsForTransaction(clusterId, transactionId, { limit } = {}) {
    return this.all(
      'SELECT * FROM audits WHERE cluster_id=? AND transaction_id=? ORDER BY created, rowid LIMIT ?',
      clusterId, transactionId, normalizeLimit(limit, 100, 500),
    ).map(row => ({ ...row, evidence: p(row.evidence) }));
  }

  findAudit(clusterId, transactionId, kind, targetRevision) {
    const row = this.get('SELECT * FROM audits WHERE cluster_id=? AND transaction_id=? AND kind=? AND target_revision=? ORDER BY created DESC, rowid DESC LIMIT 1',
      clusterId, transactionId, kind, targetRevision);
    return row ? { ...row, evidence: p(row.evidence) } : null;
  }

  decideAudit(id, decision, auditorAgentId, evidence) {
    const row = this.getAudit(id);
    if (!row) fail('Audit not found', 404);
    if (row.decision !== 'PENDING') return row;
    this.run('UPDATE audits SET decision=?,auditor_agent_id=?,evidence=?,decided=? WHERE id=?',
      decision, auditorAgentId ?? null, j({ ...row.evidence, ...(evidence ?? {}) }), this.now(), id);
    return this.getAudit(id);
  }

  pendingAudits(clusterId, { kind, node_id, limit, after = null } = {}) {
    const where = ["cluster_id=?", "decision='PENDING'"];
    const args = [clusterId];
    if (kind) {
      where.push('kind=?');
      args.push(kind);
    }
    if (node_id) {
      where.push('node_id=?');
      args.push(node_id);
    }
    // A keyset cursor, not an offset: the caller is the Auditor, and taking the
    // oldest eight pending decisions on every turn would starve the ninth
    // forever. `(created, id)` is stable under the decisions it makes.
    if (after) {
      where.push('(created > ? OR (created = ? AND id > ?))');
      args.push(after.created, after.created, after.id);
    }
    args.push(normalizeLimit(limit, 100, 500));
    return this.all(`SELECT * FROM audits WHERE ${where.join(' AND ')} ORDER BY created, id LIMIT ?`, ...args)
      .map(r => ({ ...r, evidence: p(r.evidence) }));
  }

  // ------------------------------------------------------------------ issues

  insertIssue(issue) {
    const at = this.now();
    this.run(
      `INSERT INTO issues(id,cluster_id,node_id,transaction_id,reporter_agent_id,target_revision,severity,evidence,required_change,status,corrections,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      issue.id, issue.cluster_id, issue.node_id, issue.transaction_id ?? null, issue.reporter_agent_id ?? null,
      issue.target_revision ?? 0, issue.severity ?? 'MAJOR', j(issue.evidence ?? {}), issue.required_change ?? '',
      'OPEN', 0, at, at,
    );
    return this.getIssue(issue.id);
  }

  getIssue(id) {
    const row = this.get('SELECT * FROM issues WHERE id=?', id);
    return row ? { ...row, evidence: p(row.evidence) } : null;
  }

  updateIssue(id, patch) {
    const sets = [];
    const args = [];
    for (const [key, column] of [['status', 'status'], ['severity', 'severity'], ['required_change', 'required_change'], ['corrections', 'corrections'], ['target_revision', 'target_revision'], ['reviewed_revision', 'reviewed_revision']]) {
      if (patch[key] === undefined) continue;
      sets.push(`${column}=?`);
      args.push(patch[key]);
    }
    if (patch.evidence !== undefined) {
      sets.push('evidence=?');
      args.push(j(patch.evidence));
    }
    if (!sets.length) return this.getIssue(id);
    sets.push('updated=?');
    args.push(this.now(), id);
    this.run(`UPDATE issues SET ${sets.join(',')} WHERE id=?`, ...args);
    return this.getIssue(id);
  }

  openIssues(clusterId, { node_id, transaction_id, status = 'OPEN' } = {}) {
    const where = ['cluster_id=?'];
    const args = [clusterId];
    if (status) {
      where.push(Array.isArray(status) ? `status IN (${status.map(() => '?').join(',')})` : 'status=?');
      Array.isArray(status) ? args.push(...status) : args.push(status);
    }
    if (node_id) {
      where.push('node_id=?');
      args.push(node_id);
    }
    if (transaction_id) {
      where.push('transaction_id=?');
      args.push(transaction_id);
    }
    return this.all(`SELECT * FROM issues WHERE ${where.join(' AND ')} ORDER BY created`, ...args)
      .map(r => ({ ...r, evidence: p(r.evidence) }));
  }

  /**
   * Correction *rounds* spent on one transaction, not the number of issues opened:
   * `issue.corrections` is the counter `verify_correction` maintains, bumped when a
   * correction fails to verify. Counting issue rows meant two freshly opened issues
   * exhausted a budget configured as two correction rounds, and the branch was blocked
   * with both issues OPEN and `corrections` zero (measured: a node blocked at seq 1554
   * with `corrections=0`, after which the run spent a further three million tokens).
   */
  countCorrections(clusterId, transactionId) {
    return Number(this.get(
      `SELECT COALESCE(SUM(corrections), 0) AS c FROM issues
        WHERE cluster_id=? AND transaction_id=? AND status IN ('OPEN','VERIFYING','CORRECTED','ESCALATED')`,
      clusterId, transactionId,
    ).c);
  }
}

function j(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function p(value) {
  if (value === null || value === undefined) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function decodeCluster(row) {
  if (!row) return null;
  return { ...row, capabilities: p(row.capabilities), limits: p(row.limits), budget: p(row.budget), spec: p(row.spec) };
}

function decodeNode(row) {
  if (!row) return null;
  return { ...row, scope: p(row.scope), capabilities: p(row.capabilities) };
}

function decodeAgent(row) {
  if (!row) return null;
  return { ...row, capabilities: p(row.capabilities), meta: p(row.meta) };
}

function decodeTransaction(row) {
  if (!row) return null;
  return {
    ...row,
    inputs: p(row.inputs), constraints: p(row.constraints), acceptance_criteria: p(row.acceptance_criteria),
    needs: p(row.needs), capabilities: p(row.capabilities), result: p(row.result), validation: p(row.validation),
    result_staged_epoch: row.result_staged_epoch ?? null, result_staged_turn: row.result_staged_turn ?? null,
  };
}

function decodeAllocation(row) {
  if (!row) return null;
  return {
    ...row,
    capabilities: p(row.capabilities),
    write_scope: p(row.write_scope),
    write_scope_canonical: p(row.write_scope_canonical ?? '[]'),
  };
}

function decodeInbox(row) {
  if (!row) return null;
  return { ...row, payload: p(row.payload) };
}

export { j as encodeJson, p as decodeJson, canonical };
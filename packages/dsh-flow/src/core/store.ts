/** Atomic collaboration records. Native tool effects and Session history live in DSH. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FlowTeamRun, FlowMember, FlowTask, FlowResult, FlowReview, FlowMessage, FlowEvent, FlowJsonValue } from '../types.ts';
import { fail } from '../errors.ts';
export const SCHEMA_VERSION = 6;
type Records = { teams: FlowTeamRun; members: FlowMember; tasks: FlowTask; results: FlowResult; reviews: FlowReview; messages: FlowMessage };
type Table = keyof Records;
const tables: Table[] = ['teams', 'members', 'tasks', 'results', 'reviews', 'messages'];
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export class FlowStore {
  readonly db: DatabaseSync;
  private inTransaction = false;
  private closed = false;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.['user_version']);
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if ((version !== 0 && version !== SCHEMA_VERSION) || (version === 0 && existing.length)) {
      this.db.close();
      fail(`Flow schema ${version} is unsupported. Start with a new dataDir; native Session history is retained separately.`, 409);
    }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    for (const table of tables) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, team_id TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_team ON ${table}(team_id);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS events_team ON events(team_id,seq);
      CREATE TABLE IF NOT EXISTS commands(actor TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(actor,id)); PRAGMA user_version=${SCHEMA_VERSION};`);
  }
  transaction<T>(fn: () => T): T {
    if (this.closed) fail('Flow store is closed', 409);
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('A Flow transaction must not await external work');
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  command<T>(actor: string, id: string, kind: string, input: unknown, fn: () => T): T {
    const hash = createHash('sha256').update(canonical(input)).digest('hex');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT kind,hash,result FROM commands WHERE actor=? AND id=?').get(actor, id);
      if (old) {
        if (old['kind'] !== kind || old['hash'] !== hash) fail('Operation ID was reused with different input', 409);
        return JSON.parse(String(old['result'])) as T;
      }
      const result = fn();
      if (result instanceof Promise) throw new Error('A Flow command must not await external work');
      this.db.prepare('INSERT INTO commands VALUES(?,?,?,?,?)').run(actor, id, kind, hash, JSON.stringify(result));
      return result;
    });
  }
  get<K extends Table>(table: K, id: string): Records[K] | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(String(row['data'])) as Records[K] : undefined;
  }
  all<K extends Table>(table: K, teamId?: string): Records[K][] {
    const rows = teamId === undefined ? this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() : this.db.prepare(`SELECT data FROM ${table} WHERE team_id=? ORDER BY rowid`).all(teamId);
    return rows.map(row => JSON.parse(String(row['data'])) as Records[K]);
  }
  put<K extends Table>(table: K, record: Records[K]): Records[K] {
    const teamId = 'team_id' in record ? record.team_id : record.id;
    this.db.prepare(`INSERT INTO ${table}(id,team_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,team_id=excluded.team_id`).run(record.id, teamId, JSON.stringify(record));
    return record;
  }
  event(teamId: string, type: string, data: FlowJsonValue): void {
    this.db.prepare('INSERT INTO events(team_id,type,data,at) VALUES(?,?,?,?)').run(teamId, type, JSON.stringify(data), Date.now());
  }
  events(teamId: string): FlowEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE team_id=? ORDER BY seq').all(teamId).map(row => ({ seq: Number(row['seq']), team_id: String(row['team_id']), type: String(row['type']), data: JSON.parse(String(row['data'])) as FlowJsonValue, at: Number(row['at']) }));
  }
  getTeam(id: string) { return this.get('teams', id); }
  getMember(id: string) { return this.get('members', id); }
  getTask(id: string) { return this.get('tasks', id); }
  getResult(id: string) { return this.get('results', id); }
  getMessage(id: string) { return this.get('messages', id); }
  allTeams() { return this.all('teams'); }
  members(teamId: string) { return this.all('members', teamId); }
  tasks(teamId: string) { return this.all('tasks', teamId); }
  results(teamId: string) { return this.all('results', teamId); }
  reviews(teamId: string) { return this.all('reviews', teamId); }
  messages(teamId: string) { return this.all('messages', teamId); }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}

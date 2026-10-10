// Local simulation persistence only. Never shares credentials, tables or a connection with live ingestion.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Command, SimIdentity, SimSession, Workspace } from '../types';
import { seedOutcome } from '@/outcomes/model';
import { assertWorkspaceLedger, executeCommand, seedWorkspace, WorkflowError } from './workflow';

// Simulation quotas fail closed; no financial history or retry evidence is deleted.
export const MAX_SIMULATION_COMMANDS = 1000;
export const MAX_SIMULATION_RESPONSE_BYTES = 64 * 1024 * 1024;

export class SimulationDatabase {
  private db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS workspaces (tenant TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, identity TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS request_limits (tenant TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (tenant TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT, PRIMARY KEY(tenant,id));`);
    const commandColumns = this.db.prepare('PRAGMA table_info(commands)').all();
    if (!commandColumns.some(column => column.name === 'response')) this.db.exec('ALTER TABLE commands ADD COLUMN response TEXT;');
    if (filename !== ':memory:') chmodSync(filename, 0o600);
  }
  consumeRequest(tenant: string, limit: number, now = Date.now()): boolean {
    const window = Math.floor(now / 60000);
    const row = this.db.prepare(`INSERT INTO request_limits VALUES (?, ?, 1)
      ON CONFLICT(tenant) DO UPDATE SET window=excluded.window, count=CASE WHEN request_limits.window=excluded.window THEN request_limits.count+1 ELSE 1 END
      RETURNING count`).get(tenant, window);
    return Number(row!.count) <= limit;
  }
  integrity(): boolean { return this.db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok'; }
  close() { this.db.close(); }
  createSession(identity: SimIdentity): SimSession & { token: string } {
    const token = randomBytes(32).toString('hex');
    const csrf = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 60 * 60 * 1000;
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(this.hash(token), JSON.stringify(identity), csrf, expiresAt);
    return { token, identity, csrf, expiresAt };
  }
  private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
  session(token: string): SimSession | null {
    const row = this.db.prepare('SELECT identity,csrf,expires FROM sessions WHERE hash=? AND expires>?').get(this.hash(token), Date.now());
    return row ? { identity: JSON.parse(String(row.identity)), csrf: String(row.csrf), expiresAt: Number(row.expires) } : null;
  }
  revoke(token: string) { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(this.hash(token)); }
  read(tenant: string): Workspace {
    this.db.prepare('INSERT OR IGNORE INTO workspaces VALUES (?,?)').run(tenant, JSON.stringify(seedWorkspace()));
    const previous = String(this.db.prepare('SELECT state FROM workspaces WHERE tenant=?').get(tenant)!.state);
    const state = JSON.parse(previous);
    if (![1, 2].includes(state.schema)) throw new WorkflowError(500, 'Unsupported simulation workspace schema.');
    let upgraded = false;
    if (!state.agentJobs) { state.agentJobs = []; upgraded = true; }
    // Older simulated ledgers predate explicit cost classification. They contain only model-usage fixtures.
    const needsClassification = state.ledger.some((r: Partial<Workspace['ledger'][number]>) => !r.category);
    if (needsClassification) state.ledger.forEach((r: Workspace['ledger'][number]) => { r.category = 'model_usage'; });
    if (state.schema === 1) {
      state.schema = 2;
      state.outcomes = Object.fromEntries(state.workloads.map((w: Workspace['workloads'][number]) => [w.id, seedOutcome(w)]));
      upgraded = true;
    }
    assertWorkspaceLedger(state as Workspace);
    if (upgraded || needsClassification) {
      // Compare-and-swap prevents migration reads from overwriting a concurrent command.
      const result = this.db.prepare('UPDATE workspaces SET state=? WHERE tenant=? AND state=?').run(JSON.stringify(state), tenant, previous);
      if (Number(result.changes) === 0) return this.read(tenant);
    }
    return state as Workspace;
  }
  command(actor: SimIdentity, revision: number, id: string, command: Command): Workspace {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.read(actor.tenant);
      // Bind retries to authorization context as well as user and payload.
      // Legacy fingerprints lack a role and therefore fail closed on replay.
      const fingerprint = this.hash(JSON.stringify({ user: actor.user, persona: actor.persona, command }));
      const used = this.db.prepare('SELECT fingerprint,response FROM commands WHERE tenant=? AND id=?').get(actor.tenant, id);
      if (used && used.fingerprint !== fingerprint) throw new WorkflowError(409, 'Request id already used for a different action or identity. Reload and review the saved workspace.');
      // A retry must receive the exact state committed by its first request,
      // even when later commands have advanced the tenant workspace.
      if (used) {
        const response = used.response ? JSON.parse(String(used.response)) : prior;
        this.db.exec('COMMIT');
        return response;
      }
      if (prior.revision !== revision) throw new WorkflowError(409, 'Workspace changed in another session. Reload and review before retrying.');
      const usage = this.db.prepare('SELECT count(*) AS count, coalesce(sum(length(CAST(response AS BLOB))),0) AS bytes FROM commands WHERE tenant=?').get(actor.tenant)!;
      if (Number(usage.count) >= MAX_SIMULATION_COMMANDS) throw new WorkflowError(507, 'Simulation command capacity reached. Export and archive this workspace before starting a new simulation.');
      const next = executeCommand(prior, actor, command);
      const response = JSON.stringify(next);
      if (Number(usage.bytes) + Buffer.byteLength(response) > MAX_SIMULATION_RESPONSE_BYTES) throw new WorkflowError(507, 'Simulation storage capacity reached. Export and archive this workspace before starting a new simulation.');
      this.db.prepare('UPDATE workspaces SET state=? WHERE tenant=?').run(response, actor.tenant);
      this.db.prepare('INSERT INTO commands (tenant,id,fingerprint,response) VALUES (?,?,?,?)').run(actor.tenant, id, fingerprint, response);
      this.db.exec('COMMIT');
      return next;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

let instance: SimulationDatabase | undefined;
export function database(): SimulationDatabase {
  return instance ??= new SimulationDatabase(resolve(/* turbopackIgnore: true */ process.env.RATIO_SIMULATION_DB ?? '.ratio-simulation/customer.sqlite'));
}

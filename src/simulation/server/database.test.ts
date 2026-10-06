import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimulationDatabase } from './database';
const paths: string[] = [];
afterEach(() => { vi.restoreAllMocks(); paths.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
describe('simulation durable isolation', () => {
  it('expires an otherwise valid opaque session at its deadline', () => {
    const db = new SimulationDatabase(':memory:');
    const session = db.createSession({ tenant: 'acme', user: 'expiry', persona: 'technical' });
    expect(db.session(session.token)).not.toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(session.expiresAt);
    expect(db.session(session.token)).toBeNull();
    db.close();
  });
  it('survives reopen, isolates tenants, revokes sessions and rejects stale writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ratio-sim-')); paths.push(dir);
    const file = join(dir, 'state.sqlite'); let db = new SimulationDatabase(file);
    const identity = { tenant: 'acme', user: 'a', persona: 'technical' as const };
    const session = db.createSession(identity);
    const a = db.read('acme');
    const next = db.command(identity, a.revision, 'request-0001', { type: 'sync', source: 'aws' });
    const later = db.command(identity, next.revision, 'request-0002', { type: 'sync', source: 'gcp' });
    expect(db.command(identity, 0, 'request-0001', { type: 'sync', source: 'aws' })).toEqual(next);
    expect(db.read('acme')).toEqual(later);
    expect(() => db.command(identity, 0, 'request-0003', { type: 'sync', source: 'azure' })).toThrow(/another session/);
    expect(db.read('northstar').imports).toEqual([]);
    db.close(); db = new SimulationDatabase(file);
    expect(db.read('acme')).toEqual(later);
    expect(db.session(session.token)?.identity).toEqual(identity);
    expect(db.session('forged')).toBeNull(); db.revoke(session.token);
    expect(db.session(session.token)).toBeNull(); db.close();
  });
  it('refuses semantically corrupt persisted financial ledgers', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'ratio-ledger-integrity-')); paths.push(dir);
    const file = join(dir, 'state.sqlite');
    const db = new SimulationDatabase(file);
    const state = db.read('acme');
    db.close();
    state.ledger.push({ ...state.ledger[0] });
    const sql = new DatabaseSync(file);
    sql.prepare('UPDATE workspaces SET state=? WHERE tenant=?').run(JSON.stringify(state), 'acme');
    sql.close();
    const reopened = new SimulationDatabase(file);
    try {
      expect(() => reopened.read('acme')).toThrow(/integrity validation/);
    } finally { reopened.close(); }
  });
});
it('migrates legacy idempotency rows without rewriting their committed workspace', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'ratio-command-migration-')); paths.push(dir);
  const file = join(dir, 'legacy.sqlite');
  const sql = new DatabaseSync(file);
  sql.exec(`CREATE TABLE workspaces (tenant TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE sessions (hash TEXT PRIMARY KEY, identity TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE request_limits (tenant TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
    CREATE TABLE commands (tenant TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(tenant,id));`);
  sql.close();
  const db = new SimulationDatabase(file);
  try {
    const columns = (db as unknown as { db: InstanceType<typeof DatabaseSync> }).db.prepare('PRAGMA table_info(commands)').all();
    expect(columns.map(column => column.name)).toContain('response');
    expect(db.read('acme').revision).toBe(0);
  } finally { db.close(); }
});
it('upgrades an existing workspace without discarding costs, imports or revisions', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'ratio-outcome-migration-')); paths.push(dir);
  const file = join(dir, 'legacy.sqlite'); let db = new SimulationDatabase(file);
  const identity = { tenant: 'acme', user: 'legacy', persona: 'technical' as const };
  const initial = db.read('acme'); const saved = db.command(identity, initial.revision, 'legacy-import', { type: 'sync', source: 'aws' }); db.close();
  const sql = new DatabaseSync(file); sql.exec("UPDATE workspaces SET state=json_remove(json_set(state,'$.schema',1),'$.outcomes')"); sql.close();
  db = new SimulationDatabase(file); const migrated = db.read('acme');
  expect(migrated.schema).toBe(2); expect(Object.keys(migrated.outcomes)).toHaveLength(saved.workloads.length);
  expect(migrated.ledger).toEqual(saved.ledger); expect(migrated.imports).toEqual(saved.imports); expect(migrated.revision).toBe(saved.revision);
  expect(db.read('northstar').revision).toBe(0); db.close();
});
it('does not overwrite a concurrent command while upgrading an old workspace', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'ratio-outcome-race-')); paths.push(dir);
  const file = join(dir, 'race.sqlite'); const a = new SimulationDatabase(file);
  const identity = { tenant: 'acme', user: 'race', persona: 'technical' as const };
  a.read('acme');
  const sql = new DatabaseSync(file); sql.exec("UPDATE workspaces SET state=json_remove(json_set(state,'$.schema',1),'$.outcomes')"); sql.close();
  const b = new SimulationDatabase(file);
  // Force an actual second connection to commit after A reads old JSON, before A can migrate it.
  const connection = (a as unknown as { db: InstanceType<typeof DatabaseSync> }).db;
  const prepare = connection.prepare.bind(connection); let interleaved = false;
  vi.spyOn(connection, 'prepare').mockImplementation(query => {
    const statement = prepare(query);
    if (query === 'SELECT state FROM workspaces WHERE tenant=?') {
      const get = statement.get.bind(statement);
      vi.spyOn(statement, 'get').mockImplementation((...args) => {
        const row = get(...args);
        if (!interleaved) { interleaved = true; b.command(identity, 0, 'race-import', { type: 'sync', source: 'gcp' }); }
        return row;
      });
    }
    return statement;
  });
  const result = a.read('acme');
  expect(interleaved).toBe(true); expect(result.revision).toBe(1);
  expect(result.imports).toEqual(['fixture-june-v1:gcp']); expect(result.schema).toBe(2);
  vi.restoreAllMocks(); a.close(); b.close();
});
it('shares request limits across connections and resets the window without changing workspace state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ratio-limits-')); paths.push(dir);
  const file = join(dir, 'limits.sqlite'); const a = new SimulationDatabase(file), b = new SimulationDatabase(file);
  try {
    expect(a.consumeRequest('acme', 2, 60000)).toBe(true);
    expect(b.consumeRequest('acme', 2, 60000)).toBe(true);
    expect(a.consumeRequest('acme', 2, 60000)).toBe(false);
    expect(b.consumeRequest('northstar', 2, 60000)).toBe(true);
    expect(b.consumeRequest('acme', 2, 120000)).toBe(true);
    expect(a.read('acme').revision).toBe(0);
  } finally { a.close(); b.close(); }
});

// A1 tenant isolation on Postgres (ADR-0001 §12-13): the DRAFT 0020_platform_connections applied on top of every
// merged migration in a throwaway database (it is not in src/ingest/db/migrations; see draftMigration.test.ts).
// ratio_worker with tenant A never sees, writes or links tenant B's rows; evidence refs are append-only; the reader
// has no access; the ladder CHECK never admits "connected". Each scenario applies the draft, seeds and runs inside ONE
// transaction that always rolls back (nothing is committed; the parallel-DB role guard can verify it), switching
// roles and tenants with SET LOCAL. SYNTHETIC ids only.
import fs from 'fs';
import path from 'path';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privilegeModelViolations } from '../db/privilegeModel';
import { attempt, createTestDatabase, type TestDatabase } from '../db/testing/harness';
import { connector } from '../../platform/contracts/testing/fixtures';
import { EVIDENCE_REF_SCHEMA } from './connections';

const DRAFTS = path.resolve(__dirname, '..', '..', '..', 'docs', 'migrations', 'drafts');
const UP = fs.readFileSync(path.join(DRAFTS, '0020_platform_connections.up.sql'), 'utf8');
const DOWN = fs.readFileSync(path.join(DRAFTS, '0020_platform_connections.down.sql'), 'utf8');
const A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const B = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const SHA = 'c'.repeat(64);
const decl = (connectorId = 'provider-a-usage-file') => JSON.stringify({ ...connector(), connectorId });
const CONN = `INSERT INTO ratio.platform_connections (tenant_id, connection_id, schema_version, connector_id, category, declaration, managed_state, ladder_step, verification)
              VALUES ($1, $2, 'connector-declaration/1', $3, 'model_provider_usage', $4::jsonb, $5, $6, 'not_verified')`;
const REF = `INSERT INTO ratio.platform_evidence_refs (tenant_id, ref_id, connection_id, schema_version, kind, locator, sha256, recorded_at)
             VALUES ($1, gen_random_uuid(), $2, '${EVIDENCE_REF_SCHEMA}', $3, $4, '${SHA}', '2026-11-05T10:00:00Z')`;

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
});
afterAll(async () => {
  await db?.close();
});

/** Applies the draft, seeds two tenants (as the superuser) and runs fn in the same transaction; always rolls back. */
async function inDraft(fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(UP);
    await c.query('RESET ROLE'); // the draft ends as ratio_owner (its SET LOCAL ROLE); seed as the superuser
    await c.query(`INSERT INTO ratio.tenants (id, slug) VALUES ($1, 'tenant-a'), ($2, 'tenant-b')`, [A, B]);
    for (const [t, id, cid] of [[A, 'usage-file', 'provider-a-usage-file'], [B, 'usage-file', 'provider-b-usage-file'], [B, 'b-only', 'provider-a-usage-file']]) {
      await c.query(CONN, [t, id, cid, decl(cid), 'extraction-completed', 'retrieved']);
      await c.query(REF, [t, id, 'sync_run', `evidence/${t.slice(0, 8)}/${id}/run-1.json`]);
    }
    await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
/** The rows of a statement that must succeed (inside the scenario's transaction). */
async function rows(c: PoolClient, sql: string, params: unknown[] = []) {
  const r = await attempt(c, sql, params);
  if (!r.ok) throw new Error(`expected success, got ${r.code}`);
  return r.rows;
}
/** Switches the transaction to `role` with `tenant` (empty = none), both transaction-local. */
async function as(c: PoolClient, role: 'ratio_worker' | 'ratio_reader', tenant: string) {
  expect(await attempt(c, `SET LOCAL ROLE ${role}`)).toMatchObject({ ok: true });
  expect(await attempt(c, "SELECT set_config('ratio.tenant_id', $1, true)", [tenant])).toMatchObject({ ok: true });
}

describe('draft 0020 on Postgres: tenant isolation (RLS)', () => {
  it('ratio_worker with tenant A sees only tenant A\'s connections and evidence refs', () => inDraft(async (c) => {
    await as(c, 'ratio_worker', A);
    expect((await rows(c, 'SELECT tenant_id, connection_id, connector_id FROM ratio.platform_connections ORDER BY connection_id')))
      .toEqual([{ tenant_id: A, connection_id: 'usage-file', connector_id: 'provider-a-usage-file' }]);
    expect((await rows(c, 'SELECT DISTINCT tenant_id FROM ratio.platform_evidence_refs'))).toEqual([{ tenant_id: A }]);
  }));
  it('without a tenant setting the worker sees and writes nothing', () => inDraft(async (c) => {
    await as(c, 'ratio_worker', '');
    expect((await rows(c, 'SELECT count(*)::int AS n FROM ratio.platform_connections'))).toEqual([{ n: 0 }]);
    expect((await rows(c, 'SELECT count(*)::int AS n FROM ratio.platform_evidence_refs'))).toEqual([{ n: 0 }]);
    expect(await attempt(c, CONN, [A, 'x', 'provider-a-usage-file', decl(), 'configured-not-verified', 'configured'])).toMatchObject({ ok: false, code: '42501' });
  }));
  it('tenant A cannot insert or change tenant B\'s rows, nor link evidence to a connection only B has', () => inDraft(async (c) => {
    await as(c, 'ratio_worker', A);
    expect(await attempt(c, CONN, [B, 'new', 'provider-a-usage-file', decl(), 'configured-not-verified', 'configured'])).toMatchObject({ ok: false, code: '42501' });
    expect(await attempt(c, REF, [B, 'usage-file', 'sync_run', 'evidence/x.json'])).toMatchObject({ ok: false, code: '42501' });
    expect(await attempt(c, `UPDATE ratio.platform_connections SET managed_state = 'failed', ladder_step = NULL WHERE tenant_id = $1`, [B])).toMatchObject({ ok: true, rowCount: 0 });
    expect(await attempt(c, `UPDATE ratio.platform_connections SET tenant_id = $1 WHERE connection_id = 'usage-file'`, [B])).toMatchObject({ ok: false, code: '42501' });
    expect(await attempt(c, REF, [A, 'b-only', 'sync_run', 'evidence/x.json'])).toMatchObject({ ok: false, code: '23503' });
    expect(await attempt(c, CONN, [A, 'second', 'provider-a-usage-file', decl(), 'configured-not-verified', 'configured'])).toMatchObject({ ok: true, rowCount: 1 });
    await as(c, 'ratio_worker', B);
    expect((await rows(c, `SELECT managed_state FROM ratio.platform_connections WHERE connection_id = 'usage-file'`))).toEqual([{ managed_state: 'extraction-completed' }]);
    expect((await rows(c, 'SELECT count(*)::int AS n FROM ratio.platform_connections'))).toEqual([{ n: 2 }]);
  }));
  it('evidence refs are append-only for the worker, and the reader has no access to either table', () => inDraft(async (c) => {
    await as(c, 'ratio_worker', A);
    expect(await attempt(c, `UPDATE ratio.platform_evidence_refs SET locator = 'evidence/other.json'`)).toMatchObject({ ok: false, code: '42501' });
    expect(await attempt(c, 'DELETE FROM ratio.platform_evidence_refs')).toMatchObject({ ok: false, code: '42501' });
    expect(await attempt(c, 'DELETE FROM ratio.platform_connections')).toMatchObject({ ok: false, code: '42501' });
    await as(c, 'ratio_reader', A);
    for (const t of ['platform_connections', 'platform_evidence_refs']) expect(await attempt(c, `SELECT 1 FROM ratio.${t}`), t).toMatchObject({ ok: false, code: '42501' });
  }));
  it('the ladder CHECK follows the M0a map and never admits "connected"; declarations and locators refuse secrets', () => inDraft(async (c) => {
    await as(c, 'ratio_worker', A);
    const bad: Array<[string, unknown[]]> = [
      [CONN, [A, 'c1', 'provider-a-usage-file', decl(), 'connected', null]],
      [CONN, [A, 'c2', 'provider-a-usage-file', decl(), 'configured-not-verified', 'connected']],
      [CONN, [A, 'c3', 'provider-a-usage-file', decl(), 'auth-verified', 'reconciled']],
      [CONN, [A, 'c4', 'provider-a-usage-file', decl(), 'degraded', 'authorized']],
      [CONN, [A, 'c5', 'provider-a-usage-file', decl('provider-z'), 'configured-not-verified', 'configured']],
      [CONN, [A, 'c6', 'provider-a-usage-file', JSON.stringify({ ...connector(), refreshCadence: 'https://u:p@host/x' }), 'configured-not-verified', 'configured']],
      [REF, [A, 'usage-file', 'sync_run', 'https://user:pw@host/run.json']],
      [REF, [A, 'usage-file', 'connected', 'evidence/x.json']],
    ];
    for (const [sql, params] of bad) expect(await attempt(c, sql, params), JSON.stringify(params.slice(1))).toMatchObject({ ok: false, code: '23514' });
    expect(await attempt(c, CONN, [A, 'c7', 'provider-a-usage-file', decl(), 'degraded', null])).toMatchObject({ ok: true });
    expect(await attempt(c, CONN, [A, 'c8', 'provider-a-usage-file', decl(), 'live-verified', 'reconciled'])).toMatchObject({ ok: true });
  }));
  it('against the reviewed privilege model, the only deviations are the five worker grants that promotion must review', () => inDraft(async (c) => {
    expect((await privilegeModelViolations(c)).sort()).toEqual([
      'ratio_worker holds relation:ratio.platform_connections:INSERT beyond the reviewed set',
      'ratio_worker holds relation:ratio.platform_connections:SELECT beyond the reviewed set',
      'ratio_worker holds relation:ratio.platform_connections:UPDATE beyond the reviewed set',
      'ratio_worker holds relation:ratio.platform_evidence_refs:INSERT beyond the reviewed set',
      'ratio_worker holds relation:ratio.platform_evidence_refs:SELECT beyond the reviewed set',
    ]);
  }));
  it('the down file removes exactly the two tables', () => inDraft(async (c) => {
    await c.query(DOWN);
    const r = await c.query(`SELECT to_regclass('ratio.platform_connections') AS a, to_regclass('ratio.platform_evidence_refs') AS b, to_regclass('ratio.tenants') AS t`);
    expect(r.rows[0]).toEqual({ a: null, b: null, t: 'ratio.tenants' });
  }));
  it('nothing was committed: the draft\'s tables do not exist outside the scenarios', async () => {
    const r = await db.pool.query(`SELECT to_regclass('ratio.platform_connections') AS a, to_regclass('ratio.platform_evidence_refs') AS b`);
    expect(r.rows[0]).toEqual({ a: null, b: null });
  });
});

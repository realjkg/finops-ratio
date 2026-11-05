// A1 tenant isolation on Postgres (ADR-0001 §12-13): the DRAFT 0020_platform_connections applied on top of every
// merged migration in a throwaway database (it is not in src/ingest/db/migrations; see draftMigration.test.ts).
// ratio_worker with tenant A never sees, writes or links tenant B's rows; evidence refs are append-only; the reader
// has no access; the ladder CHECK never admits "connected". SYNTHETIC ids only.
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attempt, createTestDatabase, withRole, type TestDatabase } from '../db/testing/harness';
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

async function asSuper(sql: string, params: unknown[] = []) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(sql, params);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  await asSuper(UP);
  await asSuper(`INSERT INTO ratio.tenants (id, slug) VALUES ($1, 'tenant-a'), ($2, 'tenant-b')`, [A, B]);
  for (const [t, id, cid] of [[A, 'usage-file', 'provider-a-usage-file'], [B, 'usage-file', 'provider-b-usage-file'], [B, 'b-only', 'provider-a-usage-file']]) {
    await asSuper(CONN, [t, id, cid, decl(cid), 'extraction-completed', 'retrieved']);
    await asSuper(REF, [t, id, 'sync_run', `evidence/${t.slice(0, 8)}/${id}/run-1.json`]);
  }
});
afterAll(async () => {
  await db?.close();
});

describe('draft 0020 on Postgres: tenant isolation (RLS)', () => {
  it('ratio_worker with tenant A sees only tenant A\'s connections and evidence refs', async () => {
    await withRole(db.pool, 'ratio_worker', A, async (c) => {
      const conns = await c.query('SELECT tenant_id, connection_id, connector_id FROM ratio.platform_connections ORDER BY connection_id');
      expect(conns.rows).toEqual([{ tenant_id: A, connection_id: 'usage-file', connector_id: 'provider-a-usage-file' }]);
      const refs = await c.query('SELECT DISTINCT tenant_id FROM ratio.platform_evidence_refs');
      expect(refs.rows).toEqual([{ tenant_id: A }]);
    });
  });
  it('without a tenant setting the worker sees and writes nothing', async () => {
    await withRole(db.pool, 'ratio_worker', null, async (c) => {
      expect((await c.query('SELECT count(*)::int AS n FROM ratio.platform_connections')).rows[0].n).toBe(0);
      expect((await c.query('SELECT count(*)::int AS n FROM ratio.platform_evidence_refs')).rows[0].n).toBe(0);
      expect(await attempt(c, CONN, [A, 'x', 'provider-a-usage-file', decl(), 'configured-not-verified', 'configured'])).toMatchObject({ ok: false, code: '42501' });
    });
  });
  it('tenant A cannot insert or change tenant B\'s rows, nor link evidence to a connection only B has', async () => {
    await withRole(db.pool, 'ratio_worker', A, async (c) => {
      expect(await attempt(c, CONN, [B, 'new', 'provider-a-usage-file', decl(), 'configured-not-verified', 'configured'])).toMatchObject({ ok: false, code: '42501' });
      expect(await attempt(c, REF, [B, 'usage-file', 'sync_run', 'evidence/x.json'])).toMatchObject({ ok: false, code: '42501' });
      expect(await attempt(c, `UPDATE ratio.platform_connections SET managed_state = 'failed', ladder_step = NULL WHERE tenant_id = $1`, [B])).toMatchObject({ ok: true, rowCount: 0 });
      expect(await attempt(c, `UPDATE ratio.platform_connections SET tenant_id = $1 WHERE connection_id = 'usage-file'`, [B])).toMatchObject({ ok: false, code: '42501' });
      expect(await attempt(c, REF, [A, 'b-only', 'sync_run', 'evidence/x.json'])).toMatchObject({ ok: false, code: '23503' });
      expect(await attempt(c, CONN, [A, 'second', 'provider-a-usage-file', decl(), 'configured-not-verified', 'configured'])).toMatchObject({ ok: true, rowCount: 1 });
    });
    await withRole(db.pool, 'ratio_worker', B, async (c) => {
      expect((await c.query(`SELECT managed_state FROM ratio.platform_connections WHERE connection_id = 'usage-file'`)).rows).toEqual([{ managed_state: 'extraction-completed' }]);
    });
  });
  it('evidence refs are append-only for the worker, and the reader has no access to either table', async () => {
    await withRole(db.pool, 'ratio_worker', A, async (c) => {
      expect(await attempt(c, `UPDATE ratio.platform_evidence_refs SET locator = 'evidence/other.json'`)).toMatchObject({ ok: false, code: '42501' });
      expect(await attempt(c, 'DELETE FROM ratio.platform_evidence_refs')).toMatchObject({ ok: false, code: '42501' });
      expect(await attempt(c, 'DELETE FROM ratio.platform_connections')).toMatchObject({ ok: false, code: '42501' });
    });
    await withRole(db.pool, 'ratio_reader', A, async (c) => {
      for (const t of ['platform_connections', 'platform_evidence_refs']) expect(await attempt(c, `SELECT 1 FROM ratio.${t}`), t).toMatchObject({ ok: false, code: '42501' });
    });
  });
  it('the ladder CHECK follows the M0a map and never admits "connected"; declarations and locators refuse secrets', async () => {
    await withRole(db.pool, 'ratio_worker', A, async (c) => {
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
    });
  });
  it('the down file removes exactly the two tables', async () => {
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(DOWN);
      const r = await c.query(`SELECT to_regclass('ratio.platform_connections') AS a, to_regclass('ratio.platform_evidence_refs') AS b, to_regclass('ratio.tenants') AS t`);
      expect(r.rows[0]).toEqual({ a: null, b: null, t: 'ratio.tenants' });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

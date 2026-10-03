// Tenant isolation for ratio_worker: RLS on every table, composite FKs,
// transaction-local tenant setting, and the published-facts view.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { attempt, createTestDatabase, withRole, type TestDatabase } from './testing/harness';
import { TENANT_TABLES, artifactSha, fp, seedTwoTenants, type Seeded } from './testing/fixtures';
import { withTenantTransaction } from './tenant';

let db: TestDatabase;
let seed: Seeded;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  seed = await seedTwoTenants(db.pool);
});
afterAll(async () => {
  await db?.close();
});

/** Row counts per table for one tenant, as the superuser (ground truth). */
async function superCount(table: string, col: string, tenantId: string): Promise<number> {
  const r = await db.pool.query(`SELECT count(*)::int AS n FROM ratio.${table} WHERE ${col} = $1`, [tenantId]);
  return r.rows[0].n;
}

/** Valid-looking tenant B rows, used to prove tenant A's worker cannot insert them. */
function tenantBInserts(s: Seeded): Array<{ table: string; sql: string; params: unknown[] }> {
  const b = s.b;
  const newBatchFp = fp('b-new-set');
  return [
    {
      table: 'sync_runs',
      sql: `INSERT INTO ratio.sync_runs (tenant_id, id, source_id, run_kind, status, attempt, started_at, finished_at)
            VALUES ($1, gen_random_uuid(), $2, 'backfill', 'succeeded', 1, now(), now())`,
      params: [b.tenantId, b.sourceId],
    },
    {
      table: 'ingest_batches',
      sql: `INSERT INTO ratio.ingest_batches (tenant_id, id, source_id, run_id, billing_period, artifact_set_fingerprint, status, row_count, loaded_billed_total, reconciliation, is_provisional)
            VALUES ($1, gen_random_uuid(), $2, $3, '2026-09-01', $4, 'staged', 0, 0, 'unverified', true)`,
      params: [b.tenantId, b.sourceId, b.runNew, newBatchFp],
    },
    {
      table: 'ingest_artifacts',
      sql: `INSERT INTO ratio.ingest_artifacts (tenant_id, source_id, batch_id, artifact_name, sha256, byte_size, row_count, evidence_key)
            VALUES ($1::uuid, $2::uuid, $3, 'part-9.csv.gz', $4::text, 1, 0, 'evidence/' || $1::text || '/' || $2::text || '/' || $4::text)`,
      params: [b.tenantId, b.sourceId, b.batchStaged, fp('b-part-9')],
    },
    {
      table: 'ingest_validation_errors',
      sql: `INSERT INTO ratio.ingest_validation_errors (tenant_id, batch_id, error_ordinal, artifact_sha256, code, message)
            VALUES ($1, $2, 99, $3, 'MISSING_COLUMN', 'x')`,
      params: [b.tenantId, b.batchQuarantined, artifactSha(b.slug, b.batchQuarantined)],
    },
    {
      table: 'cost_facts',
      sql: `INSERT INTO ratio.cost_facts (tenant_id, batch_id, source_id, artifact_sha256, row_ordinal, billing_period, charge_period_start, charge_period_end, billed_cost, billing_currency)
            SELECT $1::uuid, $2::uuid, $3::uuid, $4::text, 99, $5::date, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', 1, 'USD'`,
      params: [b.tenantId, b.batchStaged, b.sourceId, artifactSha(b.slug, b.batchStaged), b.period],
    },
    {
      table: 'period_publications',
      sql: `INSERT INTO ratio.period_publications (tenant_id, source_id, billing_period, batch_id, published_at, published_by_run_id)
            VALUES ($1, $2, '2026-07-01', $3, now(), $4)`,
      params: [b.tenantId, b.sourceId, b.batchStaged, b.runNew],
    },
    {
      table: 'source_checkpoints',
      sql: `INSERT INTO ratio.source_checkpoints (tenant_id, source_id, last_run_id, periods, updated_at)
            VALUES ($1, $2, $3, '{}', now())`,
      params: [b.tenantId, b.sourceId, b.runNew],
    },
  ];
}

describe('ratio_worker tenant isolation', () => {
  it("worker with tenant A sees none of tenant B's rows in any table", async () => {
    for (const { table, tenantCol } of TENANT_TABLES) {
      const expectedA = await superCount(table, tenantCol, seed.a.tenantId);
      expect(expectedA, table).toBeGreaterThan(0);
      expect(await superCount(table, tenantCol, seed.b.tenantId), table).toBeGreaterThan(0);
      await withRole(db.pool, 'ratio_worker', seed.a.tenantId, async (c) => {
        const onlyB = await c.query(`SELECT count(*)::int AS n FROM ratio.${table} WHERE ${tenantCol} = $1`, [seed.b.tenantId]);
        expect(onlyB.rows[0].n, table).toBe(0);
        const all = await c.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE ${tenantCol} <> $1)::int AS other FROM ratio.${table}`, [
          seed.a.tenantId,
        ]);
        expect(all.rows[0], table).toEqual({ n: expectedA, other: 0 });
        // Lookup by B's primary identifiers also finds nothing.
        const byId = await c.query(`SELECT count(*)::int AS n FROM ratio.${table} WHERE ${tenantCol}::text LIKE 'bbbbbbbb%'`);
        expect(byId.rows[0].n, table).toBe(0);
      });
    }
  });

  it('worker with tenant A cannot update tenant B rows (0 rows affected, data unchanged)', async () => {
    const updates: Array<[string, string, string]> = [
      ['sync_runs', `stats = '{"hacked":true}'`, 'stats::text'],
      // Only staged batches are mutable (immutability triggers), so the batch probe
      // is an exact no-op update: it still shows which rows RLS lets the worker touch.
      ['ingest_batches', 'row_count = row_count', 'row_count::text'],
      ['period_publications', `published_at = '2000-01-01T00:00:00Z'`, 'published_at::text'],
      ['source_checkpoints', `periods = '{"hacked":"x"}'`, 'periods::text'],
    ];
    for (const [table, setClause, probe] of updates) {
      const before = await db.pool.query(`SELECT ${probe} AS v FROM ratio.${table} WHERE tenant_id = $1 ORDER BY 1`, [seed.b.tenantId]);
      await withRole(db.pool, 'ratio_worker', seed.a.tenantId, async (c) => {
        const targeted = await c.query(`UPDATE ratio.${table} SET ${setClause} WHERE tenant_id = $1`, [seed.b.tenantId]);
        expect(targeted.rowCount, table).toBe(0);
        // An unqualified UPDATE touches only tenant A's rows.
        const unqualified = await c.query(`UPDATE ratio.${table} SET ${setClause}`);
        expect(unqualified.rowCount, table).toBe(await superCount(table, 'tenant_id', seed.a.tenantId));
      });
      const after = await db.pool.query(`SELECT ${probe} AS v FROM ratio.${table} WHERE tenant_id = $1 ORDER BY 1`, [seed.b.tenantId]);
      expect(after.rows, table).toEqual(before.rows);
    }
  });

  it('worker with tenant A cannot delete tenant B rows', async () => {
    for (const table of ['ingest_validation_errors', 'cost_facts', 'ingest_artifacts', 'ingest_batches']) {
      const before = await superCount(table, 'tenant_id', seed.b.tenantId);
      await withRole(db.pool, 'ratio_worker', seed.a.tenantId, async (c) => {
        const r = await attempt(c, `DELETE FROM ratio.${table} WHERE tenant_id = $1`, [seed.b.tenantId]);
        expect(r, table).toMatchObject({ ok: true, rowCount: 0 });
      });
      expect(await superCount(table, 'tenant_id', seed.b.tenantId), table).toBe(before);
    }
  });

  it("worker with tenant A cannot insert rows carrying tenant B's id", async () => {
    const cases = tenantBInserts(seed);
    expect(cases.map((x) => x.table).sort()).toEqual(
      ['cost_facts', 'ingest_artifacts', 'ingest_batches', 'ingest_validation_errors', 'period_publications', 'source_checkpoints', 'sync_runs'],
    );
    for (const { table, sql, params } of cases) {
      await withRole(db.pool, 'ratio_worker', seed.a.tenantId, async (c) => {
        const r = await attempt(c, sql, params);
        expect(r.ok, table).toBe(false);
        if (!r.ok) {
          expect(r.code, table).toBe('42501');
          expect(r.message, table).toMatch(/row-level security/);
        }
      });
    }
  });

  it('worker with tenant A cannot re-assign its own row to tenant B', async () => {
    await withRole(db.pool, 'ratio_worker', seed.a.tenantId, async (c) => {
      const r = await attempt(c, `UPDATE ratio.sync_runs SET tenant_id = $1 WHERE id = $2`, [seed.b.tenantId, seed.a.runOld]);
      expect(r).toMatchObject({ ok: false, code: '42501' });
    });
  });

  it('with no tenant set the worker sees zero rows everywhere and cannot insert', async () => {
    await withRole(db.pool, 'ratio_worker', null, async (c) => {
      for (const { table } of TENANT_TABLES) {
        const r = await c.query(`SELECT count(*)::int AS n FROM ratio.${table}`);
        expect(r.rows[0].n, table).toBe(0);
      }
      const v = await c.query(`SELECT count(*)::int AS n FROM ratio.cost_facts_published`);
      expect(v.rows[0].n).toBe(0);
      const ins = await attempt(
        c,
        `INSERT INTO ratio.sync_runs (tenant_id, id, source_id, run_kind, status, attempt, started_at, finished_at)
         VALUES ($1, gen_random_uuid(), $2, 'scheduled', 'succeeded', 1, now(), now())`,
        [seed.a.tenantId, seed.a.sourceId],
      );
      expect(ins).toMatchObject({ ok: false, code: '42501' });
      const upd = await attempt(c, `UPDATE ratio.ingest_batches SET row_count = 1`);
      expect(upd).toMatchObject({ ok: true, rowCount: 0 });
    });
  });

  it('a tenant set in a previous transaction is gone in the next one (zero rows, no error)', async () => {
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE ratio_worker');
      await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [seed.a.tenantId]);
      const inside = await c.query(`SELECT count(*)::int AS n FROM ratio.sources`);
      expect(inside.rows[0].n).toBe(1);
      await c.query('COMMIT');

      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE ratio_worker');
      const setting = await c.query(`SELECT current_setting('ratio.tenant_id', true) AS v`);
      expect([null, '']).toContain(setting.rows[0].v);
      for (const { table } of TENANT_TABLES) {
        const r = await c.query(`SELECT count(*)::int AS n FROM ratio.${table}`);
        expect(r.rows[0].n, table).toBe(0);
      }
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('a malformed tenant setting errors instead of returning rows', async () => {
    for (const bad of ['not-a-uuid', "' OR true --", seed.a.tenantId + 'x']) {
      const c = await db.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE ratio_worker');
        await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [bad]);
        const r = await attempt(c, `SELECT * FROM ratio.cost_facts`);
        expect(r, bad).toMatchObject({ ok: false, code: '22P02' });
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }
  });

  it("composite FK rejects a tenant A batch that references tenant B's source", async () => {
    const sql = `INSERT INTO ratio.ingest_batches (tenant_id, id, source_id, run_id, billing_period, artifact_set_fingerprint, status, row_count, loaded_billed_total, reconciliation, is_provisional)
                 VALUES ($1, gen_random_uuid(), $2, $3, '2026-09-01', $4, 'staged', 0, 0, 'unverified', true)`;
    const params = [seed.a.tenantId, seed.b.sourceId, seed.b.runNew, fp('cross-tenant')];
    // Even the superuser (which bypasses RLS) is stopped by the composite FK.
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      expect(await attempt(c, sql, params)).toMatchObject({ ok: false, code: '23503' });
      // Same source id but tenant A's own run: still rejected (source belongs to B).
      expect(await attempt(c, sql, [seed.a.tenantId, seed.b.sourceId, seed.a.runNew, fp('cross-tenant-2')])).toMatchObject({
        ok: false,
        code: '23503',
      });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    await withRole(db.pool, 'ratio_worker', seed.a.tenantId, async (w) => {
      expect(await attempt(w, sql, params)).toMatchObject({ ok: false, code: '23503' });
    });
  });

  it('composite FKs reject a publication or fact whose source/period disagree with its batch', async () => {
    const a = seed.a;
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      // Publication for 2026-07 pointing at an August batch.
      expect(
        await attempt(
          c,
          `INSERT INTO ratio.period_publications (tenant_id, source_id, billing_period, batch_id, published_at, published_by_run_id)
           VALUES ($1, $2, '2026-07-01', $3, now(), $4)`,
          [a.tenantId, a.sourceId, a.batchStaged, a.runNew],
        ),
      ).toMatchObject({ ok: false, code: '23503' });
      // Fact claiming period 2026-07 inside an August batch.
      expect(
        await attempt(
          c,
          `INSERT INTO ratio.cost_facts (tenant_id, batch_id, source_id, artifact_sha256, row_ordinal, billing_period, charge_period_start, charge_period_end, billed_cost, billing_currency)
           VALUES ($1, $2, $3, $4, 500, '2026-07-01', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', 1, 'USD')`,
          [a.tenantId, a.batchStaged, a.sourceId, artifactSha(a.slug, a.batchStaged)],
        ),
      ).toMatchObject({ ok: false, code: '23503' });
      // Fact referencing an artifact sha256 that is not part of its batch.
      expect(
        await attempt(
          c,
          `INSERT INTO ratio.cost_facts (tenant_id, batch_id, source_id, artifact_sha256, row_ordinal, billing_period, charge_period_start, charge_period_end, billed_cost, billing_currency)
           VALUES ($1, $2, $3, $4, 501, $5, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', 1, 'USD')`,
          [a.tenantId, a.batchStaged, a.sourceId, fp('not-in-batch'), a.period],
        ),
      ).toMatchObject({ ok: false, code: '23503' });
      // Batch whose run belongs to another source of the same tenant is impossible to express:
      // run_id must belong to (tenant, source).
      expect(
        await attempt(
          c,
          `INSERT INTO ratio.ingest_batches (tenant_id, id, source_id, run_id, billing_period, artifact_set_fingerprint, status, row_count, loaded_billed_total, reconciliation, is_provisional)
           VALUES ($1, gen_random_uuid(), $2, gen_random_uuid(), '2026-09-01', $3, 'staged', 0, 0, 'unverified', true)`,
          [a.tenantId, a.sourceId, fp('orphan-run')],
        ),
      ).toMatchObject({ ok: false, code: '23503' });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it("cost_facts_published shows only the caller tenant's currently published batch (never staged, superseded or quarantined)", async () => {
    // Staged, superseded and quarantined batches all hold fact rows in the base table.
    for (const t of [seed.a, seed.b]) {
      for (const batch of [t.batchStaged, t.batchSuperseded, t.batchQuarantined]) {
        const n = await db.pool.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE batch_id = $1`, [batch]);
        expect(n.rows[0].n).toBeGreaterThan(0);
      }
    }
    for (const t of [seed.a, seed.b]) {
      await withRole(db.pool, 'ratio_worker', t.tenantId, async (c) => {
        const r = await c.query(
          `SELECT count(*)::int AS n, sum(billed_cost)::text AS total, count(DISTINCT tenant_id)::int AS tenants,
                  array_agg(DISTINCT batch_id::text) AS batches
           FROM ratio.cost_facts_published`,
        );
        expect(r.rows[0]).toEqual({ n: t.publishedRows, total: t.publishedTotal, tenants: 1, batches: [t.batchPublished] });
      });
    }
    expect(seed.a.publishedTotal).toBe('30.30');
    expect(seed.b.publishedTotal).toBe('1000.01');
  });

  it('worker cannot write tenants/sources, update facts, run DDL, disable RLS or become owner', async () => {
    const denied: Array<[string, unknown[]]> = [
      [`INSERT INTO ratio.tenants (id, slug) VALUES (gen_random_uuid(), 'evil')`, []],
      [`UPDATE ratio.tenants SET slug = 'evil'`, []],
      [`INSERT INTO ratio.sources (tenant_id, id, source_key, kind, display_name, coverage, enabled, config)
        VALUES ($1, gen_random_uuid(), 'k', 'fake', 'x', 'on_prem', true, '{}')`, [seed.a.tenantId]],
      [`UPDATE ratio.sources SET enabled = false`, []],
      [`DELETE FROM ratio.sources`, []],
      [`UPDATE ratio.cost_facts SET billed_cost = 0`, []],
      [`UPDATE ratio.ingest_validation_errors SET message = 'x'`, []],
      [`UPDATE ratio.ingest_artifacts SET evidence_key = evidence_key`, []],
      [`ALTER VIEW ratio.cost_facts_published SET (security_invoker = true)`, []],
      [`DELETE FROM ratio.period_publications`, []],
      [`DELETE FROM ratio.sync_runs`, []],
      [`TRUNCATE ratio.cost_facts`, []],
      [`CREATE TABLE ratio.evil (x int)`, []],
      [`ALTER TABLE ratio.cost_facts DISABLE ROW LEVEL SECURITY`, []],
      [`ALTER TABLE ratio.cost_facts NO FORCE ROW LEVEL SECURITY`, []],
      [`DROP POLICY tenant_isolation ON ratio.cost_facts`, []],
      [`CREATE OR REPLACE FUNCTION ratio.current_tenant_id() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'`, []],
    ];
    await withRole(db.pool, 'ratio_worker', seed.a.tenantId, async (c) => {
      for (const [sql, params] of denied) {
        const r = await attempt(c, sql, params);
        expect(r.ok, sql).toBe(false);
        if (!r.ok) expect(r.code, `${sql} -> ${r.message}`).toBe('42501');
      }
    });
  });

  it('a real LOGIN member of ratio_worker / ratio_reader cannot become ratio_owner and is bound by RLS', async () => {
    // The other tests switch roles with SET LOCAL ROLE from the superuser test
    // connection; SET ROLE permission is checked against the *session* user, so
    // escalation must be probed from a genuine login that is only a member.
    for (const member of ['ratio_worker', 'ratio_reader'] as const) {
      const login = `ratio_test_login_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
      await db.pool.query(`CREATE ROLE ${login} LOGIN IN ROLE ${member}`);
      const url = new URL(db.url);
      url.username = login;
      const c = new Client({ connectionString: url.toString() });
      try {
        await c.connect();
        const who = await c.query(`SELECT current_user AS u, session_user AS s`);
        expect(who.rows[0]).toEqual({ u: login, s: login });
        for (const target of ['ratio_owner', member === 'ratio_reader' ? 'ratio_worker' : 'ratio_reader', 'postgres']) {
          await expect(c.query(`SET ROLE ${target}`), `${member} -> ${target}`).rejects.toMatchObject({ code: '42501' });
        }
        await c.query('BEGIN');
        await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [seed.a.tenantId]);
        const v = await c.query(`SELECT count(*)::int AS n, count(DISTINCT tenant_id)::int AS t FROM ratio.cost_facts_published`);
        expect(v.rows[0]).toEqual({ n: seed.a.publishedRows, t: 1 });
        await c.query('COMMIT');
        const none = await c.query(`SELECT count(*)::int AS n FROM ratio.cost_facts_published`);
        expect(none.rows[0].n).toBe(0);
        if (member === 'ratio_reader') {
          await expect(c.query('SELECT 1 FROM ratio.cost_facts LIMIT 1')).rejects.toMatchObject({ code: '42501' });
        }
      } finally {
        await c.end().catch(() => undefined);
        await db.pool.query(`DROP ROLE IF EXISTS ${login}`);
      }
    }
  });

  it('withTenantTransaction scopes the tenant to one transaction (integration)', async () => {
    const single = new Pool({ connectionString: db.url, max: 1 });
    try {
      const inside = await withTenantTransaction(single, seed.a.tenantId, async (c) => {
        await c.query('SET LOCAL ROLE ratio_worker');
        const s = await c.query(`SELECT current_setting('ratio.tenant_id', true) AS v`);
        const n = await c.query(`SELECT count(*)::int AS n FROM ratio.cost_facts_published`);
        return { setting: s.rows[0].v, n: n.rows[0].n };
      });
      expect(inside).toEqual({ setting: seed.a.tenantId, n: seed.a.publishedRows });
      // Same physical connection (max: 1): the setting did not survive the transaction.
      const after = await single.query(`SELECT current_setting('ratio.tenant_id', true) AS v`);
      expect([null, '']).toContain(after.rows[0].v);
      await expect(
        withTenantTransaction(single, seed.a.tenantId, async (c) => {
          await c.query('SET LOCAL ROLE ratio_worker');
          await c.query(`INSERT INTO ratio.sync_runs (tenant_id, id, source_id, run_kind, status, attempt, started_at, finished_at)
                         VALUES ($1, gen_random_uuid(), $2, 'scheduled', 'succeeded', 1, now(), now())`, [seed.a.tenantId, seed.a.sourceId]);
          throw new Error('abort after insert');
        }),
      ).rejects.toThrow('abort after insert');
      expect(await superCount('sync_runs', 'tenant_id', seed.a.tenantId)).toBe(2);
    } finally {
      await single.end();
    }
  });
});

// ratio_reader (BOUNDARY v2 / D4): SELECT on cost_facts_published ONLY.
// Read-only, own tenant only, latest published revision only; no access to
// base tables, staged/quarantined data, validation errors or evidence rows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attempt, createTestDatabase, withRole, type TestDatabase } from './testing/harness';
import { TENANT_TABLES, seedTwoTenants, type Seeded } from './testing/fixtures';

let db: TestDatabase;
let seed: Seeded;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  seed = await seedTwoTenants(db.pool);
});
afterAll(async () => {
  await db?.close();
});

const WRITE_STATEMENTS = (table: string, tenantCol: string): string[] => [
  `INSERT INTO ratio.${table} DEFAULT VALUES`,
  `UPDATE ratio.${table} SET ${tenantCol} = ${tenantCol}`,
  `DELETE FROM ratio.${table}`,
  `TRUNCATE ratio.${table}`,
];

describe('ratio_reader', () => {
  it('reader holds exactly the published-view SELECT grants (cost + outcome)', async () => {
    const rows = await db.pool.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'ratio_reader' AND table_schema = 'ratio' ORDER BY 1, 2`,
    );
    expect(rows.rows).toEqual([
      { table_name: 'cost_facts_published', privilege_type: 'SELECT' },
      { table_name: 'outcome_events_published', privilege_type: 'SELECT' },
      { table_name: 'outcome_period_counts', privilege_type: 'SELECT' },
    ]);
    for (const view of ['cost_facts_published', 'outcome_events_published', 'outcome_period_counts']) {
      const privs = await db.pool.query(
        `SELECT has_table_privilege('ratio_reader', 'ratio.${view}', 'INSERT') AS i,
                has_table_privilege('ratio_reader', 'ratio.${view}', 'UPDATE') AS u,
                has_table_privilege('ratio_reader', 'ratio.${view}', 'DELETE') AS d,
                has_table_privilege('ratio_reader', 'ratio.${view}', 'TRUNCATE') AS t`,
      );
      expect(privs.rows[0], view).toEqual({ i: false, u: false, d: false, t: false });
    }
  });

  it('reader gets permission denied on every base table, including SELECT * FROM ratio.cost_facts', async () => {
    let checked = 0;
    for (const tenant of [seed.a.tenantId, null]) {
      for (const { table, tenantCol } of TENANT_TABLES) {
        for (const sql of [`SELECT * FROM ratio.${table}`, ...WRITE_STATEMENTS(table, tenantCol)]) {
          await withRole(db.pool, 'ratio_reader', tenant, async (c) => {
            const r = await attempt(c, sql);
            expect(r.ok, sql).toBe(false);
            if (!r.ok) expect(r.code, `${sql} -> ${r.message}`).toBe('42501');
          });
          checked++;
        }
      }
    }
    expect(checked).toBe(2 * TENANT_TABLES.length * 5);
  });

  // SET ROLE escalation is probed from a real LOGIN member in tenancy.db.test.ts
  // (the superuser test session would always be allowed to SET ROLE).
  it('reader cannot write through the view or run DDL', async () => {
    await withRole(db.pool, 'ratio_reader', seed.a.tenantId, async (c) => {
      // Exact codes: the join view is not auto-updatable (55000 / 42809), and the
      // reader holds no write privilege on it either (asserted via has_table_privilege above).
      const cases: Array<[string, string]> = [
        [`INSERT INTO ratio.cost_facts_published DEFAULT VALUES`, '55000'],
        [`UPDATE ratio.cost_facts_published SET billed_cost = 0`, '55000'],
        [`DELETE FROM ratio.cost_facts_published`, '55000'],
        [`TRUNCATE ratio.cost_facts_published`, '42809'],
        ['CREATE TABLE ratio.evil (x int)', '42501'],
        ['CREATE VIEW ratio.evil_v AS SELECT 1', '42501'],
        ['ALTER VIEW ratio.cost_facts_published SET (security_invoker = true)', '42501'],
      ];
      for (const [sql, code] of cases) {
        expect(await attempt(c, sql), sql).toMatchObject({ ok: false, code });
      }
    });
    const n = await db.pool.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE tenant_id = $1`, [seed.a.tenantId]);
    expect(n.rows[0].n).toBeGreaterThan(seed.a.publishedRows);
  });

  it('reader sees only the published rows of its own tenant via the view', async () => {
    for (const t of [seed.a, seed.b]) {
      await withRole(db.pool, 'ratio_reader', t.tenantId, async (c) => {
        const v = await c.query(
          `SELECT count(*)::int AS n, sum(billed_cost)::text AS total, count(DISTINCT tenant_id)::int AS tenants,
                  array_agg(DISTINCT batch_id::text) AS batches
           FROM ratio.cost_facts_published`,
        );
        expect(v.rows[0]).toEqual({ n: t.publishedRows, total: t.publishedTotal, tenants: 1, batches: [t.batchPublished] });
        const other = seed.a === t ? seed.b : seed.a;
        const leak = await c.query(`SELECT count(*)::int AS n FROM ratio.cost_facts_published WHERE tenant_id = $1`, [other.tenantId]);
        expect(leak.rows[0].n).toBe(0);
      });
    }
  });

  it('staged, superseded and quarantined batch rows never appear in the view', async () => {
    for (const t of [seed.a, seed.b]) {
      const hidden = [t.batchStaged, t.batchSuperseded, t.batchQuarantined];
      const truth = await db.pool.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE batch_id = ANY($1::uuid[])`, [hidden]);
      expect(truth.rows[0].n).toBeGreaterThan(0);
      await withRole(db.pool, 'ratio_reader', t.tenantId, async (c) => {
        const r = await c.query(`SELECT count(*)::int AS n FROM ratio.cost_facts_published WHERE batch_id = ANY($1::uuid[])`, [hidden]);
        expect(r.rows[0].n).toBe(0);
      });
    }
  });

  it('reader sees zero rows with no tenant set, and an error (not data) with a malformed tenant', async () => {
    await withRole(db.pool, 'ratio_reader', null, async (c) => {
      const r = await c.query(`SELECT count(*)::int AS n FROM ratio.cost_facts_published`);
      expect(r.rows[0].n).toBe(0);
    });
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE ratio_reader');
      await c.query(`SELECT set_config('ratio.tenant_id', 'garbage', true)`);
      expect(await attempt(c, `SELECT * FROM ratio.cost_facts_published`)).toMatchObject({ ok: false, code: '22P02' });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('shadowing the uuid type with a temp table does not break or bypass the tenant filter (M5)', async () => {
    for (const role of ['ratio_reader', 'ratio_worker'] as const) {
      await withRole(db.pool, role, seed.a.tenantId, async (c) => {
        await c.query('CREATE TEMP TABLE uuid (x text)');
        await c.query('CREATE TEMP TABLE current_setting (x text)');
        const v = await c.query(`SELECT count(*)::int AS n, count(DISTINCT tenant_id)::int AS t FROM ratio.cost_facts_published`);
        expect(v.rows[0], role).toEqual({ n: seed.a.publishedRows, t: 1 });
        await c.query(`SET LOCAL search_path = pg_temp, public`);
        const v2 = await c.query(`SELECT count(*)::int AS n FROM ratio.cost_facts_published`);
        expect(v2.rows[0].n, role).toBe(seed.a.publishedRows);
      });
    }
    const fn = await db.pool.query(
      `SELECT p.prosqlbody IS NOT NULL AS bound_at_creation, coalesce(p.proconfig, '{}') AS config
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'ratio' AND p.proname = 'current_tenant_id'`,
    );
    expect(fn.rows).toHaveLength(1);
    const { bound_at_creation, config } = fn.rows[0] as { bound_at_creation: boolean; config: string[] };
    expect(bound_at_creation || config.some((c) => c.startsWith('search_path=pg_catalog'))).toBe(true);
  });

  it('documented trust boundary: any holder of a reader credential can select any tenant via the GUC', async () => {
    // Tenant isolation defends against application bugs (wrong/missing tenant),
    // not against someone who holds a database credential: the tenant is a
    // user-settable setting. Per-tenant DB roles would be the alternative (owner decision).
    await withRole(db.pool, 'ratio_reader', seed.a.tenantId, async (c) => {
      await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [seed.b.tenantId]);
      const v = await c.query(`SELECT count(*)::int AS n, sum(billed_cost)::text AS total FROM ratio.cost_facts_published`);
      expect(v.rows[0]).toEqual({ n: seed.b.publishedRows, total: seed.b.publishedTotal });
    });
  });
});

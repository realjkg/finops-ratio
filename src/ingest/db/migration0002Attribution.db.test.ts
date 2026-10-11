// DB-tier tests for migration 0002 (D1, spec art_qllcIvXH): the attribution
// columns land and roll back cleanly, the enriched published read path exposes
// them to the worker while the reader's pinned view and grants stay untouched,
// the registry tables are tenant-scoped, the FX policy answers read-time
// lookups, seeded shared-cost rows allocate by rule with control-total
// preservation (including the unattributed share), and
// one-published-batch-per-period still holds after the migration.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { Client, type PoolClient } from 'pg';
import { migrateDown, migrateUp } from './migrate';
import { attempt, createTestDatabase, withRole } from './testing/harness';
import { seedTenantSource, type SeededSource } from '../testing/db';
import { FOCUS_HEADER, csvGz, focusRow, type FocusRow } from '../testing/focusCsv';
import { FakeFocusSource } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { runSync } from '../worker/pipeline';
import { noSleep } from '../testing/workerSetup';
import { allocateSharedCost, nutanixDualView, type AllocationRow, type AllocationRule } from '../../attribution/allocation';

const P = '2026-08-01'; // a closed month: published rows are reconciled, not provisional
const ALLOW_DOWN = { RATIO_ALLOW_DOWN_MIGRATIONS: '1', RATIO_ENV: 'test' };

let t: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  t = await createTestDatabase({ migrate: true });
});
afterAll(async () => {
  await t.close();
});

const ATTRIBUTION_COLUMNS = ['x_RatioProjectId', 'x_RatioBusinessUnit', 'x_RatioCostCenter', 'x_RatioOwner', 'x_RatioRegion', 'x_RatioEnvironment', 'x_RatioDirectOrShared'] as const;
const ATTRIBUTION_HEADER = [...FOCUS_HEADER, ...ATTRIBUTION_COLUMNS];
const FACT_ATTRIBUTION_COLUMNS = ['accountable_owner', 'business_unit', 'cost_center', 'direct_or_shared', 'environment', 'project_id', 'region'] as const;

/** Syncs one attribution-bearing FOCUS artifact through the real pipeline. */
async function syncAttributionRows(rows: FocusRow[], period = P): Promise<SeededSource> {
  const seeded = await seedTenantSource(t.pool, { kind: 'fake', sourceKey: `focus-${crypto.randomBytes(4).toString('hex')}` });
  const source = new FakeFocusSource([{ billingPeriod: period, artifacts: [{ name: 'focus.csv.gz', bytes: csvGz(rows, ATTRIBUTION_HEADER) }] }]);
  const r = await runSync({ pool: t.pool, tenantId: seeded.tenantId, sourceKey: seeded.sourceKey, source, evidence: new MemoryEvidenceStore(), mode: 'sync', hooks: { ...noSleep } });
  expect(r.status).toBe('succeeded');
  return seeded;
}

const DIRECT_ALPHA: FocusRow = focusRow(P, {
  BilledCost: '60.00',
  EffectiveCost: '55.00',
  x_RatioProjectId: 'proj-alpha',
  x_RatioBusinessUnit: 'consumer',
  x_RatioCostCenter: 'cc-1',
  x_RatioOwner: 'a.reyes',
  x_RatioRegion: 'us-east-1',
  x_RatioEnvironment: 'prod',
  x_RatioDirectOrShared: 'direct',
});
const DIRECT_BETA: FocusRow = focusRow(P, {
  BilledCost: '25.00',
  EffectiveCost: '20.00',
  x_RatioProjectId: 'proj-beta',
  x_RatioDirectOrShared: 'direct',
  x_RatioEnvironment: 'staging',
});
const SHARED_ROW: FocusRow = focusRow(P, { BilledCost: '40.00', EffectiveCost: '40.00', x_RatioDirectOrShared: 'shared' });
const UNATTRIBUTED: FocusRow = focusRow(P, { BilledCost: '5.90', EffectiveCost: '5.90' });

interface EnrichedFact {
  billed: string;
  effective: string;
  projectId: string | null;
  directOrShared: string | null;
  environment: string | null;
}

async function readEnriched(tenantId: string): Promise<EnrichedFact[]> {
  return withRole(t.pool, 'ratio_worker', tenantId, async (c) => {
    const r = await c.query(
      `SELECT billed_cost::text, effective_cost::text, project_id, direct_or_shared, environment
       FROM ratio.cost_facts_published_enriched ORDER BY billed_cost::numeric DESC`,
    );
    return r.rows.map((x) => ({ billed: x.billed_cost, effective: x.effective_cost, projectId: x.project_id, directOrShared: x.direct_or_shared, environment: x.environment }));
  });
}

/**
 * Committing setup variant of withRole: the harness's withRole always rolls
 * back (it is an assertion helper). Registry rows must survive the block so
 * cross-tenant and FX-read assertions run against committed state.
 */
async function withRoleCommit<T>(role: 'ratio_worker' | 'ratio_owner', tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await t.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('ratio.tenant_id', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** The enriched rows as the pure allocation module consumes them (effective basis). */
function asAllocationRows(facts: EnrichedFact[], sharedTargets: string[] = []): AllocationRow[] {
  return facts.map((f, i) => ({
    rowKey: `row-${i}`,
    currency: 'USD',
    directOrShared: f.directOrShared === 'direct' ? ('direct' as const) : f.directOrShared === 'shared' ? ('shared' as const) : null,
    projectId: f.directOrShared === 'direct' ? f.projectId : null,
    amount: f.effective,
    targets: sharedTargets,
  }));
}

describe('migration 0002: catalog after up', () => {
  it('adds the seven attribution columns to cost_facts and creates the registry tables with forced RLS', async () => {
    const cols = await t.pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'ratio' AND table_name = 'cost_facts'
       AND column_name = ANY($1) ORDER BY 1`,
      [[...FACT_ATTRIBUTION_COLUMNS]],
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual([...FACT_ATTRIBUTION_COLUMNS].sort());

    const tables = await t.pool.query(
      `SELECT c.relname, c.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'ratio_owner') AS owner_ok, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'ratio' AND c.relname IN ('billing_scopes', 'fx_rates') ORDER BY 1`,
    );
    expect(tables.rows).toHaveLength(2);
    for (const row of tables.rows) {
      expect(row.owner_ok).toBe(true);
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });
});

describe('migration 0002: up/down round trip', () => {
  it('down restores the exact 0001 catalog and up reapplies', async () => {
    const db = await createTestDatabase({ migrate: false });
    try {
      const c = new Client({ connectionString: db.url });
      c.on('error', () => undefined);
      await c.connect();
      try {
        await migrateUp(c);
        expect(
          (await c.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='ratio' AND table_name='cost_facts' AND column_name='project_id'`)).rows[0].n,
        ).toBe(1);

        // Roll back to 0001 whatever newer migrations exist (later migrations sit on top of 0002).
        const applied = (await c.query(`SELECT version FROM public.schema_migrations ORDER BY version`)).rows.map((r) => r.version);
        expect(applied[0]).toBe('0001');
        expect(applied).toContain('0002');
        await migrateDown(c, { steps: applied.length - 1, env: ALLOW_DOWN });

        const afterDown = await c.query(
          `SELECT
             (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='ratio' AND table_name='cost_facts'
                AND column_name IN ('project_id','business_unit','cost_center','accountable_owner','region','environment','direct_or_shared')) AS cols,
             (SELECT count(*)::int FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
                WHERE n.nspname = 'ratio' AND cl.relname IN ('billing_scopes','fx_rates','cost_facts_published_enriched')) AS objs`,
        );
        expect(afterDown.rows[0]).toEqual({ cols: 0, objs: 0 });
        const ledger = await c.query(`SELECT version FROM public.schema_migrations ORDER BY version`);
        expect(ledger.rows.map((r) => r.version)).toEqual(['0001']);

        await migrateUp(c);
        const afterUp = await c.query(
          `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='ratio' AND table_name='cost_facts' AND column_name='project_id'`,
        );
        expect(afterUp.rows[0].n).toBe(1);
        expect((await c.query(`SELECT version FROM public.schema_migrations ORDER BY version`)).rows.map((r) => r.version)).toEqual(applied);
      } finally {
        await c.end();
      }
    } finally {
      await db.close();
    }
  });
});

describe('enriched published read path', () => {
  it('exposes attribution to the worker; the reader keeps exactly the pinned view', async () => {
    const seeded = await syncAttributionRows([DIRECT_ALPHA, DIRECT_BETA, SHARED_ROW, UNATTRIBUTED]);

    const facts = await readEnriched(seeded.tenantId);
    expect(facts).toHaveLength(4);
    expect(facts.find((f) => f.projectId === 'proj-alpha')).toMatchObject({ billed: '60.00', effective: '55.00', environment: 'prod', directOrShared: 'direct' });
    expect(facts.find((f) => f.projectId === null && f.directOrShared === null)).toMatchObject({ billed: '5.90', directOrShared: null });

    // Worker totals over the enriched path equal the published control totals.
    const totals = await withRole(t.pool, 'ratio_worker', seeded.tenantId, async (c) =>
      (await c.query(`SELECT sum(billed_cost)::text AS billed FROM ratio.cost_facts_published_enriched`)).rows[0].billed,
    );
    expect(totals).toBe('130.90');

    // The pinned 0001 view was never altered: the attribution columns do not exist on it.
    const pinned = await withRole(t.pool, 'ratio_reader', seeded.tenantId, (c) => attempt(c, `SELECT project_id FROM ratio.cost_facts_published`));
    expect(pinned).toMatchObject({ ok: false, code: '42703' });

    // And the reader has no grant on the enriched read path.
    const denied = await withRole(t.pool, 'ratio_reader', seeded.tenantId, (c) => attempt(c, `SELECT count(*) FROM ratio.cost_facts_published_enriched`));
    expect(denied).toMatchObject({ ok: false, code: '42501' });
  });
});

describe('allocation over seeded shared-cost rows', () => {
  // effective-basis slice: direct 55.00 (proj-alpha) + 20.00 (proj-beta),
  // shared 40.00, unattributed 5.90. Control total 120.90.
  let seeded: SeededSource;
  let slice: AllocationRow[];
  beforeAll(async () => {
    seeded = await syncAttributionRows([DIRECT_ALPHA, DIRECT_BETA, SHARED_ROW, UNATTRIBUTED]);
    slice = asAllocationRows(await readEnriched(seeded.tenantId));
  });

  const allocatedSum = (rule: AllocationRule): number =>
    allocateSharedCost({ currency: 'USD', rows: slice }, rule).allocations.reduce((a, x) => a + Number(x.amount), 0);

  it.each(['even_split', 'keyed_tag', 'proportional_to_attributed'] as const)('%s: allocated + unallocated == source control total', (rule) => {
    const res = allocateSharedCost({ currency: 'USD', rows: slice }, rule);
    expect(res.coverage.totalAmount).toBe('120.90');
    // direct carried through + allocated + unallocated == total
    expect(75 + allocatedSum(rule) + Number(res.unallocated)).toBe(120.9);
  });

  it('proportional_to_attributed: shared cost follows the direct weights; coverage reports the unattributed share', () => {
    const res = allocateSharedCost({ currency: 'USD', rows: slice }, 'proportional_to_attributed');
    const byProject = Object.fromEntries(res.allocations.map((a) => [a.projectId, a.amount]));
    expect(byProject).toEqual({ 'proj-alpha': '29.33', 'proj-beta': '10.67' }); // 40.00 x 55/75 and 20/75, remainder to the larger fraction
    expect(res.unallocated).toBe('5.90');
    expect(res.coverage.attributedAmount).toBe('115.00');
    expect(res.coverage.attributedPct).toBe(95.1); // floored: 115/120.9 = 95.12...
  });

  it('keyed_tag without tags and even_split without targets leave the shared row unallocated', () => {
    for (const rule of ['keyed_tag', 'even_split'] as const) {
      const res = allocateSharedCost({ currency: 'USD', rows: slice }, rule);
      expect(res.allocations).toHaveLength(0);
      expect(res.unallocated).toBe('45.90');
      expect(res.coverage.attributedAmount).toBe('75.00');
      expect(res.coverage.attributedPct).toBe(62); // floored: 75/120.9 = 62.03...
    }
  });

  it('coverage is null on an empty slice instead of inventing a percentage', () => {
    const res = allocateSharedCost({ currency: 'USD', rows: [] }, 'even_split');
    expect(res.coverage.attributedPct).toBeNull();
  });

  it('nutanix dual view: two labeled read-time derivations over the same facts', () => {
    // Same project: billed (incremental opex) vs effective + allocated shared (fully-allocated TCO).
    const view = nutanixDualView({ billedOpex: '60.00', effectiveCost: '55.00', allocatedShared: '29.33' });
    expect(view.incrementalOpex).toBe('60.00');
    expect(view.fullyAllocatedTco).toBe('84.33');
  });
});

describe('ingest validation of the attribution columns', () => {
  it('a value outside an approved enum is INVALID_VALUE, quarantines, and never leaks the cell', async () => {
    const seeded = await seedTenantSource(t.pool, { kind: 'fake', sourceKey: `focus-${crypto.randomBytes(4).toString('hex')}` });
    const source = new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'focus.csv.gz', bytes: csvGz([{ ...focusRow(P, { x_RatioEnvironment: 'production' }) }], ATTRIBUTION_HEADER) }] }]);
    const run = await runSync({ pool: t.pool, tenantId: seeded.tenantId, sourceKey: seeded.sourceKey, source, evidence: new MemoryEvidenceStore(), mode: 'sync', hooks: { ...noSleep } });
    expect(run.status).toBe('failed');
    expect(run.periods[0]).toMatchObject({ outcome: 'quarantined' });

    const errors = await t.pool.query(`SELECT column_name, code, message FROM ratio.ingest_validation_errors WHERE tenant_id = $1`, [seeded.tenantId]);
    expect(errors.rows.map((r) => [r.column_name, r.code])).toContainEqual(['x_RatioEnvironment', 'INVALID_VALUE']);
    for (const r of errors.rows) expect(r.message).not.toContain('production');
    const published = await readEnriched(seeded.tenantId);
    expect(published).toHaveLength(0);
  });
});

describe('billing_scopes and fx_rates tenancy', () => {
  it('registry rows are tenant-scoped and FK-guarded; fx lookups read the approved rate in force', async () => {
    const a = await seedTenantSource(t.pool, { kind: 'fake' });
    const b = await seedTenantSource(t.pool, { kind: 'fake' });

    await withRoleCommit('ratio_worker', a.tenantId, async (c) => {
      const scope = await attempt(c, `INSERT INTO ratio.billing_scopes (tenant_id, id, display_name, provider_name, billing_account_id, workload_account_ids)
        VALUES (ratio.current_tenant_id(), $1, 'AWS org', 'aws', '000000000001', '{wa-1,wa-2}') RETURNING id`, [crypto.randomUUID()]);
      expect(scope.ok).toBe(true);

      const fx = await attempt(c, `INSERT INTO ratio.fx_rates (tenant_id, id, currency, target_currency, effective_from, rate, source, approved_by)
        VALUES (ratio.current_tenant_id(), $1, 'USD', 'EUR', '2026-01-01', 0.9, 'approved-policy', 'cfo')`, [crypto.randomUUID()]);
      expect(fx.ok).toBe(true);
      const fx2 = await attempt(c, `INSERT INTO ratio.fx_rates (tenant_id, id, currency, target_currency, effective_from, rate, source, approved_by)
        VALUES (ratio.current_tenant_id(), $1, 'USD', 'EUR', '2026-03-01', 0.85, 'approved-policy', 'cfo')`, [crypto.randomUUID()]);
      expect(fx2.ok).toBe(true);

      // One approved rate per (pair, effective date): a second approval for the same date forks, so it is refused.
      const dup = await attempt(c, `INSERT INTO ratio.fx_rates (tenant_id, id, currency, target_currency, effective_from, rate, source, approved_by)
        VALUES (ratio.current_tenant_id(), $1, 'USD', 'EUR', '2026-03-01', 0.8, 'approved-policy', 'cfo')`, [crypto.randomUUID()]);
      expect(dup).toMatchObject({ ok: false, code: '23505' });

      // Constrained enums at the DB tier: the CHECK constraints are the backstop.
      const badRate = await attempt(c, `INSERT INTO ratio.fx_rates (tenant_id, id, currency, target_currency, effective_from, rate, source, approved_by)
        VALUES (ratio.current_tenant_id(), $1, 'USD', 'EUR', '2026-04-01', 0, 'approved-policy', 'cfo')`, [crypto.randomUUID()]);
      expect(badRate).toMatchObject({ ok: false, code: '23514' });
    });

    // Cross-tenant reads see nothing (forced RLS, not a filtered query).
    const crossScope = await withRole(t.pool, 'ratio_worker', b.tenantId, (c) => attempt(c, `SELECT count(*)::int AS n FROM ratio.billing_scopes`));
    expect(crossScope).toMatchObject({ ok: true, rows: [{ n: 0 }] });
    const crossFx = await withRole(t.pool, 'ratio_worker', b.tenantId, (c) => attempt(c, `SELECT count(*)::int AS n FROM ratio.fx_rates`));
    expect(crossFx).toMatchObject({ ok: true, rows: [{ n: 0 }] });

    // Read-time FX policy: the rate in force on the read date, never a converted stored measure.
    const rateOn = async (date: string): Promise<string> =>
      withRole(t.pool, 'ratio_worker', a.tenantId, async (c) =>
        (await c.query(
          `SELECT rate::text FROM ratio.fx_rates WHERE tenant_id = ratio.current_tenant_id() AND currency = 'USD' AND target_currency = 'EUR'
           AND effective_from <= $1::date ORDER BY effective_from DESC LIMIT 1`,
          [date],
        )).rows[0].rate,
      );
    expect(await rateOn('2026-02-15')).toBe('0.9');
    expect(await rateOn('2026-03-15')).toBe('0.85');
  });
});

describe('one-published-batch-per-period after 0002', () => {
  it('a second publication supersedes the first; the enriched path reflects exactly one batch', async () => {
    const seeded = await syncAttributionRows([DIRECT_ALPHA, DIRECT_BETA, SHARED_ROW, UNATTRIBUTED]);
    expect(await readEnriched(seeded.tenantId)).toHaveLength(4);

    // Second sync of the same period with different rows.
    const source = new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'focus.csv.gz', bytes: csvGz([DIRECT_ALPHA], ATTRIBUTION_HEADER) }] }]);
    const r = await runSync({ pool: t.pool, tenantId: seeded.tenantId, sourceKey: seeded.sourceKey, source, evidence: new MemoryEvidenceStore(), mode: 'sync', hooks: { ...noSleep } });
    expect(r.status).toBe('succeeded');

    const after = await readEnriched(seeded.tenantId);
    expect(after).toHaveLength(1);

    const pubs = await t.pool.query(`SELECT count(*)::int AS n FROM ratio.period_publications WHERE tenant_id = $1 AND billing_period = $2::date`, [seeded.tenantId, P]);
    expect(pubs.rows[0].n).toBe(1);
    const statuses = await t.pool.query(
      `SELECT status, count(*)::int AS n FROM ratio.ingest_batches WHERE tenant_id = $1 GROUP BY status ORDER BY status`,
      [seeded.tenantId],
    );
    const byStatus = Object.fromEntries(statuses.rows.map((r) => [r.status, r.n]));
    expect(byStatus['published']).toBe(1);
    expect(byStatus['superseded']).toBe(1);
  });
});

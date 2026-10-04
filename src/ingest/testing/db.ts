// Test-only database helpers for Slice 1: real LOGIN roles, tenant/source
// seeding (as the test superuser) and whole-tenant snapshots for
// "nothing changed" assertions.
import crypto from 'crypto';
import type { Pool } from 'pg';
import { Client } from 'pg';
import type { TestDatabase } from '../db/testing/harness';

export interface Login {
  name: string;
  url: string;
  drop(): Promise<void>;
}

/**
 * Creates a cluster-global LOGIN role (trust auth locally) that is a member of
 * `memberOf`, with extra role attributes. Dropped by `drop()`.
 */
export async function createLogin(
  db: TestDatabase,
  memberOf: Array<'ratio_worker' | 'ratio_reader' | 'ratio_owner'>,
  attrs: string[] = [],
): Promise<Login> {
  const name = `ratio_test_login_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const inRole = memberOf.length ? ` IN ROLE ${memberOf.join(', ')}` : '';
  await db.pool.query(`CREATE ROLE ${name} LOGIN ${attrs.join(' ')}${inRole}`);
  const u = new URL(db.url);
  u.username = name;
  u.password = '';
  let dropped = false;
  return {
    name,
    url: u.toString(),
    async drop() {
      if (dropped) return;
      dropped = true;
      // Terminate any session the login still has, then drop it.
      await db.pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [name]);
      await db.pool.query(`DROP ROLE IF EXISTS ${name}`);
    },
  };
}

export interface SeededSource {
  tenantId: string;
  sourceId: string;
  sourceKey: string;
}

export async function seedTenantSource(
  pool: Pool,
  opts: {
    tenantId?: string;
    slug?: string;
    sourceKey?: string;
    kind?: 'focus_file' | 'fake';
    config?: Record<string, unknown>;
    enabled?: boolean;
    sourceId?: string;
  } = {},
): Promise<SeededSource> {
  const tenantId = opts.tenantId ?? crypto.randomUUID();
  const sourceId = opts.sourceId ?? crypto.randomUUID();
  const slug = opts.slug ?? `t-${tenantId.slice(0, 8)}`;
  const sourceKey = opts.sourceKey ?? 'focus-main';
  await pool.query(`INSERT INTO ratio.tenants (id, slug) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [tenantId, slug]);
  await pool.query(
    `INSERT INTO ratio.sources (tenant_id, id, source_key, kind, display_name, coverage, declared_focus_version, enabled, config)
     VALUES ($1, $2, $3, $4, 'Synthetic source', 'public_cloud', '1.0', $5, $6)`,
    [tenantId, sourceId, sourceKey, opts.kind ?? 'focus_file', opts.enabled ?? true, JSON.stringify(opts.config ?? {})],
  );
  return { tenantId, sourceId, sourceKey };
}

const SNAPSHOT_TABLES: Array<[string, string]> = [
  ['tenants', 'id'],
  ['sources', 'tenant_id'],
  ['sync_runs', 'tenant_id'],
  ['ingest_batches', 'tenant_id'],
  ['ingest_artifacts', 'tenant_id'],
  ['ingest_validation_errors', 'tenant_id'],
  ['cost_facts', 'tenant_id'],
  ['period_publications', 'tenant_id'],
  ['source_checkpoints', 'tenant_id'],
];

/** Every row of every ratio table for the tenant, as sorted JSON text (superuser pool). */
export async function snapshotTenant(pool: Pool, tenantId: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [table, col] of SNAPSHOT_TABLES) {
    const r = await pool.query(`SELECT to_jsonb(t)::text AS j FROM ratio.${table} t WHERE ${col} = $1 ORDER BY 1`, [tenantId]);
    out[table] = r.rows.map((x) => x.j as string);
  }
  return out;
}

/** The published view as a given role/tenant would see it (superuser session + SET LOCAL ROLE). */
export async function publishedAs(
  pool: Pool,
  role: 'ratio_reader' | 'ratio_worker',
  tenantId: string | null,
): Promise<{ rows: number; total: string | null; batches: string[] }> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    if (tenantId) await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [tenantId]);
    const r = await c.query(
      `SELECT count(*)::int AS n, sum(billed_cost)::text AS total, coalesce(array_agg(DISTINCT batch_id::text), '{}') AS batches
       FROM ratio.cost_facts_published`,
    );
    return { rows: r.rows[0].n, total: r.rows[0].total, batches: (r.rows[0].batches as string[]).sort() };
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** Ground truth (superuser) published totals per period for a source. */
export async function publishedTotals(pool: Pool, tenantId: string, sourceId: string): Promise<Record<string, { rows: number; total: string }>> {
  const r = await pool.query(
    `SELECT pp.billing_period::text AS p, count(cf.*)::int AS n, coalesce(sum(cf.billed_cost), 0)::text AS total
     FROM ratio.period_publications pp
     LEFT JOIN ratio.cost_facts cf ON cf.tenant_id = pp.tenant_id AND cf.batch_id = pp.batch_id
     WHERE pp.tenant_id = $1 AND pp.source_id = $2
     GROUP BY 1 ORDER BY 1`,
    [tenantId, sourceId],
  );
  return Object.fromEntries(r.rows.map((x) => [x.p, { rows: x.n, total: x.total }]));
}

export async function batchesOf(pool: Pool, tenantId: string, sourceId: string) {
  const r = await pool.query(
    `SELECT id, billing_period::text AS period, status, reconciliation, row_count::text AS row_count,
            loaded_billed_total::text AS loaded, control_row_count::text AS control_rows,
            control_billed_total::text AS control_total, is_provisional, quarantine_reason,
            validation_error_count::text AS error_count, artifact_set_fingerprint AS fingerprint, run_id
     FROM ratio.ingest_batches WHERE tenant_id = $1 AND source_id = $2 ORDER BY created_at, id`,
    [tenantId, sourceId],
  );
  return r.rows as Array<{
    id: string;
    period: string;
    status: string;
    reconciliation: string;
    row_count: string;
    loaded: string;
    control_rows: string | null;
    control_total: string | null;
    is_provisional: boolean;
    quarantine_reason: string | null;
    error_count: string;
    fingerprint: string;
    run_id: string;
  }>;
}

export async function runsOf(pool: Pool, tenantId: string, sourceId: string) {
  const r = await pool.query(
    `SELECT id, run_kind, status, attempt, error_code, error_detail, stats, lease_token, period_from::text AS period_from, period_to::text AS period_to
     FROM ratio.sync_runs WHERE tenant_id = $1 AND source_id = $2 ORDER BY started_at, id`,
    [tenantId, sourceId],
  );
  return r.rows as Array<{
    id: string;
    run_kind: string;
    status: string;
    attempt: number;
    error_code: string | null;
    error_detail: string | null;
    stats: Record<string, unknown>;
    lease_token: string | null;
    period_from: string | null;
    period_to: string | null;
  }>;
}

export async function checkpointOf(pool: Pool, tenantId: string, sourceId: string): Promise<Record<string, unknown> | null> {
  const r = await pool.query(`SELECT periods FROM ratio.source_checkpoints WHERE tenant_id = $1 AND source_id = $2`, [tenantId, sourceId]);
  return r.rows[0]?.periods ?? null;
}

/** Forces every running run of the source to have an expired lease (simulates time passing). */
export async function expireLeases(pool: Pool, tenantId: string, sourceId: string): Promise<number> {
  const r = await pool.query(
    `UPDATE ratio.sync_runs SET lease_expires_at = clock_timestamp() - interval '1 second'
     WHERE tenant_id = $1 AND source_id = $2 AND status = 'running'`,
    [tenantId, sourceId],
  );
  return r.rowCount ?? 0;
}

/** Multiset of published facts (content columns only, no batch ids) — for "identical to a clean run". */
export async function publishedFactMultiset(pool: Pool, tenantId: string, sourceId: string): Promise<string[]> {
  const r = await pool.query(
    `SELECT jsonb_build_array(cf.billing_period, cf.artifact_sha256, cf.row_ordinal, cf.charge_period_start, cf.charge_period_end,
              cf.billed_cost::text, cf.effective_cost::text, cf.list_cost::text, cf.contracted_cost::text, cf.billing_currency,
              cf.provider_name, cf.service_name, cf.resource_id, cf.usage_quantity::text, cf.extra_columns)::text AS j
     FROM ratio.cost_facts cf
     JOIN ratio.period_publications pp ON pp.tenant_id = cf.tenant_id AND pp.batch_id = cf.batch_id
     WHERE cf.tenant_id = $1 AND cf.source_id = $2 ORDER BY 1`,
    [tenantId, sourceId],
  );
  return r.rows.map((x) => x.j as string);
}

/** Opens a plain client on a URL (e.g. a test login). */
export async function connect(url: string): Promise<Client> {
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

// Synthetic, deterministic fixtures for the DB test suite. Nothing here is real
// provider data: UUIDs are hand-made, amounts are invented round numbers, and
// fingerprints are sha256 of fixed labels. Seeded as the test superuser (which
// bypasses RLS) so tests can then probe what the restricted roles can see.
import crypto from 'crypto';
import type { Pool } from 'pg';

export const fp = (label: string): string => crypto.createHash('sha256').update(label).digest('hex');

export interface TenantFixture {
  tenantId: string;
  slug: string;
  sourceId: string;
  runOld: string;
  runNew: string;
  batchSuperseded: string;
  batchPublished: string;
  batchStaged: string;
  batchQuarantined: string;
  /** approved outcome-unit registration row (0004) seeded for this tenant */
  outcomeRegistryId: string;
  /** measured-financial benefit evidence row (0004) seeded for this tenant */
  outcomeBenefitId: string;
  /** supplemental cost row (0004) seeded for this tenant */
  outcomeSupplementalId: string;
  period: string;
  /** sum of billed_cost of the published batch, as Postgres numeric text */
  publishedTotal: string;
  publishedRows: number;
}

function ids(prefix: string, slug: string, publishedCosts: string[], otherCost: string): TenantFixture & { costs: { published: string[]; other: string } } {
  const u = (n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    tenantId: u(1),
    slug,
    sourceId: u(2),
    runOld: u(3),
    runNew: u(4),
    batchSuperseded: u(5),
    batchPublished: u(6),
    batchStaged: u(7),
    batchQuarantined: u(8),
    outcomeRegistryId: u(9),
    outcomeBenefitId: u(10),
    outcomeSupplementalId: u(11),
    period: '2026-08-01',
    publishedTotal: '',
    publishedRows: publishedCosts.length,
    costs: { published: publishedCosts, other: otherCost },
  };
}

/** sha256-shaped fingerprint of a synthetic artifact (not real bytes). */
export const artifactSha = (slug: string, batchId: string): string => fp(`${slug}:${batchId}:part-0`);

/** Content-addressed evidence object key (D6): evidence/<tenant>/<source>/<sha256>. Bucket comes from env, never stored. */
export const evidenceKey = (tenantId: string, sourceId: string, sha256: string): string =>
  `evidence/${tenantId}/${sourceId}/${sha256}`;

export const TENANT_A_PREFIX = 'aaaaaaaa';
export const TENANT_B_PREFIX = 'bbbbbbbb';

export interface Seeded {
  a: TenantFixture;
  b: TenantFixture;
}

/** Tables in schema ratio that carry tenant rows, with the column holding the tenant. */
export const TENANT_TABLES: Array<{ table: string; tenantCol: string }> = [
  { table: 'tenants', tenantCol: 'id' },
  { table: 'sources', tenantCol: 'tenant_id' },
  { table: 'sync_runs', tenantCol: 'tenant_id' },
  { table: 'ingest_batches', tenantCol: 'tenant_id' },
  { table: 'ingest_artifacts', tenantCol: 'tenant_id' },
  { table: 'ingest_validation_errors', tenantCol: 'tenant_id' },
  { table: 'cost_facts', tenantCol: 'tenant_id' },
  { table: 'period_publications', tenantCol: 'tenant_id' },
  { table: 'source_checkpoints', tenantCol: 'tenant_id' },
  // 0004_outcome_ledger: the durable outcome accounting tables.
  { table: 'outcome_unit_registrations', tenantCol: 'tenant_id' },
  { table: 'outcome_events', tenantCol: 'tenant_id' },
  { table: 'outcome_benefit_evidence', tenantCol: 'tenant_id' },
  { table: 'outcome_supplemental_costs', tenantCol: 'tenant_id' },
];

async function seedOne(pool: Pool, t: ReturnType<typeof ids>): Promise<TenantFixture> {
  // One transaction: batches are created `staged`, filled, then moved through
  // the allowed lifecycle (staged -> published -> superseded, staged ->
  // quarantined). The publication pointer must agree with the published batch
  // by COMMIT (deferred consistency check), so everything commits together.
  const client = await pool.connect();
  const q = (sql: string, params: unknown[]) => client.query(sql, params);
  try {
    await client.query('BEGIN');
    await q(`INSERT INTO ratio.tenants (id, slug) VALUES ($1, $2)`, [t.tenantId, t.slug]);
    await q(
      `INSERT INTO ratio.sources (tenant_id, id, source_key, kind, display_name, coverage, declared_focus_version, enabled, config)
       VALUES ($1, $2, 'focus-main', 'focus_file', 'Synthetic FOCUS export', 'public_cloud', '1.0', true, '{"root":"synthetic"}')`,
      [t.tenantId, t.sourceId],
    );
    for (const run of [t.runOld, t.runNew]) {
      await q(
        `INSERT INTO ratio.sync_runs (tenant_id, id, source_id, run_kind, status, attempt, started_at, finished_at, stats)
         VALUES ($1, $2, $3, 'scheduled', 'succeeded', 1, now() - interval '1 hour', now(), '{}')`,
        [t.tenantId, run, t.sourceId],
      );
    }
    const batches: Array<{ id: string; run: string; costs: string[]; quarantined?: boolean }> = [
      { id: t.batchSuperseded, run: t.runOld, costs: [t.costs.other] },
      { id: t.batchPublished, run: t.runNew, costs: t.costs.published },
      { id: t.batchStaged, run: t.runNew, costs: [t.costs.other, t.costs.other] },
      { id: t.batchQuarantined, run: t.runNew, costs: [t.costs.other, t.costs.other, t.costs.other], quarantined: true },
    ];
    for (const b of batches) {
      const sha = artifactSha(t.slug, b.id);
      await q(
        `INSERT INTO ratio.ingest_batches
           (tenant_id, id, source_id, run_id, billing_period, artifact_set_fingerprint, status, row_count,
            control_row_count, loaded_billed_total, reconciliation, is_provisional)
         VALUES ($1, $2, $3, $4, $5, $6, 'staged', $7, $8, 0, 'unverified', false)`,
        [t.tenantId, b.id, t.sourceId, b.run, t.period, fp(`${t.slug}:${b.id}:set`), b.costs.length, b.quarantined ? b.costs.length + 1 : null],
      );
      await q(
        `INSERT INTO ratio.ingest_artifacts (tenant_id, source_id, batch_id, artifact_name, sha256, byte_size, row_count, evidence_key)
         VALUES ($1, $2, $3, 'part-0.csv.gz', $4, 1024, $5, $6)`,
        [t.tenantId, t.sourceId, b.id, sha, b.costs.length, evidenceKey(t.tenantId, t.sourceId, sha)],
      );
      for (const [i, cost] of b.costs.entries()) {
        await q(
          `INSERT INTO ratio.cost_facts
             (tenant_id, batch_id, source_id, artifact_sha256, row_ordinal, billing_period,
              charge_period_start, charge_period_end, billed_cost, effective_cost, billing_currency,
              provider_name, service_name, focus_version, extra_columns)
           VALUES ($1, $2, $3, $4, $5, $6, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', $7, $7, 'USD',
                   'SyntheticCloud', 'Synthetic Compute', '1.0', '{}')`,
          [t.tenantId, b.id, t.sourceId, sha, i, t.period, cost],
        );
      }
      await q(`UPDATE ratio.ingest_batches SET loaded_billed_total = (SELECT sum(billed_cost) FROM ratio.cost_facts WHERE tenant_id = $1 AND batch_id = $2) WHERE tenant_id = $1 AND id = $2`, [
        t.tenantId,
        b.id,
      ]);
      if (b.quarantined) {
        for (const n of [1, 2]) {
          await q(
            `INSERT INTO ratio.ingest_validation_errors (tenant_id, batch_id, error_ordinal, artifact_sha256, row_ordinal, column_name, code, message)
             VALUES ($1, $2, $3, $4, $5, 'BilledCost', 'UNPARSEABLE_NUMBER', 'BilledCost is not a decimal number')`,
            [t.tenantId, b.id, n, sha, n],
          );
        }
        await q(
          `UPDATE ratio.ingest_batches SET status = 'quarantined', reconciliation = 'variance',
                  quarantine_reason = 'CONTROL_ROW_COUNT_MISMATCH', validation_error_count = 1500
           WHERE tenant_id = $1 AND id = $2`,
          [t.tenantId, b.id],
        );
      }
    }
    // Outcome ledger rows (0004): one approved registration (inserted pending,
    // then approved by a different identity — the lifecycle trigger refuses a
    // directly-approved insert), two classified events on the published batch
    // (which is still staged at write time — the batch-child guard requires
    // it), one measured-financial benefit claim and one supplemental cost, all
    // claims unverified (a claim starts unverified; verification is a
    // separate reviewer's act).
    const publishedSha = artifactSha(t.slug, t.batchPublished);
    await q(
      `INSERT INTO ratio.outcome_unit_registrations
         (tenant_id, id, project_id, use_case_pattern, outcome_unit_key, outcome_unit_label,
          metric, unit, direction, target, baseline, observation,
          quality_metric, quality_direction, quality_threshold,
          stop_below, continue_at, expand_at, status, requested_by)
       VALUES ($1, $2, 'fixture-support-copilot', 'support_assistant', 'resolved_ticket', 'Resolved tickets',
               'resolution_quality', 'quality_result', 'higher', 15, $3, $4,
               'resolution_quality', 'higher', 0.9,
               2, 3, 5, 'pending', 'fixture-bot')`,
      [
        t.tenantId,
        t.outcomeRegistryId,
        JSON.stringify({ start: '2026-07-01', end: '2026-07-31', value: 12.5 }),
        JSON.stringify({ start: '2026-08-01', end: '2026-08-31', value: 15 }),
      ],
    );
    await q(
      `UPDATE ratio.outcome_unit_registrations SET status = 'approved', approved_by = 'fixture-reviewer', approved_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [t.tenantId, t.outcomeRegistryId],
    );
    for (const [i, ev] of [
      { trace: `${t.slug}-trace-1`, status: 'successful', quality: 0.97, latency: 1200 },
      { trace: `${t.slug}-trace-2`, status: 'failed', quality: 0.55, latency: 800 },
    ].entries()) {
      await q(
        `INSERT INTO ratio.outcome_events
           (tenant_id, source_id, batch_id, artifact_sha256, row_ordinal, billing_period, project_id,
            registry_id, trace_id, agent_run_id, request_id, outcome_type, outcome_status,
            quality_result, completion_latency, validated_benefit, benefit_validation_status,
            currency, allocation_method, data_as_of, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'fixture-support-copilot', $7, $8, $8, $8 || '-r',
                 'resolved_ticket', $9, $10, $11, NULL, 'unvalidated', 'USD', 'direct',
                 '2026-08-05T12:00:00Z', '2026-08-05T12:00:00Z')`,
        [t.tenantId, t.sourceId, t.batchPublished, publishedSha, i, t.period, t.outcomeRegistryId, ev.trace, ev.status, ev.quality, ev.latency],
      );
    }
    await q(
      `INSERT INTO ratio.outcome_benefit_evidence
         (tenant_id, id, project_id, billing_period, benefit_kind, category, title,
          amount, currency, unit_label, unit_amount, attribution_pct, method, reference,
          recorded_by, allocation_method, data_as_of)
       VALUES ($1, $2, 'fixture-support-copilot', $3, 'measured_financial', 'cost_savings',
               'Verified refund avoidance (fixture)', 500, 'USD', NULL, NULL, 100,
               'invoice diff', 'fixture://refund-avoidance/2026-08', 'fixture-bot', 'direct', '2026-08-31T00:00:00Z')`,
      [t.tenantId, t.outcomeBenefitId, t.period],
    );
    await q(
      `INSERT INTO ratio.outcome_supplemental_costs
         (tenant_id, id, project_id, billing_period, category, amount, currency, evidence_status,
          reference, recorded_by, allocation_method, data_as_of)
       VALUES ($1, $2, 'fixture-support-copilot', $3, 'labor', 250, 'USD', 'measured',
               'fixture://timesheet/2026-08', 'fixture-bot', 'direct', '2026-08-31T00:00:00Z')`,
      [t.tenantId, t.outcomeSupplementalId, t.period],
    );
    // Lifecycle: publish the old batch, then supersede it with the new one.
    await q(`UPDATE ratio.ingest_batches SET status = 'published', published_at = now() - interval '1 day' WHERE tenant_id = $1 AND id = $2`, [
      t.tenantId,
      t.batchSuperseded,
    ]);
    await q(
      `INSERT INTO ratio.period_publications (tenant_id, source_id, billing_period, batch_id, published_at, published_by_run_id)
       VALUES ($1, $2, $3, $4, now() - interval '1 day', $5)`,
      [t.tenantId, t.sourceId, t.period, t.batchSuperseded, t.runOld],
    );
    await q(`UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE tenant_id = $1 AND id = $2`, [
      t.tenantId,
      t.batchSuperseded,
    ]);
    await q(`UPDATE ratio.ingest_batches SET status = 'published', published_at = now() WHERE tenant_id = $1 AND id = $2`, [
      t.tenantId,
      t.batchPublished,
    ]);
    await q(
      `UPDATE ratio.period_publications SET batch_id = $4, published_at = now(), published_by_run_id = $5
       WHERE tenant_id = $1 AND source_id = $2 AND billing_period = $3`,
      [t.tenantId, t.sourceId, t.period, t.batchPublished, t.runNew],
    );
    await q(
      `INSERT INTO ratio.source_checkpoints (tenant_id, source_id, last_run_id, periods, updated_at)
       VALUES ($1, $2, $3, $4, now())`,
      [t.tenantId, t.sourceId, t.runNew, JSON.stringify({ [t.period]: fp(`${t.slug}:${t.batchPublished}:set`) })],
    );
    const total = await q(`SELECT sum(billed_cost)::text AS s FROM ratio.cost_facts WHERE tenant_id = $1 AND batch_id = $2`, [
      t.tenantId,
      t.batchPublished,
    ]);
    // A swallowed error aborts the transaction and COMMIT then answers ROLLBACK
    // (round 16 L2): never hand tests a fixture whose rows were not written.
    const commit = await client.query('COMMIT');
    if (commit.command !== 'COMMIT') {
      throw Object.assign(new Error(`seed transaction was rolled back (COMMIT answered ${commit.command ?? 'nothing'})`), {
        code: 'TRANSACTION_ROLLED_BACK',
      });
    }
    const fixture: TenantFixture & { costs?: unknown } = { ...t, publishedTotal: total.rows[0].s };
    delete fixture.costs;
    return fixture;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Seeds two tenants, each with a published, a superseded, a staged and a quarantined batch (all with fact rows). */
export async function seedTwoTenants(pool: Pool): Promise<Seeded> {
  const a = await seedOne(pool, ids(TENANT_A_PREFIX, 'tenant-a', ['10.10', '20.20'], '99.99'));
  const b = await seedOne(pool, ids(TENANT_B_PREFIX, 'tenant-b', ['1000.01'], '5555.55'));
  return { a, b };
}

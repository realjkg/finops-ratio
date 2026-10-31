// Report facts (1.0): reads the aggregates a report is built from, for ONE
// billing period of the tenant, through the same published-facts view, login
// check, tenant transaction and pinned session as GET /api/v1/costs/published.
// Three statements in one REPEATABLE READ snapshot; every sum and count is
// computed by Postgres as numeric/bigint text (exact, never a JS number), every
// timestamp formatted explicitly. Assembly is pure: src/reports/reportFacts.ts.
//
// What the reader role can NOT see (ratio_reader is granted this view only):
// source keys, import metadata, batch status, reconciliation, control totals,
// and staged, quarantined or superseded batches. Those stay N/A with a reason
// until the batch-status view (R4, migration 0005) exists.
import type { Pool } from 'pg';
import { withTenantTransaction } from '@/ingest/db/tenant';
import { beginReaderRead } from './publishedCosts';
import type { FactsAggregateGroup, FactsArtifactRow, FactsBatchRow } from '@/reports/reportFacts';

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

const GROUPS_SQL = `
  SELECT v.source_id::pg_catalog.text AS "sourceId",
         v.billing_currency AS "currency",
         v.charge_category AS "chargeCategory",
         (GROUPING(v.charge_category) = 1) AS "isTotal",
         pg_catalog.count(*)::pg_catalog.text AS "rowCount",
         pg_catalog.sum(v.billed_cost)::pg_catalog.text AS "billedCost",
         pg_catalog.sum(v.effective_cost)::pg_catalog.text AS "effectiveCost",
         pg_catalog.count(*) FILTER (WHERE v.effective_cost IS NULL)::pg_catalog.text AS "effectiveMissingRows"
    FROM ratio.cost_facts_published v
   WHERE v.billing_period = $1::pg_catalog.date
   GROUP BY GROUPING SETS ((v.source_id, v.billing_currency), (v.source_id, v.billing_currency, v.charge_category))
   ORDER BY 1, 2, 4 DESC, 3 NULLS LAST`;

const BATCHES_SQL = `
  SELECT v.source_id::pg_catalog.text AS "sourceId",
         v.batch_id::pg_catalog.text AS "batchId",
         pg_catalog.count(*)::pg_catalog.text AS "rowCount",
         pg_catalog.to_char(pg_catalog.max(v.published_at) AT TIME ZONE 'UTC', ${ISO}) AS "publishedAt",
         pg_catalog.to_char(pg_catalog.min(v.charge_period_start) AT TIME ZONE 'UTC', ${ISO}) AS "chargePeriodStart",
         pg_catalog.to_char(pg_catalog.max(v.charge_period_end) AT TIME ZONE 'UTC', ${ISO}) AS "chargePeriodEnd",
         pg_catalog.array_remove(pg_catalog.array_agg(DISTINCT v.provider_name ORDER BY v.provider_name), NULL) AS "providers",
         pg_catalog.array_remove(pg_catalog.array_agg(DISTINCT v.focus_version ORDER BY v.focus_version), NULL) AS "focusVersions"
    FROM ratio.cost_facts_published v
   WHERE v.billing_period = $1::pg_catalog.date
   GROUP BY v.source_id, v.batch_id
   ORDER BY 1, 2`;

const ARTIFACTS_SQL = `
  SELECT v.source_id::pg_catalog.text AS "sourceId",
         v.batch_id::pg_catalog.text AS "batchId",
         v.artifact_sha256 AS "artifactSha256",
         pg_catalog.count(*)::pg_catalog.text AS "rowCount"
    FROM ratio.cost_facts_published v
   WHERE v.billing_period = $1::pg_catalog.date
   GROUP BY v.source_id, v.batch_id, v.artifact_sha256
   ORDER BY 1, 2, 3`;

export const REPORT_FACTS_SQL = Object.freeze({ groups: GROUPS_SQL, batches: BATCHES_SQL, artifacts: ARTIFACTS_SQL });

export interface ReportFactsAggregates {
  groups: FactsAggregateGroup[];
  batches: FactsBatchRow[];
  artifacts: FactsArtifactRow[];
}

/** `period` is a validated 'YYYY-MM-01' (bound parameter). */
export async function readReportFactsAggregates(pool: Pick<Pool, 'connect'>, tenantId: string, period: string): Promise<ReportFactsAggregates> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    await beginReaderRead(client, 'report-facts');
    const groups = await client.query<FactsAggregateGroup>(GROUPS_SQL, [period]);
    const batches = await client.query<FactsBatchRow>(BATCHES_SQL, [period]);
    const artifacts = await client.query<FactsArtifactRow>(ARTIFACTS_SQL, [period]);
    return { groups: groups.rows, batches: batches.rows, artifacts: artifacts.rows };
  });
}

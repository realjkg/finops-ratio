// Reads ONE page of the tenant's published cost facts, through Slice 0's
// definer-rights view ratio.cost_facts_published (latest accepted revision per
// source and billing period; never staged, quarantined or superseded rows).
//
// One read-only transaction per request, tenant set by Slice 0's
// withTenantTransaction (transaction-local, bound parameter, uuid-validated):
//   1. the reader-login check on THIS connection (refuses before any read);
//   2. the page (keyset, limit + 1 rows to know whether more exist);
//   3. on the first page only, totals per period and currency.
// Money, quantities and counts are produced as text by Postgres: never a JS
// number (rowCount is a bigint count, so it is a decimal string too). Every
// value is a bound parameter.
//
// No returned or cursor-encoded value may depend on a session setting
// (Copilot 4176238982): dates and timestamps are formatted explicitly with
// to_char (date::text follows DateStyle, and a cursor built from it would not
// decode); numeric, bigint and uuid text output is setting-independent; there
// are no float, interval or money-typed columns (extra_float_digits,
// IntervalStyle and lc_monetary cannot apply); extra_columns is jsonb whose
// values the worker writes as strings. As a second layer the reader pool pins
// DateStyle, IntervalStyle and TimeZone and the read asserts them, failing
// closed.
import type { Pool } from 'pg';
import { withTenantTransaction } from '@/ingest/db/tenant';
import { assertSafeReaderLogin } from './readerLogin';
import { encodeCursor, type PublishedCostsQuery } from './query';

export interface PublishedCostRow {
  billingPeriod: string;
  sourceId: string;
  batchId: string;
  artifactSha256: string;
  rowOrdinal: string;
  chargePeriodStart: string;
  chargePeriodEnd: string;
  billedCost: string;
  effectiveCost: string | null;
  listCost: string | null;
  contractedCost: string | null;
  billingCurrency: string;
  providerName: string | null;
  serviceName: string | null;
  serviceCategory: string | null;
  chargeCategory: string | null;
  resourceId: string | null;
  subAccountId: string | null;
  billingAccountId: string | null;
  usageQuantity: string | null;
  usageUnit: string | null;
  pricingQuantity: string | null;
  pricingUnit: string | null;
  focusVersion: string | null;
  extraColumns: Record<string, unknown>;
  publishedAt: string;
}

export interface PublishedCostsTotal {
  billingPeriod: string;
  billingCurrency: string;
  /** bigint count as a decimal string (exact beyond 2^53), like the money amounts. */
  rowCount: string;
  billedCost: string;
}

export interface PublishedCostsPage {
  data: PublishedCostRow[];
  page: { limit: number; nextCursor: string | null };
  /** Totals over the whole filter; only on the first page (no cursor), else null. */
  totals: PublishedCostsTotal[] | null;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const DAY = `'YYYY-MM-DD'`;

// $1 from (date|null), $2 to (date|null) — shared by both statements.
const PERIOD_FILTER = `($1::pg_catalog.date IS NULL OR v.billing_period >= $1::pg_catalog.date)
       AND ($2::pg_catalog.date IS NULL OR v.billing_period <= $2::pg_catalog.date)`;

const PAGE_SQL = `
  SELECT pg_catalog.to_char(v.billing_period, ${DAY}) AS "billingPeriod",
         v.source_id::pg_catalog.text AS "sourceId",
         v.batch_id::pg_catalog.text AS "batchId",
         v.artifact_sha256 AS "artifactSha256",
         v.row_ordinal::pg_catalog.text AS "rowOrdinal",
         pg_catalog.to_char(v.charge_period_start AT TIME ZONE 'UTC', ${ISO}) AS "chargePeriodStart",
         pg_catalog.to_char(v.charge_period_end AT TIME ZONE 'UTC', ${ISO}) AS "chargePeriodEnd",
         v.billed_cost::pg_catalog.text AS "billedCost",
         v.effective_cost::pg_catalog.text AS "effectiveCost",
         v.list_cost::pg_catalog.text AS "listCost",
         v.contracted_cost::pg_catalog.text AS "contractedCost",
         v.billing_currency AS "billingCurrency",
         v.provider_name AS "providerName",
         v.service_name AS "serviceName",
         v.service_category AS "serviceCategory",
         v.charge_category AS "chargeCategory",
         v.resource_id AS "resourceId",
         v.sub_account_id AS "subAccountId",
         v.billing_account_id AS "billingAccountId",
         v.usage_quantity::pg_catalog.text AS "usageQuantity",
         v.usage_unit AS "usageUnit",
         v.pricing_quantity::pg_catalog.text AS "pricingQuantity",
         v.pricing_unit AS "pricingUnit",
         v.focus_version AS "focusVersion",
         v.extra_columns AS "extraColumns",
         pg_catalog.to_char(v.published_at AT TIME ZONE 'UTC', ${ISO}) AS "publishedAt"
    FROM ratio.cost_facts_published v
   WHERE ${PERIOD_FILTER}
     AND ($3::pg_catalog.date IS NULL
          OR (v.billing_period, v.source_id, v.artifact_sha256, v.row_ordinal)
             > ($3::pg_catalog.date, $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.int8))
   ORDER BY v.billing_period, v.source_id, v.artifact_sha256, v.row_ordinal
   LIMIT $7`;

const TOTALS_SQL = `
  SELECT pg_catalog.to_char(v.billing_period, ${DAY}) AS "billingPeriod",
         v.billing_currency AS "billingCurrency",
         pg_catalog.count(*)::pg_catalog.text AS "rowCount",
         pg_catalog.sum(v.billed_cost)::pg_catalog.text AS "billedCost"
    FROM ratio.cost_facts_published v
   WHERE ${PERIOD_FILTER}
   GROUP BY v.billing_period, v.billing_currency
   ORDER BY v.billing_period, v.billing_currency`;

/** The two statements, exported for the setting-independence tests (D10b, U3). */
export const PUBLISHED_COSTS_SQL = Object.freeze({ page: PAGE_SQL, totals: TOTALS_SQL });

/** Session settings the read requires (pinned by readerPool.ts; asserted per read, failing closed). */
const REQUIRED_SESSION = Object.freeze({ iso: 'repeatable read', ro: 'on', datestyle: 'ISO, MDY', intervalstyle: 'postgres', timezone: 'UTC' });

// TEST SEAM (D8 only): runs between the page query and the totals query, to
// commit a publish inside an open read. Module-level, NOT a parameter of the
// public read: no caller can pass it per request. The setter refuses to run
// outside vitest, and testSeam.test.ts fails if any production file names it.
let afterPageForTests: (() => Promise<void>) | null = null;

export function setAfterPageHookForTests(fn: (() => Promise<void>) | null): void {
  if (!process.env.VITEST) throw new Error('setAfterPageHookForTests is test-only (vitest)');
  afterPageForTests = fn;
}

export async function readPublishedCosts(pool: Pick<Pool, 'connect'>, tenantId: string, q: PublishedCostsQuery): Promise<PublishedCostsPage> {
  return withTenantTransaction(pool, tenantId, async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    // Page and totals must share one snapshot, and the output must not depend
    // on session settings. The reader pool starts every transaction at
    // REPEATABLE READ and pins DateStyle / IntervalStyle / TimeZone
    // (readerPool.ts); fail closed on any session that differs, rather than
    // return totals that can disagree with the page or values (and cursors)
    // in another format.
    const tx = await client.query<Record<keyof typeof REQUIRED_SESSION, string>>(
      `SELECT pg_catalog.current_setting('transaction_isolation') AS iso,
              pg_catalog.current_setting('transaction_read_only') AS ro,
              pg_catalog.current_setting('DateStyle') AS datestyle,
              pg_catalog.current_setting('IntervalStyle') AS intervalstyle,
              pg_catalog.current_setting('TimeZone') AS timezone`,
    );
    const got = tx.rows[0];
    const wrong = (Object.keys(REQUIRED_SESSION) as Array<keyof typeof REQUIRED_SESSION>).filter((k) => got?.[k] !== REQUIRED_SESSION[k]);
    if (wrong.length) {
      throw new Error(
        `published-costs read requires a REPEATABLE READ READ ONLY transaction with DateStyle ISO, MDY, IntervalStyle postgres and TimeZone UTC (wrong: ${wrong.join(', ')})`,
      );
    }
    await assertSafeReaderLogin(client);

    const c = q.cursor;
    const page = await client.query<PublishedCostRow>(PAGE_SQL, [
      q.from,
      q.to,
      c ? c.billingPeriod : null,
      c ? c.sourceId : null,
      c ? c.artifactSha256 : null,
      c ? c.rowOrdinal : null,
      q.limit + 1,
    ]);
    const more = page.rows.length > q.limit;
    const data = more ? page.rows.slice(0, q.limit) : page.rows;
    const last = data[data.length - 1];
    const nextCursor =
      more && last
        ? encodeCursor({ billingPeriod: last.billingPeriod, sourceId: last.sourceId, artifactSha256: last.artifactSha256, rowOrdinal: last.rowOrdinal })
        : null;

    if (afterPageForTests) await afterPageForTests();

    let totals: PublishedCostsTotal[] | null = null;
    if (!c) {
      const t = await client.query<{ billingPeriod: string; billingCurrency: string; rowCount: string; billedCost: string }>(TOTALS_SQL, [q.from, q.to]);
      totals = t.rows.map((r) => ({ billingPeriod: r.billingPeriod, billingCurrency: r.billingCurrency, rowCount: r.rowCount, billedCost: r.billedCost }));
    }
    return { data, page: { limit: q.limit, nextCursor }, totals };
  });
}

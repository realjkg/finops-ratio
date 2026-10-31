// GET /api/v1/reports/facts?period=YYYY-MM — the internal report-facts reader
// (1.0): deterministic facts for one billing period of the tenant's published
// cost facts (src/reports/reportFacts.ts). Same auth, gateway, tenant binding,
// reader login, deadline and fail-closed errors as GET /api/v1/costs/published
// (one shared factory). The tenant is never read from the request. In
// engagement mode the engagement config adds the reporting currency and the
// declared source metadata; otherwise those are N/A with a reason.
import type { NextApiHandler } from 'next';
import { engagementConfigFromEnv, engagementMode } from '@/engagement/config';
import { assembleReportFacts, type ReportFactsInput } from '@/reports/reportFacts';
import { createReaderRoute, type PublishedCostsRouteDeps } from './publishedCostsRoute';
import { readReportFactsAggregates } from './reportFactsRead';

export const REPORT_FACTS_QUERY_MESSAGE = 'Exactly one query parameter is allowed: period=YYYY-MM (2000-01 to 9999-12)';
const MONTH_RE = /^(2\d{3}|[3-9]\d{3})-(0[1-9]|1[0-2])$/;

export function parseReportFactsQuery(query: Record<string, string | string[] | undefined>): { ok: true; value: { period: string } } | { ok: false; message: string } {
  const keys = Object.keys(query ?? {}).filter((k) => query[k] !== undefined);
  const period = query.period;
  if (keys.length !== 1 || typeof period !== 'string' || !MONTH_RE.test(period)) return { ok: false, message: REPORT_FACTS_QUERY_MESSAGE };
  return { ok: true, value: { period: `${period}-01` } };
}

function engagementOf(env: Record<string, string | undefined>): ReportFactsInput['engagement'] {
  if (!engagementMode(env)) return null;
  const e = engagementConfigFromEnv(env);
  // Already validated by the tenant binding (publishedCostsConfig); fail closed if it changed since.
  if (!e.ok) throw new Error('engagement configuration became invalid');
  return {
    currency: e.config.currency,
    declaredSources: e.config.sources.map((s) => ({
      id: s.id,
      provider: s.metadata.provider,
      costBasis: s.metadata.cost_basis,
      creditsCoverage: s.metadata.financial.credits_coverage,
      completeness: s.metadata.scope.completeness,
      controlTotalSource: s.metadata.financial.control_total_source,
    })),
  };
}

export function createReportFactsRoute(deps: PublishedCostsRouteDeps = {}): NextApiHandler {
  return createReaderRoute(deps, {
    tag: 'report-facts',
    parse: parseReportFactsQuery,
    read: async (pool, tenantId, q, { env, now }) => {
      const engagement = engagementOf(env);
      const agg = await readReportFactsAggregates(pool, tenantId, q.period);
      return assembleReportFacts({ period: q.period, asOf: now.toISOString(), ...agg, engagement });
    },
  });
}

// GET /api/v1/reports/engagement?period=YYYY-MM&format=xlsx — the engagement
// cost report (1.0) as an XLSX workbook, rendered from the engagement report
// model, which is built only from the report facts of that period (one
// snapshot, src/server/costs/reportFactsRead.ts). Same shared factory as
// /api/v1/reports/facts: live-data auth, gateway (GET only), tenant from the
// server (engagement config in engagement mode), reader login, deadline,
// fail-closed 503s and a generic 500. format is required (pdf comes next).
import type { NextApiHandler } from 'next';
import { buildEngagementReportModel, engagementReportFilename } from '@/reports/engagementReportModel';
import { renderEngagementReportXlsx } from '@/reports/engagementReportXlsx';
import { createReaderRoute, type PublishedCostsRouteDeps } from './publishedCostsRoute';
import { parseReportFactsQuery, readReportFacts } from './reportFactsRoute';

export const ENGAGEMENT_REPORT_QUERY_MESSAGE = 'Exactly two query parameters are allowed: period=YYYY-MM (2000-01 to 9999-12) and format=xlsx';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function parseEngagementReportQuery(query: Record<string, string | string[] | undefined>): { ok: true; value: { period: string; format: 'xlsx' } } | { ok: false; message: string } {
  const { format, ...rest } = query ?? {};
  const p = parseReportFactsQuery(rest);
  if (format !== 'xlsx' || !p.ok) return { ok: false, message: ENGAGEMENT_REPORT_QUERY_MESSAGE };
  return { ok: true, value: { period: p.value.period, format } };
}

export function createEngagementReportRoute(deps: PublishedCostsRouteDeps = {}): NextApiHandler {
  return createReaderRoute(deps, {
    tag: 'engagement-report',
    parse: parseEngagementReportQuery,
    read: async (pool, tenantId, q, { env, now }) => {
      const { facts, label } = await readReportFacts(pool, tenantId, q.period, env, now);
      const body = await renderEngagementReportXlsx(buildEngagementReportModel(facts, label));
      return { body, filename: engagementReportFilename(facts.period.month, q.format, now) };
    },
    respond: (res, out) => {
      const { body, filename } = out as { body: Buffer; filename: string };
      res.setHeader('Content-Type', XLSX);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', body.length);
      res.status(200).send(body);
    },
  });
}

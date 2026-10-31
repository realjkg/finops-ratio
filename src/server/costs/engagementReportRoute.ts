// GET /api/v1/reports/engagement?period=YYYY-MM&format=xlsx|pdf|json — the
// engagement cost report (1.0): ONE engagement report model, built only from
// the report facts of that period (one snapshot, reportFactsRead.ts), rendered
// as an XLSX workbook, a PDF, or returned as JSON (for the report page). Same
// shared factory as /api/v1/reports/facts: live-data auth, gateway (GET only),
// tenant from the server (engagement config in engagement mode), reader login,
// deadline, fail-closed 503s and a generic 500. format is an exact allowlist.
// A PDF whose text the bundled fonts cannot render faithfully is refused with 422
// (fixed, counts-only message; no PDF); the XLSX and JSON carry the full text.
// With every PDF render slot taken, a PDF request is 503 pdf_busy (Retry-After).
import type { NextApiHandler } from 'next';
import { buildEngagementReportModel, engagementReportFilename, type EngagementReportModel } from '@/reports/engagementReportModel';
import { PDF_BUSY_MESSAGE, PdfBusyError, PdfUnsupportedTextError, renderEngagementReportPdf, type PdfUnsupportedCounts } from '@/reports/engagementReportPdf';
import { renderEngagementReportXlsx } from '@/reports/engagementReportXlsx';
import { createReaderRoute, type PublishedCostsRouteDeps } from './publishedCostsRoute';
import { parseReportFactsQuery, readReportFacts } from './reportFactsRoute';

export const ENGAGEMENT_REPORT_QUERY_MESSAGE = 'Exactly two query parameters are allowed: period=YYYY-MM (2000-01 to 9999-12) and format=xlsx, pdf or json';
const FORMATS = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf', json: null } as const;
type Format = keyof typeof FORMATS;
const isFormat = (v: unknown): v is Format => typeof v === 'string' && Object.prototype.hasOwnProperty.call(FORMATS, v);

export function parseEngagementReportQuery(query: Record<string, string | string[] | undefined>): { ok: true; value: { period: string; format: Format } } | { ok: false; message: string } {
  const { format, ...rest } = query ?? {};
  const p = parseReportFactsQuery(rest);
  if (!isFormat(format) || !p.ok) return { ok: false, message: ENGAGEMENT_REPORT_QUERY_MESSAGE };
  return { ok: true, value: { period: p.value.period, format } };
}

type Out = { format: 'json'; model: EngagementReportModel } | { format: 'xlsx' | 'pdf'; body: Buffer; filename: string } | { format: 'pdf-refused'; counts: PdfUnsupportedCounts; message: string } | { format: 'pdf-busy' };

async function renderPdf(model: EngagementReportModel): Promise<Buffer | PdfUnsupportedTextError | PdfBusyError> {
  try {
    return await renderEngagementReportPdf(model);
  } catch (err) {
    if (err instanceof PdfUnsupportedTextError || err instanceof PdfBusyError) return err;
    throw err;
  }
}

export function createEngagementReportRoute(deps: PublishedCostsRouteDeps = {}): NextApiHandler {
  return createReaderRoute(deps, {
    tag: 'engagement-report',
    parse: parseEngagementReportQuery,
    session: { permission: (q) => (q.format === 'json' ? 'reports:read' : 'reports:export'), format: (q) => q.format },
    read: async (pool, tenantId, q, { env, now }): Promise<Out> => {
      const { facts, label } = await readReportFacts(pool, tenantId, q.period, env, now);
      const model = buildEngagementReportModel(facts, label);
      if (q.format === 'json') return { format: 'json', model };
      const body = q.format === 'pdf' ? await renderPdf(model) : await renderEngagementReportXlsx(model);
      if (body instanceof PdfUnsupportedTextError) return { format: 'pdf-refused', counts: body.counts, message: body.message };
      if (body instanceof PdfBusyError) return { format: 'pdf-busy' };
      return { format: q.format, body, filename: engagementReportFilename(facts.period.month, q.format, now) };
    },
    respond: (res, result) => {
      const out = result as Out;
      if (out.format === 'json') {
        res.status(200).json(out.model);
        return;
      }
      if (out.format === 'pdf-busy') {
        res.setHeader('Retry-After', '5');
        res.status(503).json({ error: { code: 'pdf_busy', message: PDF_BUSY_MESSAGE } });
        return;
      }
      if (out.format === 'pdf-refused') {
        res.status(422).json({ error: { code: 'pdf_unsupported_text', message: out.message, counts: out.counts } });
        return;
      }
      res.setHeader('Content-Type', FORMATS[out.format]);
      res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
      res.setHeader('Content-Length', out.body.length);
      res.status(200).send(out.body);
    },
  });
}

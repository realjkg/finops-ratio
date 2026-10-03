// GET /api/report/snapshot?format=pdf|xlsx (Ratio v2 Wave 2b).
//
// On-demand reporting export for the executive surface. Renders a point-in-time
// Initiative Cost Report as either a PDF (@react-pdf/renderer) or an XLSX
// workbook (ExcelJS), both auto-timestamped from a single UTC instant so a
// paired download is unambiguous. Pure over the bundled seed — no persistence,
// no external calls. The PDF/XLSX renderers are server-only (imported here, in
// pages/api) so the heavy deps never reach the client bundle.
//
// Errors:
//   400 — unknown ?format value
//   405 — non-GET method
import type { NextApiRequest, NextApiResponse } from 'next';
import { reportFilename, type ReportFormat } from '@/executive/reportFilename';
import { renderReportPdf } from '@/executive/reportPdf';
import { buildReportWorkbook } from '@/executive/reportXlsx';

const CONTENT_TYPE: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// Absent format defaults to PDF; an explicit unknown value is a client error.
function parseFormat(raw: NextApiRequest['query'][string]): ReportFormat | null {
  if (raw === undefined) return 'pdf';
  if (raw === 'pdf' || raw === 'xlsx') return raw;
  return null;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const format = parseFormat(req.query.format);
  if (!format) {
    res.status(400).json({ error: "Query param 'format' must be 'pdf' or 'xlsx'" });
    return;
  }

  // One instant powers both the filename and the report body.
  const now = new Date();
  const filename = reportFilename(format, now);
  const body =
    format === 'pdf' ? await renderReportPdf(now) : await buildReportWorkbook(now);

  res.setHeader('Content-Type', CONTENT_TYPE[format]);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', body.length);
  res.status(200).send(body);
}


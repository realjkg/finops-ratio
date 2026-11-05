// Review M1: a demo export must not pass for a real report when it is forwarded. In demo mode the PDF
// footer and the XLSX carry one quiet line with the badge wording; outside demo mode (engagement, or an
// invalid RATIO_MODE) they do not, and the engagement report exports never do.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import ExcelJS from 'exceljs';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_LABEL } from '@/lib/demoMode';
import { buildReportModel } from './reportModel';
import { ReportDocument } from './reportPdf';
import { buildReportWorkbook } from './reportXlsx';
import handler from '../../pages/api/report/snapshot';
import { CASES } from '@/reports/fixtures/reportTables';
import { renderEngagementReportXlsx } from '@/reports/engagementReportXlsx';
import { EngagementReportDocument } from '@/reports/engagementReportPdf';
import { loadPdfFonts } from '@/reports/pdfFonts';
import { treeTexts } from '@/reports/fixtures/pdfText';

function pdfText(node: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === 'string' || typeof n === 'number') out.push(String(n));
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object' && 'type' in n) {
      const el = n as ReactElement<{ children?: unknown }>;
      walk(typeof el.type === 'function' ? (el.type as (p: unknown) => unknown)(el.props) : el.props.children);
    }
  };
  walk(node);
  return out.join('|');
}

const FIXED = new Date('2026-06-26T14:32:00Z');
const model = buildReportModel(FIXED);
const count = (text: string) => text.split(DEMO_LABEL).length - 1;

async function workbook(buf: Buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buf as unknown as ArrayBuffer);
  return book;
}

async function snapshot(format: 'pdf' | 'xlsx'): Promise<Buffer> {
  let body: unknown;
  const res = { setHeader() {}, status() { return this; }, json() { return this; }, send(b: unknown) { body = b; return this; } } as unknown as NextApiResponse;
  await handler({ method: 'GET', query: { format } } as unknown as NextApiRequest, res);
  return body as Buffer;
}

afterEach(() => vi.unstubAllEnvs());

describe('demo report exports carry the demo line', () => {
  it('PDF: the footer reads the badge wording, once per page footer', () => {
    const text = pdfText(<ReportDocument model={model} />);
    expect(count(text)).toBe(1);
    expect(text).toMatch(new RegExp(`${DEMO_LABEL} · Generated from Ratio Mission Control`));
  });

  it('XLSX: an About sheet states it, and the Initiatives sheet prints it in its footer', async () => {
    const book = await workbook(await buildReportWorkbook(FIXED, model));
    expect(book.getWorksheet('About')?.getCell('A1').value).toBe(DEMO_LABEL);
    expect(book.getWorksheet('Initiatives')!.headerFooter.oddFooter).toContain(DEMO_LABEL);
    // The approved Initiatives columns and rows are unchanged.
    expect(book.getWorksheet('Initiatives')!.getRow(1).getCell(1).value).toBe('Initiative Name');
  });

  it('the snapshot route in demo mode: both downloads carry it', async () => {
    const book = await workbook(await snapshot('xlsx'));
    expect(book.getWorksheet('About')?.getCell('A1').value).toBe(DEMO_LABEL);
    expect((await snapshot('pdf')).subarray(0, 4).toString('latin1')).toBe('%PDF');
  });
});

describe('outside demo mode the exports carry no demo line', () => {
  for (const mode of ['engagement', 'Engagement']) {
    it(`RATIO_MODE=${mode}: no PDF footer line, no About sheet, no XLSX footer`, async () => {
      vi.stubEnv('RATIO_MODE', mode);
      expect(count(pdfText(<ReportDocument model={model} />))).toBe(0);
      const book = await workbook(await buildReportWorkbook(FIXED, model));
      expect(book.getWorksheet('About')).toBeUndefined();
      expect(book.getWorksheet('Initiatives')!.headerFooter?.oddFooter ?? '').not.toContain(DEMO_LABEL);
      const viaRoute = await workbook(await snapshot('xlsx'));
      expect(viaRoute.getWorksheet('About')).toBeUndefined();
    });
  }

  it('the engagement report exports (XLSX and PDF) never carry it', async () => {
    await loadPdfFonts();
    for (const [name, build] of Object.entries(CASES)) {
      const m = build();
      const book = await workbook(await renderEngagementReportXlsx(m));
      const cells: string[] = [];
      book.eachSheet((s) => { cells.push(s.name, s.headerFooter?.oddFooter ?? ''); s.eachRow((r) => r.eachCell((c) => cells.push(String(c.value)))); });
      expect(cells.join('\n'), name).not.toContain(DEMO_LABEL);
      let pdf: string[] = [];
      try {
        pdf = treeTexts(<EngagementReportDocument model={m} />);
      } catch (e) {
        if (!/PdfUnsupportedText/.test(String((e as Error).name))) throw e; // a case the PDF refuses by design: no output at all
      }
      expect(pdf.join('|'), name).not.toContain(DEMO_LABEL);
    }
  });

  it('no engagement source references the demo wording or the demo export line', () => {
    const walk = (d: string, o: string[] = []): string[] => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, o); else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) o.push(p); } return o; };
    const root = join(__dirname, '..');
    for (const f of [...walk(join(root, 'reports')), ...walk(join(root, 'engagement'))]) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/demoExportLine|DEMO_LABEL|figures are illustrative/);
    }
  });
});

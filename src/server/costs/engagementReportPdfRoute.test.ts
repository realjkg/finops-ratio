// GET /api/v1/reports/engagement?format=pdf with the bundled fonts: supported
// scripts give a PDF; characters the PDF cannot render give 422 with a fixed,
// counts-only message pointing to XLSX/JSON and no PDF (default 'refuse' policy).
// The report-facts read is replaced by SYNTHETIC facts (no database).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleReportFacts } from '@/reports/reportFacts';
import { ENGAGEMENT, g, sampleInput } from '@/reports/fixtures/sampleFacts';
import { pdfShownStrings } from '@/reports/fixtures/pdfText';
import { PDF_BUSY_MESSAGE, PDF_UNSUPPORTED_MESSAGE } from '@/reports/engagementReportPdf';
import { createEngagementReportRoute } from './engagementReportRoute';
import { bearer, call, makeReq, TEST_API_TOKEN } from './testing/http';

const state = vi.hoisted(() => ({ cells: [] as string[] }));
vi.mock('./reportFactsRoute', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./reportFactsRoute')>()),
  readReportFacts: vi.fn(async () => ({
    facts: assembleReportFacts(sampleInput({ groups: [g({}), ...state.cells.map((c) => g({ isTotal: false, chargeCategory: c, rowCount: '1' }))] })),
    label: ENGAGEMENT,
  })),
}));

const ENV = { RATIO_API_TOKEN: TEST_API_TOKEN, RATIO_API_TENANT_ID: '11111111-1111-4111-8111-111111111111', RATIO_READER_DATABASE_URL: 'postgres://reader@127.0.0.1:1/ratio' };
const route = () => createEngagementReportRoute({ env: ENV, poolFor: () => ({ connect: vi.fn() }) as never, logger: () => undefined, now: () => new Date('2026-10-31T12:00:00Z') });
let addr = 0;
const get = (format: string) => call(route(), makeReq({ headers: bearer(), query: { period: '2024-09', format }, remoteAddress: `10.81.0.${++addr}` }));

beforeEach(() => {
  for (const k of ['info', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('engagement report PDF: supported scripts render, unsupported text is refused with 422', () => {
  it('Chinese, Japanese, Korean, Cyrillic and Latin accents: 200 application/pdf with the text', async () => {
    state.cells = ['成本报告', 'コスト', '비용', 'Москва', 'Éclair Çà'];
    const res = await get('pdf');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const shown = pdfShownStrings(res.body as Buffer);
    for (const c of state.cells) expect(shown).toContain(c);
  }, 30_000);

  it('Arabic and emoji: 422, a fixed counts-only message, no PDF and no cell value; XLSX and JSON still serve the full text', async () => {
    state.cells = ['مرحبا', 'Paid 😀', 'Usage'];
    const res = await get('pdf');
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toBeUndefined();
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      error: { code: 'pdf_unsupported_text', message: PDF_UNSUPPORTED_MESSAGE({ cells: 2, complex: 1, emoji: 1, other: 0 }), counts: { cells: 2, complex: 1, emoji: 1, other: 0 } },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/مرحبا|😀/);
    const json = await get('json');
    expect(json.statusCode).toBe(200);
    expect(JSON.stringify(json.body)).toContain('مرحبا');
    const xlsx = await get('xlsx');
    expect(xlsx.statusCode).toBe(200);
  }, 30_000);

  it('more concurrent PDF requests than render slots: the extra one is 503 pdf_busy with Retry-After, no PDF', async () => {
    state.cells = ['Usage'];
    const res = await Promise.all([get('pdf'), get('pdf'), get('pdf')]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 200, 503]);
    const busy = res.find((r) => r.statusCode === 503)!;
    expect(busy.body).toEqual({ error: { code: 'pdf_busy', message: PDF_BUSY_MESSAGE } });
    expect(busy.headers['retry-after']).toBe('5');
    expect(busy.headers['content-disposition']).toBeUndefined();
  }, 60_000);
});

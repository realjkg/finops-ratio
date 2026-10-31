// Engagement report XLSX: opened with ExcelJS and compared cell by cell with
// the one engagement report model. Amounts are exact: every cell is a text
// cell holding the model's decimal string (no float, no formula, no rounding).
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { assembleReportFacts, NA_REASONS } from './reportFacts';
import { buildEngagementReportModel, type EngagementReportModel } from './engagementReportModel';
import { renderEngagementReportXlsx } from './engagementReportXlsx';
import { ENGAGEMENT, sampleInput } from './fixtures/sampleFacts';

async function open(m: EngagementReportModel): Promise<ExcelJS.Workbook> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load((await renderEngagementReportXlsx(m)) as unknown as ArrayBuffer);
  return book;
}
const valuesOf = (ws: ExcelJS.Worksheet) => {
  const out: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => out.push((row.values as unknown[]).slice(1)));
  return out;
};

describe('engagement report XLSX', () => {
  it('one sheet per model section, header row then the model rows, cell for cell', async () => {
    const m = buildEngagementReportModel(assembleReportFacts(sampleInput()), ENGAGEMENT);
    const book = await open(m);
    expect(book.worksheets.map((w) => w.name)).toEqual(m.sections.map((s) => s.title));
    for (const s of m.sections) {
      const ws = book.getWorksheet(s.title)!;
      const rows = valuesOf(ws).map((r) => r.map((v) => (v === undefined || v === null ? '' : v)));
      const expected = [s.columns, ...s.rows].map((r) => {
        const trimmed = [...r];
        while (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop();
        return trimmed;
      });
      expect(rows, s.id).toEqual(expected);
    }
  });

  it('money is exact text (no number cells, no formulas): 18.00663861840 stays 18.00663861840', async () => {
    const book = await open(buildEngagementReportModel(assembleReportFacts(sampleInput()), ENGAGEMENT));
    const totals = book.getWorksheet('Totals by currency')!;
    expect(totals.getRow(2).getCell(3).value).toBe('18.00663861840');
    expect(totals.getRow(2).getCell(4).value).toBe('13.00000000000');
    book.eachSheet((ws) =>
      ws.eachRow((row) =>
        row.eachCell((cell) => {
          expect(typeof cell.value, `${ws.name}!${cell.address}`).toBe('string');
          expect(cell.numFmt, `${ws.name}!${cell.address}`).toBe('@');
        }),
      ),
    );
  });

  it('no published data: N/A text with every reason present, never a 0', async () => {
    const m = buildEngagementReportModel(assembleReportFacts(sampleInput({ groups: [], batches: [], artifacts: [], engagement: null })), null);
    const book = await open(m);
    const text: string[] = [];
    book.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => text.push(String(c.value)))));
    for (const reason of [NA_REASONS.noPublished, NA_REASONS.noEngagement, NA_REASONS.batchStatus]) expect(text, reason).toContain(reason);
    expect(text.filter((t) => /^-?0(\.0+)?$/.test(t))).toEqual([]);
    expect(text).toContain('N/A');
  });

  it('is stamped from the report instant, not the build clock', async () => {
    const m = buildEngagementReportModel(assembleReportFacts(sampleInput()), ENGAGEMENT);
    const book = await open(m);
    expect(book.created?.toISOString()).toBe('2026-10-31T12:00:00.000Z');
    expect(book.creator).toBe('Ratio');
  });
});

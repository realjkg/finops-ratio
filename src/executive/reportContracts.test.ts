// Pilot P0 contracts on the report paths (model, XLSX, PDF): N/A keeps its
// reason and never becomes 0, and an unconfirmed-role source adds no savings.
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { WORKLOADS } from '@/data/workloads';
import { budgetCellText, budgetNaFootnotes, buildReportModel } from './reportModel';
import { buildReportWorkbook } from './reportXlsx';
import { renderReportPdf } from './reportPdf';

const FIXED = new Date('2026-06-26T14:32:00Z');
const [first, ...rest] = WORKLOADS;
const model = buildReportModel(FIXED, [{ ...first, costs: { ...first.costs, monthly_budget: 0 } }, ...rest]);

describe('report with an invalid approved budget', () => {
  it('carries N/A with its reason through the model, cell text and footnotes', () => {
    expect(model.rows[0].budgetConsumedPct).toBeNull();
    expect(model.rows[0].budgetConsumedNa).toMatch(/approved budget/i);
    expect(budgetCellText(model.rows[0])).toBe('N/A');
    expect(budgetCellText({ budgetConsumedPct: 42, budgetConsumedNa: null })).toBe('42%');
    expect(budgetNaFootnotes(model.rows)).toEqual([`${first.name}: Budget consumed N/A (${model.rows[0].budgetConsumedNa})`]);
    expect(budgetNaFootnotes(buildReportModel(FIXED).rows)).toEqual([]);
  });

  it('writes the XLSX cell as N/A text with the reason, not 0', async () => {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await buildReportWorkbook(FIXED, model)) as unknown as ArrayBuffer);
    expect(String(book.getWorksheet('Initiatives')!.getCell('D2').value)).toMatch(/^N\/A \(.*approved budget/i);
  });

  it('renders a PDF', async () => {
    expect((await renderReportPdf(FIXED, model)).subarray(0, 4).toString('latin1')).toBe('%PDF');
  });
});

describe('report savings', () => {
  it('rows sum to the summary and exclude the unconfirmed-role source', () => {
    const m = buildReportModel(FIXED);
    expect(m.rows.reduce((s, r) => s + r.savingsOpportunity, 0)).toBe(m.summary.projectedSavings);
    expect(m.summary.projectedSavings).toBe(2408);
  });
});

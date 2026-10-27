// Pilot P0 contracts on the report paths (model, XLSX, PDF): N/A keeps its
// reason and never becomes 0, and an unconfirmed-role source adds no savings.
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { WORKLOADS } from '@/data/workloads';
import { budgetCellText, budgetNaFootnotes, buildReportModel } from './reportModel';
import { buildReportWorkbook } from './reportXlsx';
import type { ReactElement } from 'react';
import { ReportDocument } from './reportPdf';

// Flatten a react-pdf element tree to its text, calling our own function
// components; host elements are strings. Text nodes are joined with "|".
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
const [first, ...rest] = WORKLOADS;
const model = buildReportModel(FIXED, [{ ...first, costs: { ...first.costs, monthly_budget: 0 } }, ...rest]);

describe('report with an invalid approved budget', () => {
  it('carries N/A with its reason through the model, cell text and footnotes', () => {
    expect(model.rows[0].budgetConsumedPct).toBeNull();
    expect(model.rows[0].budgetConsumedNa).toMatch(/approved budget/i);
    expect(budgetCellText(model.rows[0])).toBe('N/A');
    expect(budgetCellText({ budgetConsumedPct: 42 })).toBe('42%');
    expect(budgetNaFootnotes(model.rows)).toEqual([`${first.name}: Budget consumed N/A (${model.rows[0].budgetConsumedNa})`]);
    expect(budgetNaFootnotes(buildReportModel(FIXED).rows)).toEqual([]);
  });

  it('writes the XLSX cell as N/A text with the reason, not 0', async () => {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await buildReportWorkbook(FIXED, model)) as unknown as ArrayBuffer);
    expect(String(book.getWorksheet('Initiatives')!.getCell('D2').value)).toMatch(/^N\/A \(.*approved budget/i);
  });

  it('puts the N/A state and its reason in the PDF element tree', () => {
    const text = pdfText(<ReportDocument model={model} />);
    expect(text).toContain(`${first.name}: Budget consumed N/A (${model.rows[0].budgetConsumedNa})`);
    expect(text).toContain('N/A');
    expect(text).not.toMatch(/(^|\|)0%(\||$)/);
  });
});

describe('report savings', () => {
  it('rows sum to the summary and exclude the unconfirmed-role source', () => {
    const m = buildReportModel(FIXED);
    expect(m.rows.reduce((s, r) => s + r.savingsOpportunity, 0)).toBe(m.summary.projectedSavings);
    expect(m.summary.projectedSavings).toBe(2408);
  });
});

describe('over-budget values stay visible', () => {
  const over = buildReportModel(FIXED, [{ ...first, costs: { ...first.costs, monthly_budget: 1 } }, ...rest]);
  const pct = over.rows[0].budgetConsumedPct!;

  it('is not clamped in the model, the XLSX cell or the PDF tree', async () => {
    expect(pct).toBeGreaterThan(100);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await buildReportWorkbook(FIXED, over)) as unknown as ArrayBuffer);
    expect(book.getWorksheet('Initiatives')!.getCell('D2').value).toBe(pct);
    expect(pdfText(<ReportDocument model={over} />)).toContain(`|${pct}%|`);
  });
});

describe('PDF savings explanation', () => {
  it('says unconfirmed-role findings are excluded and shows the verified total', () => {
    const text = pdfText(<ReportDocument model={buildReportModel(FIXED)} />);
    expect(text).toMatch(/exclude findings from sources whose role is unconfirmed/);
    expect(text).toContain('$2,408');
  });
});

describe('status of an invalid-budget initiative (report paths)', () => {
  // No alerts: nothing adverse remains once the invalid period is set aside.
  const noAlerts = { alerts: [] };
  const rest0 = buildReportModel(FIXED, rest, noAlerts);
  const model = buildReportModel(FIXED, [{ ...first, costs: { ...first.costs, monthly_budget: 0, daily_budget: 0 } }, ...rest], noAlerts);

  it('is "Budget N/A" in the row, XLSX cell and PDF tree, and not counted as pending', async () => {
    expect(model.rows[0].status).toBe('Budget N/A');
    expect(model.summary.pendingApproval).toBe(rest0.summary.pendingApproval);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await buildReportWorkbook(FIXED, model)) as unknown as ArrayBuffer);
    expect(book.getWorksheet('Initiatives')!.getCell('E2').value).toBe('Budget N/A');
    const text = pdfText(<ReportDocument model={model} />);
    expect(text).toContain('|Budget N/A|');
  });
});

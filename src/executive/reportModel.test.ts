// Tests for the Wave 2b report view-model + XLSX shape. Confirms the export is a
// faithful, additive projection of the Wave 2a Initiative Dashboard engine: one
// row per initiative, the eight user-approved columns in order, R4 value pairing,
// and a board-level summary that matches the Spend Summary. Pure — no DOM.
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { buildInitiativeBoard } from './initiativeModel';
import { buildReportModel } from './reportModel';
import { REPORT_COLUMNS, buildReportWorkbook } from './reportXlsx';

const FIXED = new Date('2026-06-26T14:32:00Z');

describe('report view-model', () => {
  const model = buildReportModel(FIXED);
  const { initiatives, summary } = buildInitiativeBoard();

  it('projects one report row per initiative', () => {
    expect(model.rows).toHaveLength(initiatives.length);
  });

  it('reuses the Initiative Dashboard summary verbatim', () => {
    expect(model.summary).toEqual(summary);
  });

  it('derives annual run rate as 12x monthly cost', () => {
    for (const row of model.rows) {
      expect(row.annualRunRate).toBe(row.monthlyCost * 12);
    }
  });

  it('pairs every cost with a value-efficiency figure (R4)', () => {
    for (const row of model.rows) {
      expect(row.monthlyCost).toBeGreaterThan(0);
      expect(row.costEfficiency).toBeGreaterThan(0);
      expect(row.savingsOpportunity).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps budget consumed within 0..100', () => {
    for (const row of model.rows) {
      expect(row.budgetConsumedPct).toBeGreaterThanOrEqual(0);
      expect(row.budgetConsumedPct).toBeLessThanOrEqual(100);
    }
  });

  it('labels the reporting period from the generated instant (UTC)', () => {
    expect(model.periodLabel).toBe('June 2026');
    expect(model.generatedAt).toBe('2026-06-26T14:32:00.000Z');
  });
});

describe('report workbook', () => {
  it('exposes exactly the eight user-approved columns, in order', () => {
    expect(REPORT_COLUMNS).toEqual([
      'Initiative Name',
      'Monthly Cost ($)',
      'Annual Run Rate ($)',
      'Budget Consumed (%)',
      'Status',
      'Cost Efficiency Score',
      'Savings Opportunity ($)',
      'Last Updated',
    ]);
  });

  it('writes a valid xlsx with a header row + one data row per initiative', () => {
    const buffer = buildReportWorkbook(FIXED);
    // Office Open XML is a zip archive — magic bytes 'PK'.
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');

    const book = XLSX.read(buffer, { type: 'buffer' });
    const sheet = book.Sheets[book.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
    const model = buildReportModel(FIXED);

    expect(rows).toHaveLength(model.rows.length);
    expect(Object.keys(rows[0])).toEqual([...REPORT_COLUMNS]);
    expect(rows[0]['Initiative Name']).toBe(model.rows[0].name);
    expect(rows[0]['Annual Run Rate ($)']).toBe(model.rows[0].annualRunRate);
  });

  it('round-trips: the workbook opens with an "Initiatives" sheet whose every cell matches the model', () => {
    const buffer = buildReportWorkbook(FIXED);
    const book = XLSX.read(buffer, { type: 'buffer' });
    expect(book.SheetNames).toEqual(['Initiatives']);

    const sheet = book.Sheets.Initiatives;
    // Raw 2-D view: header row first, then one array per data row.
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
    const model = buildReportModel(FIXED);

    expect(grid[0]).toEqual([...REPORT_COLUMNS]);
    expect(grid).toHaveLength(model.rows.length + 1);
    model.rows.forEach((row, i) => {
      expect(grid[i + 1]).toEqual([
        row.name,
        row.monthlyCost,
        row.annualRunRate,
        row.budgetConsumedPct,
        row.status,
        Number(row.costEfficiency.toFixed(1)),
        row.savingsOpportunity,
        row.lastUpdated,
      ]);
    });

    // Spot-check addressed cells so cell placement (not just order) is pinned.
    expect(sheet.A1.v).toBe('Initiative Name');
    expect(sheet.H1.v).toBe('Last Updated');
    expect(sheet.A2.v).toBe(model.rows[0].name);
    expect(sheet.C2.v).toBe(model.rows[0].annualRunRate);
    expect(sheet.C2.t).toBe('n');
  });

  it('auto-fits column widths', () => {
    const buffer = buildReportWorkbook(FIXED);
    const book = XLSX.read(buffer, { type: 'buffer', cellStyles: true });
    const sheet = book.Sheets[book.SheetNames[0]];
    expect(sheet['!cols']).toBeDefined();
    expect(sheet['!cols']).toHaveLength(REPORT_COLUMNS.length);
  });
});


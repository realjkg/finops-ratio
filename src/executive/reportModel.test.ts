// Tests for the Wave 2b report view-model + XLSX shape. Confirms the export is a
// faithful, additive projection of the Wave 2a Initiative Dashboard engine: one
// row per initiative, the eight user-approved columns in order, R4 value pairing,
// and a board-level summary that matches the Spend Summary. Pure — no DOM.
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildInitiativeBoard } from './initiativeModel';
import { buildReportModel } from './reportModel';
import { REPORT_COLUMNS, buildReportWorkbook } from './reportXlsx';

const FIXED = new Date('2026-06-26T14:32:00Z');

// Re-open a generated workbook from its bytes, as a spreadsheet app would.
async function readBook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  return book;
}

// Dense 2-D view of a worksheet (ExcelJS row.values is 1-indexed; drop slot 0).
function sheetGrid(sheet: ExcelJS.Worksheet): unknown[][] {
  const grid: unknown[][] = [];
  sheet.eachRow((row) => {
    grid.push((row.values as unknown[]).slice(1));
  });
  return grid;
}

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
      // costEfficiency mirrors the defensible value ratio, which may be
      // non-positive for a workload whose misses outweigh counted value.
      expect(Number.isFinite(row.costEfficiency)).toBe(true);
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

  it('writes a valid xlsx with a header row + one data row per initiative', async () => {
    const buffer = await buildReportWorkbook(FIXED);
    // Office Open XML is a zip archive — magic bytes 'PK'.
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');

    const grid = sheetGrid((await readBook(buffer)).worksheets[0]);
    const [header, ...rows] = grid;
    const model = buildReportModel(FIXED);

    expect(rows).toHaveLength(model.rows.length);
    expect(header).toEqual([...REPORT_COLUMNS]);
    expect(rows[0][REPORT_COLUMNS.indexOf('Initiative Name')]).toBe(model.rows[0].name);
    expect(rows[0][REPORT_COLUMNS.indexOf('Annual Run Rate ($)')]).toBe(
      model.rows[0].annualRunRate,
    );
  });

  it('round-trips: the workbook opens with an "Initiatives" sheet whose every cell matches the model', async () => {
    const buffer = await buildReportWorkbook(FIXED);
    const book = await readBook(buffer);
    expect(book.worksheets.map((ws) => ws.name)).toEqual(['Initiatives']);

    const sheet = book.getWorksheet('Initiatives')!;
    // Raw 2-D view: header row first, then one array per data row.
    const grid = sheetGrid(sheet);
    const model = buildReportModel(FIXED);

    expect(grid[0]).toEqual([...REPORT_COLUMNS]);
    expect(grid).toHaveLength(model.rows.length + 1);
    // eachRow skips empty rows, so also pin the sheet's real row count.
    expect(sheet.rowCount).toBe(model.rows.length + 1);
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
    expect(sheet.getCell('A1').value).toBe('Initiative Name');
    expect(sheet.getCell('H1').value).toBe('Last Updated');
    expect(sheet.getCell('A2').value).toBe(model.rows[0].name);
    expect(sheet.getCell('C2').value).toBe(model.rows[0].annualRunRate);
    expect(sheet.getCell('C2').type).toBe(ExcelJS.ValueType.Number);
  });

  it('stamps workbook metadata from the report clock, not library defaults', async () => {
    const book = await readBook(await buildReportWorkbook(FIXED));
    expect(book.creator).toBe('Ratio');
    expect(book.lastModifiedBy).toBe('Ratio');
    expect(book.created?.toISOString()).toBe(FIXED.toISOString());
    expect(book.modified?.toISOString()).toBe(FIXED.toISOString());
  });

  it('auto-fits column widths', async () => {
    const buffer = await buildReportWorkbook(FIXED);
    const sheet = (await readBook(buffer)).worksheets[0];
    const grid = sheetGrid(sheet);
    expect(sheet.columns).toHaveLength(REPORT_COLUMNS.length);
    REPORT_COLUMNS.forEach((_, c) => {
      // Widest cell in the column (header included) + 2 chars of padding.
      const widest = Math.max(...grid.map((r) => String(r[c]).length));
      expect(sheet.getColumn(c + 1).width).toBe(widest + 2);
    });
  });
});

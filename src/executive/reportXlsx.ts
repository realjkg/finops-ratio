// XLSX export (Ratio v2 Wave 2b). ExcelJS workbook with the eight user-approved
// columns, sourced from the shared report view-model. Auto-fit column widths so
// a board reviewer never has to widen a column by hand. Server-only: imported
// exclusively by the /api/report/snapshot route. Write-only: nothing here parses
// external spreadsheet input.

import ExcelJS from 'exceljs';
import { buildReportModel, type ReportRow } from './reportModel';

// Exact, user-approved column order. Exported so tests assert the header row.
export const REPORT_COLUMNS = [
  'Initiative Name',
  'Monthly Cost ($)',
  'Annual Run Rate ($)',
  'Budget Consumed (%)',
  'Status',
  'Cost Efficiency Score',
  'Savings Opportunity ($)',
  'Last Updated',
] as const;

type ReportRecord = Record<(typeof REPORT_COLUMNS)[number], string | number>;

function toRecord(row: ReportRow): ReportRecord {
  return {
    'Initiative Name': row.name,
    'Monthly Cost ($)': row.monthlyCost,
    'Annual Run Rate ($)': row.annualRunRate,
    'Budget Consumed (%)': row.budgetConsumedPct,
    Status: row.status,
    'Cost Efficiency Score': Number(row.costEfficiency.toFixed(1)),
    'Savings Opportunity ($)': row.savingsOpportunity,
    'Last Updated': row.lastUpdated,
  };
}

// Width = widest cell (header included) + small padding, in character units.
function autoWidths(records: ReportRecord[]): number[] {
  return REPORT_COLUMNS.map((col) => {
    const widest = records.reduce(
      (max, rec) => Math.max(max, String(rec[col]).length),
      col.length,
    );
    return widest + 2;
  });
}

export async function buildReportWorkbook(now: Date = new Date()): Promise<Buffer> {
  const { rows } = buildReportModel(now);
  const records = rows.map(toRecord);
  const widths = autoWidths(records);

  const book = new ExcelJS.Workbook();
  // Stamp the workbook from the same clock that produced the report data,
  // not library defaults ("Unknown" author, build-time timestamps).
  book.creator = 'Ratio';
  book.lastModifiedBy = 'Ratio';
  book.created = now;
  book.modified = now;
  const sheet = book.addWorksheet('Initiatives');
  // Assigning `columns` writes the header row (row 1) from each `header`.
  sheet.columns = REPORT_COLUMNS.map((col, i) => ({
    header: col,
    key: col,
    width: widths[i],
  }));
  sheet.addRows(records);

  return Buffer.from(await book.xlsx.writeBuffer());
}

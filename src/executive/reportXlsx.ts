// XLSX export (Ratio v2 Wave 2b). ExcelJS workbook with the eight user-approved
// columns, sourced from the shared report view-model. Auto-fit column widths so
// a board reviewer never has to widen a column by hand. Server-only: imported
// exclusively by the /api/report/snapshot route. Write-only: nothing here parses
// external spreadsheet input.

import ExcelJS from 'exceljs';
import { COST_CATEGORIES } from '@/outcomes/types';
import { monetaryBenefit } from '@/outcomes/model';
import { buildReportModel, type ReportRow, type ReportModel } from './reportModel';

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

export async function buildReportWorkbook(now: Date = new Date(), model: ReportModel = buildReportModel(now)): Promise<Buffer> {
  const { rows } = model;
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
  if (model.periodLabel.startsWith('SIMULATED')) {
    const notes = book.addWorksheet('Context');
    notes.addRows([['Report period', model.periodLabel], ['Generated', model.generatedAt], ['Savings', 'Projected opportunity, not realized savings']]);
    notes.getColumn(1).width = 24; notes.getColumn(2).width = 100;
  }

  if (model.outcomeReports) {
    const add = (name: string, headers: string[], rows: (string | number | null)[][]) => {
      const s = book.addWorksheet(name); s.addRow(headers); s.addRows(rows); s.views = [{ state: 'frozen', ySplit: 1 }];
      s.getRow(1).font = { bold: true }; headers.forEach((_, i) => { s.getColumn(i + 1).width = Math.min(55, Math.max(18, headers[i].length + 2)); });
    };
    add('Outcomes', ['Initiative', 'Owner', 'Owner role', 'Metric', 'Unit', 'Baseline', 'Baseline start', 'Baseline end', 'Baseline evidence', 'Observed', 'Observation start', 'Observation end', 'Observation evidence', 'Target', 'Direction', 'Performance recorded by', 'Performance verified by', 'Performance verified at', 'Full cost USD', 'Measured benefit USD', 'Measured benefit-cost ratio', 'Net ROI pct', 'Suggested decision', 'Stop below ratio', 'Continue at ratio', 'Expand at ratio', 'Decision stale'], model.outcomeReports.map(({ name, record: r, result: e, decisionStale }) => [name, r.owner, r.ownerRole, r.metric, r.unit, r.baseline.value, r.baseline.start, r.baseline.end, r.baseline.reference, r.observation.value, r.observation.start, r.observation.end, r.observation.reference, r.target, r.direction, r.planRecordedBy ?? '', r.planVerified?.by ?? '', r.planVerified?.at ?? '', e.totalCostCents === null ? null : e.totalCostCents / 100, e.measuredBenefitCents / 100, e.measuredRatio, e.netRoiPct, e.recommendation, r.thresholds.stopBelow, r.thresholds.continueAt, r.thresholds.expandAt, String(decisionStale)]));
    add('Value Evidence', ['Initiative', 'Measure', 'Category', 'Status', 'Amount USD', 'Margin pct', 'Attribution pct', 'Attributed benefit USD', 'Evidence', 'Method', 'Recorded by', 'Verified by', 'Verified at'], model.outcomeReports.flatMap(({ name, record }) => record.measures.map(m => [name, m.title, m.category, m.status, m.amountCents === null ? null : m.amountCents / 100, m.contributionMarginPct, m.attributionPct, monetaryBenefit(m) / 100, m.reference, m.method, m.recordedBy, m.verified?.by ?? '', m.verified?.at ?? ''])));
    add('Full Costs', ['Initiative', 'Category', 'Amount USD', 'Status', 'Evidence', 'Period start', 'Period end', 'Recorded by', 'Verified by', 'Verified at'], model.outcomeReports.flatMap(({ name, record, result }) => [[name, 'model_usage', result.modelCents / 100, 'recorded simulated ledger', 'Source ledger', record.observation.start, record.observation.end, 'Connector ledger', 'Source-controlled import', ''], ...COST_CATEGORIES.map(k => [name, k, record.costs[k].cents === null ? null : record.costs[k].cents! / 100, record.costs[k].status, record.costs[k].reference, record.observation.start, record.observation.end, record.costs[k].recordedBy ?? '', record.costs[k].verified?.by ?? '', record.costs[k].verified?.at ?? ''])]));
    add('Decision History', ['Initiative', 'Decision', 'Rationale', 'Reviewer', 'Recorded at', 'Suggested decision at review'], model.outcomeReports.flatMap(({ name, record }) => record.decisions.map(d => [name, d.action, d.rationale, d.by, d.at, d.recommendation])));
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

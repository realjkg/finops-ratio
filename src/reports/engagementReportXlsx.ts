// Engagement report XLSX (1.0): renders the engagement report model, one
// worksheet per section, with ExcelJS (the existing XLSX stack). Server-only:
// imported only through the /api/v1/reports/engagement route.
//
// Money convention (owner: amounts exact): every cell is a TEXT cell ('@')
// holding the model's string. Unlike the demo report (src/executive/
// reportXlsx.ts, which writes JS numbers), no amount is converted to a binary
// float, so 18.00663861840 stays 18.00663861840; there are no formulas, so no
// spreadsheet total can disagree with the report's.
import ExcelJS from 'exceljs';
import type { EngagementReportModel } from './engagementReportModel';

export async function renderEngagementReportXlsx(model: EngagementReportModel): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const at = new Date(model.generatedAt);
  book.creator = 'Ratio';
  book.lastModifiedBy = 'Ratio';
  book.created = at;
  book.modified = at;
  book.title = model.title;
  for (const s of model.sections) {
    const ws = book.addWorksheet(s.title);
    for (const values of [s.columns, ...s.rows]) {
      const r = ws.addRow(values.map((v) => (v === '' ? null : v))); // an empty Note stays an empty cell
      r.eachCell({ includeEmpty: false }, (c) => {
        c.numFmt = '@';
      });
    }
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    s.columns.forEach((name, i) => {
      const widest = Math.max(name.length, ...s.rows.map((r) => (r[i] ?? '').length));
      ws.getColumn(i + 1).width = Math.min(80, Math.max(10, widest + 2));
    });
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

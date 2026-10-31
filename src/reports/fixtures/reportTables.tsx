// Test-only helpers for the UI/XLSX/PDF agreement test: the four cases and the three readers that turn each
// rendering back into per-section tables of cell texts. SYNTHETIC data only.
import ExcelJS from 'exceljs';
import { render } from '@testing-library/react';
import { assembleReportFacts } from '../reportFacts';
import { buildEngagementReportModel, type EngagementReportModel, type ReportSection } from '../engagementReportModel';
import { renderEngagementReportXlsx } from '../engagementReportXlsx';
import { EngagementReportDocument, pdfGlyphText, pdfLayout } from '../engagementReportPdf';
import { EngagementReportView } from '../EngagementReportView';
import { ENGAGEMENT, g, SRC_B, sampleInput } from './sampleFacts';
import { treeTexts } from './pdfText';

export type Table = string[][]; // header row, then data rows

export const CASES: Record<string, () => EngagementReportModel> = {
  'sample AWS 2024-09': () => buildEngagementReportModel(assembleReportFacts(sampleInput()), ENGAGEMENT),
  'no published data, no engagement config': () => buildEngagementReportModel(assembleReportFacts(sampleInput({ groups: [], batches: [], artifacts: [], engagement: null })), null),
  'two sources, two currencies, partial effective': () =>
    buildEngagementReportModel(
      assembleReportFacts(
        sampleInput({
          groups: [g({ effectiveCost: '12.00000000000', effectiveMissingRows: '2' }), g({ isTotal: false, chargeCategory: 'Usage' }), g({ sourceId: SRC_B, currency: 'EUR', billedCost: '7.00', effectiveCost: '7.00' }), g({ sourceId: SRC_B, currency: 'EUR', isTotal: false, chargeCategory: 'Usage', billedCost: '7.00', effectiveCost: '7.00' })],
          batches: [...sampleInput().batches, { ...sampleInput().batches[0], sourceId: SRC_B, batchId: 'bbbbbbbb-0000-4000-8000-000000000002' }],
        }),
      ),
      ENGAGEMENT,
    ),
  'hostile text': () => buildEngagementReportModel(assembleReportFacts(sampleInput({ groups: [g({}), g({ isTotal: false, chargeCategory: `bad￿中😀${'x'.repeat(40_000)}` })] })), { ...ENGAGEMENT, displayName: 'nul\u0000 Ünïcode' }),
};

export function uiTables(m: EngagementReportModel): Record<string, Table> {
  const { container } = render(<EngagementReportView model={m} />);
  const out: Record<string, Table> = {};
  for (const s of m.sections) {
    const table = container.querySelector(`[data-section="${s.id}"] table`) as HTMLTableElement;
    out[s.id] = [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('th, td')].map((c) => c.textContent ?? ''));
  }
  return out;
}

export async function xlsxTables(m: EngagementReportModel): Promise<Record<string, Table>> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load((await renderEngagementReportXlsx(m)) as unknown as ArrayBuffer);
  const out: Record<string, Table> = {};
  for (const s of m.sections) {
    const rows: Table = [];
    book.getWorksheet(s.title)!.eachRow((r) => rows.push(s.columns.map((_, i) => String(r.getCell(i + 1).value ?? ''))));
    out[s.id] = rows;
  }
  return out;
}

/** Rebuilds a section's table from the PDF element tree (table: header + rows; records: "column, value" pairs). */
export function pdfTable(m: EngagementReportModel, s: ReportSection): Table {
  const texts = treeTexts(<EngagementReportDocument model={{ ...m, sections: [s] }} />).slice(2).filter((t) => !t.startsWith('PDF font: ') && !t.startsWith('PDF length limit: '));
  const n = s.columns.length;
  if (pdfLayout(s) === 'table') return Array.from({ length: texts.length / n }, (_, i) => texts.slice(i * n, i * n + n));
  const rows: Table = [s.columns.map(pdfGlyphText)];
  for (let i = 0; i < texts.length; i += 2) {
    if (texts[i] === pdfGlyphText(s.columns[0])) rows.push(Array.from({ length: n }, () => ''));
    rows[rows.length - 1][s.columns.map(pdfGlyphText).indexOf(texts[i])] = texts[i + 1];
  }
  return rows;
}

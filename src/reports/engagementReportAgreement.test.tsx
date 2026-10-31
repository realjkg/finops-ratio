// @vitest-environment jsdom
// UI / XLSX / PDF agreement (owner: the three agree on amounts, exclusions,
// missing values, periods and assumptions). For each case the ONE engagement
// report model is rendered three ways and the cell texts are read back per
// section: the UI table (React Testing Library), the XLSX sheet (ExcelJS) and
// the PDF element tree. They must be identical, cell for cell. The only allowed
// PDF difference is the disclosed glyph fallback ('?' for characters the
// built-in PDF font cannot draw), applied to the UI text before comparing.
import ExcelJS from 'exceljs';
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { assembleReportFacts, NA_REASONS } from './reportFacts';
import { ALTERED_CELLS_ITEM, buildEngagementReportModel, type EngagementReportModel, type ReportSection } from './engagementReportModel';
import { renderEngagementReportXlsx } from './engagementReportXlsx';
import { EngagementReportDocument, pdfGlyphText, pdfLayout } from './engagementReportPdf';
import { EngagementReportView } from './EngagementReportView';
import { ENGAGEMENT, g, SRC_B, sampleInput } from './fixtures/sampleFacts';
import { treeTexts } from './fixtures/pdfText';

type Table = string[][]; // header row, then data rows

const CASES: Record<string, () => EngagementReportModel> = {
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

function uiTables(m: EngagementReportModel): Record<string, Table> {
  const { container } = render(<EngagementReportView model={m} />);
  const out: Record<string, Table> = {};
  for (const s of m.sections) {
    const table = container.querySelector(`[data-section="${s.id}"] table`) as HTMLTableElement;
    out[s.id] = [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('th, td')].map((c) => c.textContent ?? ''));
  }
  return out;
}

async function xlsxTables(m: EngagementReportModel): Promise<Record<string, Table>> {
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
function pdfTable(m: EngagementReportModel, s: ReportSection): Table {
  const texts = treeTexts(<EngagementReportDocument model={{ ...m, sections: [s] }} />).slice(2).filter((t) => !t.startsWith('PDF font: '));
  const n = s.columns.length;
  if (pdfLayout(s) === 'table') return Array.from({ length: texts.length / n }, (_, i) => texts.slice(i * n, i * n + n));
  const rows: Table = [s.columns.map(pdfGlyphText)];
  for (let i = 0; i < texts.length; i += 2) {
    if (texts[i] === pdfGlyphText(s.columns[0])) rows.push(Array.from({ length: n }, () => ''));
    rows[rows.length - 1][s.columns.map(pdfGlyphText).indexOf(texts[i])] = texts[i + 1];
  }
  return rows;
}

afterEach(cleanup);

describe('UI, XLSX and PDF show identical cell texts per section', () => {
  for (const [name, build] of Object.entries(CASES)) {
    it(name, async () => {
      const m = build();
      const ui = uiTables(m);
      const xlsx = await xlsxTables(m);
      for (const s of m.sections) {
        const expected = [s.columns, ...s.rows];
        expect(ui[s.id], `${s.id}: UI`).toEqual(expected);
        expect(xlsx[s.id], `${s.id}: XLSX`).toEqual(expected);
        expect(pdfTable(m, s), `${s.id}: PDF`).toEqual(expected.map((r) => r.map(pdfGlyphText)));
      }
    });
  }

  it('the UI always shows the last-published-batch warning and every N/A reason; never a 0 for missing data', () => {
    const m = CASES['no published data, no engagement config']();
    const { getByRole, container } = render(<EngagementReportView model={m} />);
    expect(within(getByRole('note', { name: 'Data status' })).getByText(NA_REASONS.batchStatus)).toBeTruthy();
    for (const reason of [NA_REASONS.noPublished, NA_REASONS.noEngagement]) expect(container.textContent).toContain(reason);
    expect([...container.querySelectorAll('td')].map((td) => td.textContent).filter((t) => /^-?0(\.0+)?$/.test(t ?? ''))).toEqual([]);
  });

  it('wide tables are keyboard-scrollable labeled regions; the altered-cells row is shown when text was altered', () => {
    const m = CASES['hostile text']();
    const { getAllByRole, container } = render(<EngagementReportView model={m} />);
    const regions = getAllByRole('region');
    expect(regions.map((r) => r.getAttribute('aria-label'))).toEqual(m.sections.map((s) => s.title));
    for (const r of regions) expect(r.getAttribute('tabindex')).toBe('0');
    expect(container.textContent).toContain(ALTERED_CELLS_ITEM);
  });
});

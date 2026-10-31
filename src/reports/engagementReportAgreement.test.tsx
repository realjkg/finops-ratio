// @vitest-environment jsdom
// UI / XLSX / PDF agreement (owner: the three agree on amounts, exclusions,
// missing values, periods and assumptions). For each case the ONE engagement
// report model is rendered three ways and the cell texts are read back per
// section: the UI table (React Testing Library), the XLSX sheet (ExcelJS) and
// the PDF element tree. They must be identical, cell for cell. The PDF's only
// allowed differences are the ones it discloses on page 1 (#159): the glyph
// fallback ('?' for characters its built-in font cannot draw) on every cell, and,
// on DATA cells only (imported or configured free text, DATA_TEXT_CELLS), the
// per-cell cap with its marker. Every other cell must match exactly.
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NA_REASONS } from './reportFacts';
import { ALTERED_CELLS_ITEM, DATA_TEXT_CELLS, type ReportSection } from './engagementReportModel';
import { EngagementReportDocument, PDF_CELL_MAX_CHARS, PDF_MODEL_TEXT_MAX_CHARS, PDF_TOTAL_MAX_CHARS, PDF_TRUNCATION_MARKER, PDF_TRUNCATION_NOTE, pdfGlyphText } from './engagementReportPdf';
import { EngagementReportView } from './EngagementReportView';
import { treeTexts } from './fixtures/pdfText';
import { CASES, pdfTable, uiTables, xlsxTables } from './fixtures/reportTables';

const isData = (s: ReportSection, row: string[], i: number) =>
  s.id === 'summary' ? i === 1 && DATA_TEXT_CELLS.summaryItems.includes(row[0]) : (DATA_TEXT_CELLS.columns[s.id] ?? []).includes(s.columns[i]);

/** What the PDF must show for one cell (these cases stay under the document budget, asserted per case). */
function pdfExpected(s: ReportSection, row: string[], i: number): string {
  const g = pdfGlyphText(row[i]);
  if (!isData(s, row, i) || g.length <= PDF_CELL_MAX_CHARS) return g;
  return `${g.slice(0, PDF_CELL_MAX_CHARS)}${PDF_TRUNCATION_MARKER(g.length - PDF_CELL_MAX_CHARS)}`;
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
        expect(pdfTable(m, s), `${s.id}: PDF`).toEqual([s.columns.map(pdfGlyphText), ...s.rows.map((r) => r.map((_, i) => pdfExpected(s, r, i)))]);
      }
      // The caps cut only DATA cells here: the document budget is not reached and no model text hits its ceiling.
      const cells = m.sections.flatMap((s) => s.rows.flatMap((r) => r.map((c, i) => ({ g: pdfGlyphText(c), data: isData(s, r, i) }))));
      expect(cells.filter((c) => c.data).reduce((n, c) => n + Math.min(c.g.length, PDF_CELL_MAX_CHARS), 0)).toBeLessThan(PDF_TOTAL_MAX_CHARS);
      expect(cells.filter((c) => !c.data && c.g.length > PDF_MODEL_TEXT_MAX_CHARS)).toEqual([]);
      const cut = cells.filter((c) => c.data && c.g.length > PDF_CELL_MAX_CHARS).length;
      const notes = treeTexts(<EngagementReportDocument model={m} />).filter((t) => t.startsWith('PDF length limit: '));
      expect(notes, 'the page-1 truncation count').toEqual(cut ? [PDF_TRUNCATION_NOTE(cut)] : []);
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

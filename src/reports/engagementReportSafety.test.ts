// Cell-text safety of the ONE engagement report model (shared by XLSX, PDF and
// UI): characters XML 1.0 forbids become U+FFFD, text over Excel's 32,767-
// character cell limit is truncated with a visible marker, and the report says
// how many cell values were altered (never silently). The XLSX must open in
// ExcelJS AND parse as well-formed XML in a second, independent parser.
// SYNTHETIC hostile values only.
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { describe, expect, it } from 'vitest';
import { assembleReportFacts, type ReportFacts } from './reportFacts';
import { ALTERED_CELLS_ITEM, buildEngagementReportModel, MAX_CELL_CHARS, safeCellText, type EngagementReportModel } from './engagementReportModel';
import { renderEngagementReportXlsx } from './engagementReportXlsx';
import { ENGAGEMENT, g, sampleInput } from './fixtures/sampleFacts';

const LONG = 'x'.repeat(40_000);
const HOSTILE = ['bad￿cat', 'bad￾cat', 'lone\uD800surrogate', 'nul\u0000here', 'vt\u000Bff\u000C', LONG];

describe('safeCellText', () => {
  it('replaces every character XML 1.0 forbids with U+FFFD and keeps tab, LF, CR and valid pairs', () => {
    expect(safeCellText('a\u0000b\u0008c\u000Bd\u000Ce\u000Ef\u001Fg')).toEqual({ text: 'a�b�c�d�e�f�g', altered: true });
    expect(safeCellText('x￾y￿z')).toEqual({ text: 'x�y�z', altered: true });
    expect(safeCellText('a\uD800b\uDC00c')).toEqual({ text: 'a�b�c', altered: true });
    expect(safeCellText('tab\tlf\ncr\r😀 é')).toEqual({ text: 'tab\tlf\ncr\r😀 é', altered: false });
  });

  it('caps a cell at 32,767 characters with a visible marker giving the count removed', () => {
    const r = safeCellText(LONG);
    expect(MAX_CELL_CHARS).toBe(32_767);
    expect(r.altered).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(MAX_CELL_CHARS);
    const removed = 40_000 - r.text.indexOf('...');
    expect(r.text.endsWith(`... [truncated ${removed} characters]`)).toBe(true);
    expect(safeCellText('y'.repeat(MAX_CELL_CHARS))).toEqual({ text: 'y'.repeat(MAX_CELL_CHARS), altered: false });
  });
});

function hostileFacts(value: string): { facts: ReportFacts; label: { id: string; displayName: string } } {
  const facts = assembleReportFacts(
    sampleInput({
      groups: [g({}), g({ isTotal: false, chargeCategory: value })],
      engagement: { currency: 'USD', declaredSources: [{ id: value, provider: value, costBasis: 'focus-native', creditsCoverage: 'included', completeness: 'explicit-subset', controlTotalSource: 'export-query' }] },
    }),
  );
  facts.coverageGaps.push({ code: 'SYNTHETIC_GAP', detail: value });
  return { facts, label: { ...ENGAGEMENT, displayName: value } };
}
const cells = (m: EngagementReportModel) => m.sections.flatMap((s) => [s.columns, ...s.rows]).flat();

async function wellFormedParts(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => n.endsWith('.xml'));
  for (const n of names) {
    const parser = new SaxesParser();
    parser.on('error', (e) => {
      throw new Error(`${n}: ${e.message}`);
    });
    parser.write(await zip.file(n)!.async('string')).close();
  }
  return names;
}

describe('hostile data values (ChargeCategory, declared source, engagement displayName, gap detail)', () => {
  for (const value of HOSTILE) {
    const label = value === LONG ? '40,000 characters' : JSON.stringify(value);
    it(`${label}: every model cell is safe, the alteration is reported, and the XLSX is well-formed in two parsers`, async () => {
      const { facts, label: eng } = hostileFacts(value);
      const m = buildEngagementReportModel(facts, eng);
      for (const c of cells(m)) {
        expect(c.length).toBeLessThanOrEqual(MAX_CELL_CHARS);
        expect(safeCellText(c).altered, 'a model cell is still unsafe').toBe(false);
      }
      const note = m.sections[0].rows.find((r) => r[0] === ALTERED_CELLS_ITEM);
      expect(note?.[1]).toMatch(/^\d+ cell values? (was|were) altered for safe display/);
      expect(Number(note?.[1].split(' ')[0])).toBeGreaterThanOrEqual(4);
      const buf = await renderEngagementReportXlsx(m);
      expect((await wellFormedParts(buf)).some((n) => n.includes('sharedStrings') || n.includes('sheet'))).toBe(true);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(buf as unknown as ArrayBuffer);
      expect(book.getWorksheet('Charge categories')!.getRow(2).getCell(3).value).toBe(safeCellText(value).text);
      expect(book.getWorksheet('Report')!.getRow(2).getCell(2).value).toBe(safeCellText(`${value} (example-engagement)`).text);
    });
  }

  it('normal data is not altered and carries no alteration row', () => {
    const m = buildEngagementReportModel(assembleReportFacts(sampleInput()), ENGAGEMENT);
    expect(m.sections[0].rows.find((r) => r[0] === ALTERED_CELLS_ITEM)).toBeUndefined();
  });
});

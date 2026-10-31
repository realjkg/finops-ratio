// Engagement report PDF: rendered from the ONE engagement report model with the
// existing @react-pdf stack. Checked two ways without a PDF library: the element
// tree (every section title, column and cell text in order, verbatim) and the
// produced bytes (inflated content streams carry the exact amount strings).
import { describe, expect, it } from 'vitest';
import { assembleReportFacts } from './reportFacts';
import { buildEngagementReportModel, type EngagementReportModel } from './engagementReportModel';
import { EngagementReportDocument, PDF_GLYPH_NOTE, pdfGlyphText, pdfLayout, renderEngagementReportPdf } from './engagementReportPdf';
import { ENGAGEMENT, g, sampleInput } from './fixtures/sampleFacts';
import { pageCount, pdfShownStrings, treeTexts } from './fixtures/pdfText';

const sample = () => buildEngagementReportModel(assembleReportFacts(sampleInput()), ENGAGEMENT);
const nonEmpty = (xs: string[]) => xs.filter((x) => x !== '');
/** What the PDF must show, in order: tables print the header then the cells; record blocks print "column, value" pairs (empty Notes omitted). */
const modelTexts = (m: EngagementReportModel) =>
  nonEmpty(
    m.sections
      .flatMap((s) => [s.title, ...(pdfLayout(s) === 'table' ? [...s.columns, ...s.rows.flat()] : s.rows.flatMap((r) => r.flatMap((v, i) => (v === '' ? [] : [s.columns[i], v])))) ])
      .map(pdfGlyphText),
  );

/** `want` appears in `have` in order (other texts, e.g. page furniture, may sit between). */
function expectSubsequence(have: string[], want: string[]) {
  let i = 0;
  for (const h of have) if (i < want.length && h === want[i]) i += 1;
  expect(want.slice(i, i + 1), `missing or out of order after ${i} of ${want.length}`).toEqual([]);
}

describe('engagement report PDF', () => {
  it('the element tree shows every section title, column and cell of the model, verbatim and in order', () => {
    const m = sample();
    const texts = nonEmpty(treeTexts(<EngagementReportDocument model={m} />));
    expectSubsequence(texts, modelTexts(m));
    expect(texts).toContain(m.title);
    expect(texts).not.toContain(PDF_GLYPH_NOTE(1));
  });

  it('the PDF bytes carry the exact amounts, N/A and the scope label start (no rounding, no number formatting)', async () => {
    const pdf = await renderEngagementReportPdf(sample());
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const shown = pdfShownStrings(pdf).join('\n');
    for (const s of ['18.00663861840', '13.00000000000', '-2.61370000000', '-3.00000000000', '20.62033861840', '942', 'N/A', 'USD']) expect(shown, s).toContain(s);
    expect(shown).not.toMatch(/18\.01\b|\$18/);
  });

  it('characters outside the built-in PDF font are shown as a visible ? and disclosed; Windows-1252 text is kept', () => {
    expect(pdfGlyphText('café – “x” €5')).toBe('café – “x” €5');
    expect(pdfGlyphText('a�b中😀c')).toBe('a?b??c');
    const facts = assembleReportFacts(sampleInput({ groups: [g({}), g({ isTotal: false, chargeCategory: 'Usage 中￿' })] }));
    const m = buildEngagementReportModel(facts, { ...ENGAGEMENT, displayName: 'Ünïcode 😀' });
    const texts = nonEmpty(treeTexts(<EngagementReportDocument model={m} />));
    expect(texts).toContain('Usage ??');
    expect(texts).toContain('Ünïcode ? (example-engagement)');
    expect(texts).toContain(PDF_GLYPH_NOTE(2));
    expectSubsequence(texts, modelTexts(m));
  });

  it('long sections paginate with the section heading repeated; long unbroken cells wrap instead of overflowing', async () => {
    const many = Array.from({ length: 160 }, (_, i) => g({ isTotal: false, chargeCategory: `Category ${String(i).padStart(3, '0')}`, billedCost: '0.01', effectiveCost: '0.01', rowCount: '1' }));
    const m = buildEngagementReportModel(assembleReportFacts(sampleInput({ groups: [g({}), ...many] })), { ...ENGAGEMENT, displayName: 'y'.repeat(400) });
    const pdf = await renderEngagementReportPdf(m);
    const shown = pdfShownStrings(pdf);
    expect(pageCount(pdf)).toBeGreaterThan(m.sections.length);
    expect(shown.filter((s) => s === 'Charge categories').length, 'the section title repeats on every page').toBeGreaterThan(1);
    expect(shown.filter((s) => s === 'Item').length, 'a table header repeats only within its section').toBe(1);
    expect(shown.some((s) => s.includes('Category 159'))).toBe(true);
    expect(Math.max(...shown.map((s) => s.length))).toBeLessThan(200);
  }, 30_000); // a 160-row layout takes a few seconds under full-suite load
});

// Engagement report PDF: rendered from the ONE engagement report model with the
// existing @react-pdf stack. Checked two ways without a PDF library: the element
// tree (every section title, column and cell text in order, verbatim) and the
// produced bytes (inflated content streams carry the exact amount strings).
import { spawnSync } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { assembleReportFacts, NA_REASONS } from './reportFacts';
import { buildEngagementReportModel, type EngagementReportModel } from './engagementReportModel';
import { EngagementReportDocument, PDF_CELL_FLOOR_CHARS, PDF_CELL_MAX_CHARS, PDF_GLYPH_NOTE, PDF_TOTAL_MAX_CHARS, PDF_TRUNCATION_NOTE, pdfGlyphText, pdfLayout, renderEngagementReportPdf } from './engagementReportPdf';
import { ENGAGEMENT, g, sampleInput } from './fixtures/sampleFacts';
import { pageCount, pdfPageStrings, pdfShownStrings, treeTexts } from './fixtures/pdfText';

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

  it('bounds PDF text: each cell at PDF_CELL_MAX_CHARS and the document at PDF_TOTAL_MAX_CHARS, with a visible marker and a page-1 count', () => {
    expect([PDF_CELL_MAX_CHARS, PDF_TOTAL_MAX_CHARS]).toEqual([2_000, 100_000]);
    const groups = [g({}), ...Array.from({ length: 64 }, (_, i) => g({ isTotal: false, chargeCategory: `c${i} `.repeat(1_000), rowCount: '1', billedCost: '0.01', effectiveCost: '0.01' }))];
    const m = buildEngagementReportModel(assembleReportFacts(sampleInput({ groups })), ENGAGEMENT);
    const texts = treeTexts(<EngagementReportDocument model={m} />);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(PDF_CELL_MAX_CHARS + 80);
    expect(texts.join('').length).toBeLessThan(PDF_TOTAL_MAX_CHARS + 64 * 80 + 20_000);
    const first = texts.find((t) => t.startsWith('c0 '))!;
    expect(first).toMatch(/\.\.\. \[truncated \d+ characters; see XLSX\/JSON for the full text\]$/);
    const notes = texts.filter((t) => t.startsWith('PDF length limit: '));
    expect(notes).toHaveLength(1);
    // The 64 long categories, plus long notes that come after the document budget is spent (they keep 200 characters).
    expect(Number(/^PDF length limit: (\d+) /.exec(notes[0])?.[1])).toBeGreaterThanOrEqual(64);
    expect(PDF_TRUNCATION_NOTE(2)).toMatch(/^PDF length limit: 2 cell values were truncated .*XLSX and JSON carry the full text\.$/);
    // The shared model is untouched: XLSX and the screen keep the full text.
    expect(m.sections.find((s) => s.id === 'chargeCategories')!.rows[0][2].length).toBeGreaterThan(PDF_CELL_MAX_CHARS);
  });

  for (const kind of ['spaced', 'unbroken'] as const) {
    it(`a hostile 64 x 32,000-character ${kind} input renders within 15 s and bounded memory (external watchdog)`, () => {
      const child = path.join(__dirname, 'fixtures', 'pdfRenderChild.tsx');
      const r = spawnSync(process.execPath, ['--import', 'tsx', child, kind], { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' });
      expect(r.signal, 'killed by the watchdog: the render did not finish in time').toBeNull();
      const out = JSON.parse(r.stdout.trim()) as { ms: number; rss: number; bytes: number };
      expect(out.rss).toBeLessThan(700 * 1024 * 1024);
      expect(out.bytes).toBeGreaterThan(0);
    }, 20_000);
  }

  it('wide-section records never split across pages: every page with an amount line also shows its record key', async () => {
    const note = 'context '.repeat(40);
    const groups = Array.from({ length: 30 }, (_, i) => g({ currency: `C${String(i).padStart(2, '0')}`.slice(0, 3).replace(/\d/g, (d) => 'ABCDEFGHIJ'[Number(d)]), effectiveMissingRows: '1', effectiveCost: `1.${i}` }));
    const m = buildEngagementReportModel(assembleReportFacts(sampleInput({ groups })), { ...ENGAGEMENT, displayName: note });
    const pages = pdfPageStrings(await renderEngagementReportPdf(m));
    const totalsPages = pages.filter((p) => p.includes('Totals by currency'));
    expect(totalsPages.length).toBeGreaterThan(1);
    for (const p of totalsPages) expect(p.filter((t) => t === 'Billed cost').length, p.join('|').slice(0, 200)).toBe(p.filter((t) => t === 'Currency').length);
  }, 30_000);

  it('the summary and coverage-gap tables carry their Note column and reasons; the font note sits on page 1 after the summary', () => {
    const facts = assembleReportFacts(sampleInput({ groups: [], batches: [], artifacts: [], engagement: null }));
    const m = buildEngagementReportModel(facts, { id: 'x', displayName: 'Ünïcode 😀' });
    const texts = treeTexts(<EngagementReportDocument model={m} />);
    const summary = m.sections[0];
    const noted = summary.rows.find((r) => r.at(-1) !== '')!;
    expect(texts).toContain(noted.at(-1));
    const gapsStart = texts.indexOf('Coverage gaps');
    expect(texts.slice(gapsStart, gapsStart + 5)).toEqual(['Coverage gaps', 'Code', 'Detail', 'Note', 'NO_PUBLISHED_BATCH']);
    const noteAt = texts.indexOf(PDF_GLYPH_NOTE(1));
    expect(noteAt).toBeGreaterThan(texts.indexOf(summary.rows.at(-1)![1]));
    expect(noteAt).toBeLessThan(texts.indexOf(m.sections[1].title));
  });

  it('PDF dates are the report instant, not the wall clock', async () => {
    const raw = (await renderEngagementReportPdf(sample())).toString('latin1');
    const date = (key: string) => {
      const ref = new RegExp(`/${key} (\\d+) 0 R`).exec(raw)?.[1];
      return new RegExp(`\\n${ref} 0 obj\\n\\((D:[^)]*)\\)`).exec(raw)?.[1];
    };
    expect([date('CreationDate'), date('ModificationDate')]).toEqual(['D:20261031120000Z', 'D:20261031120000Z']);
  });

  describe('the caps apply only to imported or configured free text; model-authored text is never cut', () => {
    // 60 hostile charge categories (data) spend the whole document budget before the later sections.
    const hog = Array.from({ length: 60 }, (_, i) => g({ isTotal: false, chargeCategory: `c${i} ` + 'filler '.repeat(400), rowCount: '1' }));

    it('every Note reason and the last-PUBLISHED warning stay whole after the budget is spent', () => {
      const m = buildEngagementReportModel(assembleReportFacts(sampleInput({ groups: [g({ effectiveMissingRows: '2' }), ...hog] })), ENGAGEMENT);
      const texts = treeTexts(<EngagementReportDocument model={m} />);
      expect(texts.some((t) => t.includes('see XLSX/JSON for the full text'))).toBe(true);
      const notes = m.sections.flatMap((s) => s.rows.map((r) => r.at(-1)!)).filter((n) => n !== '');
      expect(notes.length).toBeGreaterThanOrEqual(3); // totals, source totals (partial effective) and the import Note
      for (const n of notes) expect(texts, n.slice(0, 60)).toContain(pdfGlyphText(n));
      for (const d of m.sections.find((s) => s.id === 'coverageGaps')!.rows.map((r) => r[1])) expect(texts).toContain(d);
      expect(texts.join('\n')).toContain(NA_REASONS.batchStatus);
    });

    it('150 staged-artifact records (no hostile text) keep all 150 import Notes whole', () => {
      const input = sampleInput();
      input.artifacts = Array.from({ length: 150 }, (_, i) => ({ ...input.artifacts[0], artifactSha256: i.toString(16).padStart(64, 'a'), rowCount: '6' }));
      const m = buildEngagementReportModel(assembleReportFacts(input), ENGAGEMENT);
      const texts = treeTexts(<EngagementReportDocument model={m} />);
      const notes = m.sections.find((s) => s.id === 'imports')!.rows.map((r) => r.at(-1)!);
      expect(notes).toHaveLength(150);
      expect(notes.filter((n) => !texts.includes(n))).toEqual([]);
      expect(texts.some((t) => t.startsWith('PDF length limit: '))).toBe(false);
    });

    it(`after the budget is spent a data cell still keeps its first ${PDF_CELL_FLOOR_CHARS} characters`, () => {
      expect(PDF_CELL_FLOOR_CHARS).toBe(200);
      const input = sampleInput({ groups: [g({}), ...hog] });
      const provider = 'p'.repeat(190);
      input.batches[0].providers = [provider];
      const texts = treeTexts(<EngagementReportDocument model={buildEngagementReportModel(assembleReportFacts(input), ENGAGEMENT)} />);
      expect(texts).toContain(provider);
    });

    it('configured free text in the summary (the engagement name) is capped like imported data', () => {
      const m = buildEngagementReportModel(assembleReportFacts(sampleInput()), { ...ENGAGEMENT, displayName: 'n '.repeat(3_000) });
      const cell = treeTexts(<EngagementReportDocument model={m} />).find((t) => t.startsWith('n n '))!;
      expect(cell.length).toBeLessThanOrEqual(PDF_CELL_MAX_CHARS + 80);
      expect(cell).toMatch(/see XLSX\/JSON for the full text\]$/);
    });

    it('a single cut cell gets the singular page-1 note', () => {
      const m = buildEngagementReportModel(assembleReportFacts(sampleInput({ groups: [g({}), g({ isTotal: false, chargeCategory: 'k '.repeat(1_500), rowCount: '1' })] })), ENGAGEMENT);
      const texts = treeTexts(<EngagementReportDocument model={m} />);
      expect(texts.filter((t) => t.startsWith('PDF length limit: '))).toEqual([PDF_TRUNCATION_NOTE(1)]);
      expect(PDF_TRUNCATION_NOTE(1)).toMatch(/^PDF length limit: 1 cell value was truncated /);
    });
  });
});


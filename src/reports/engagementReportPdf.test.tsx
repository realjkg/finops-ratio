// Engagement report PDF: rendered from the ONE engagement report model with the
// existing @react-pdf stack and the bundled Noto fonts. Checked two ways without a
// PDF library: the element tree (every section title, column and cell text in
// order, verbatim) and the produced bytes (inflated content streams decoded
// through the embedded fonts' ToUnicode maps carry the exact strings).
import { spawnSync } from 'child_process';
import path from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { assembleReportFacts, NA_REASONS } from './reportFacts';
import { buildEngagementReportModel, type EngagementReportModel } from './engagementReportModel';
import {
  breakLong,
  EngagementReportDocument,
  PDF_CELL_FLOOR_CHARS,
  PDF_CELL_MAX_CHARS,
  PDF_GLYPH_NOTE,
  PDF_TOTAL_MAX_CHARS,
  PDF_TRUNCATION_NOTE,
  PDF_UNSUPPORTED_MESSAGE,
  PDF_UNSUPPORTED_TEXT_POLICY,
  pdfGlyphText,
  pdfLayout,
  pdfPreflight,
  PdfUnsupportedTextError,
  PDF_CJK_COST,
  PDF_FONT_SWITCH_COST,
  PDF_MAX_CONCURRENT_RENDERS,
  PdfBusyError,
  pdfCutToCost,
  pdfTextCost,
  renderEngagementReportPdf,
} from './engagementReportPdf';
import { loadPdfFonts } from './pdfFonts';
import { ENGAGEMENT, g, sampleInput } from './fixtures/sampleFacts';
import { pageCount, pdfEmbeddedFonts, pdfPageStrings, pdfShownStrings, treeTexts } from './fixtures/pdfText';

beforeAll(() => loadPdfFonts());

const sample = () => buildEngagementReportModel(assembleReportFacts(sampleInput()), ENGAGEMENT);
const nonEmpty = (xs: string[]) => xs.filter((x) => x !== '');
/** What the PDF must show, in order: tables print the header then the cells; record blocks print "column, value" pairs (empty Notes omitted). */
const modelTexts = (m: EngagementReportModel) =>
  nonEmpty(
    m.sections
      .flatMap((s) => [s.title, ...(pdfLayout(s) === 'table' ? [...s.columns, ...s.rows.flat()] : s.rows.flatMap((r) => r.flatMap((v, i) => (v === '' ? [] : [s.columns[i], v])))) ]),
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

  it("the 'substitute' policy draws characters outside the supported scripts as a visible ? and counts them on page 1", () => {
    expect(pdfGlyphText('café – “x” €5 Москва 成本 비용')).toBe('café – “x” €5 Москва 成本 비용');
    expect(pdfGlyphText('a\u0000b中😀c\uE000')).toBe('a?b中?c?');
    const facts = assembleReportFacts(sampleInput({ groups: [g({}), g({ isTotal: false, chargeCategory: 'Usage 中\uE000' })] }));
    const m = buildEngagementReportModel(facts, { ...ENGAGEMENT, displayName: 'Ünïcode 😀' });
    const texts = nonEmpty(treeTexts(<EngagementReportDocument model={m} policy="substitute" />));
    expect(texts).toContain('Usage 中?');
    expect(texts).toContain('Ünïcode ? (example-engagement)');
    expect(texts).toContain(PDF_GLYPH_NOTE(2));
    expectSubsequence(texts, modelTexts(m).map(pdfGlyphText));
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
    const texts = treeTexts(<EngagementReportDocument model={m} policy="substitute" />);
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

describe('bundled fonts: declared scripts render faithfully and extract exactly', () => {
  // SYNTHETIC multi-script data: Latin accents, Cyrillic, Greek, Simplified Chinese, Japanese, Korean, mixed cells.
  const SCRIPTS = ['Éclair Çà ñ ü Øresund ß', 'Москва Счёт', 'Ωμέγα λογαριασμός', '成本报告 云计算费用', 'コスト 請求書', '비용 보고서', 'Mixed: Cost 成本 コスト 비용 Москва Ωμέγα €5'];
  const multi = () => {
    const groups = [
      g({}),
      g({ isTotal: false, chargeCategory: 'Credit', rowCount: '1', billedCost: '-2.61370000000', effectiveCost: '-3.00000000000' }),
      ...SCRIPTS.map((c, i) => g({ isTotal: false, chargeCategory: c, rowCount: String(i + 1), billedCost: `-${i}.25000000000`, effectiveCost: '1.00000000000' })),
      g({ currency: 'EUR', rowCount: '3', billedCost: '-7.50000000000', effectiveCost: '-7.00000000000' }),
      g({ currency: 'JPY', rowCount: '2', billedCost: '1200', effectiveCost: '1100' }),
    ];
    return buildEngagementReportModel(assembleReportFacts(sampleInput({ groups })), { ...ENGAGEMENT, displayName: '成本报告 コスト 비용 Москва' });
  };

  it('Latin accents, Cyrillic, Greek, Chinese, Japanese, Korean and mixed cells extract exactly, with amounts, negatives, currency labels and totals', async () => {
    const m = multi();
    expect(pdfPreflight(m)).toEqual({ cells: 0, complex: 0, emoji: 0, other: 0 });
    const pdf = await renderEngagementReportPdf(m);
    // A line mixing scripts is drawn as one text run per font, in order: a page's runs joined hold each line's text.
    const pages = pdfPageStrings(pdf).map((p) => p.join(''));
    const all = pages.join('\n');
    for (const t of [...SCRIPTS, '成本报告 コスト 비용 Москва (example-engagement)']) expect(all, t).toContain(t);
    const shown = pdfShownStrings(pdf);
    for (const v of ['18.00663861840', '-2.61370000000', '-3.00000000000', '-6.25000000000', '-7.50000000000', '-7.00000000000', '1200', '1100', 'USD', 'EUR', 'JPY', 'N/A']) expect(shown, v).toContain(v);
    expect(all).not.toMatch(/\ufffd|\?/);
  }, 30_000);

  it('embeds subsets of the three bundled faces only (no built-in font), each with a ToUnicode map; a CJK report stays small', async () => {
    const pdf = await renderEngagementReportPdf(multi());
    expect(pdfEmbeddedFonts(pdf).map((f) => f.name).sort()).toEqual(['RATIOA+NotoSans-Bold', 'RATIOB+NotoSans-Regular', 'RATIOC+NotoSansCJKsc-Regular'].sort());
    for (const f of pdfEmbeddedFonts(pdf)) expect([f.embedded, f.toUnicode], f.name).toEqual([true, true]);
    expect(pdf.toString('latin1')).not.toMatch(/\/BaseFont \/Helvetica/);
    // The CJK face alone is 16.4 MB: only the used glyphs are embedded.
    expect(pdf.length).toBeLessThan(400 * 1024);
  }, 30_000);

  it('identical bytes on every render of the same model (subset names are stable)', async () => {
    const [a, b] = [await renderEngagementReportPdf(multi()), await renderEngagementReportPdf(multi())];
    expect(a.equals(b)).toBe(true);
    // The xref offsets still point at their objects after the subset names are rewritten.
    const raw = a.toString('latin1');
    const xref = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(raw)!;
    const offsets = [...xref[2].matchAll(/(\d{10}) 00000 n/g)].map((x) => Number(x[1]));
    expect(offsets.length).toBe(Number(xref[1]) - 1);
    // Objects are written in object-number order (pdfkit's own order varies with stream compression timing).
    expect(offsets).toEqual([...offsets].sort((x, y) => x - y));
    offsets.forEach((o, i) => expect(raw.slice(o, o + 12), `object ${i + 1}`).toMatch(new RegExp(`^${i + 1} 0 obj`)));
  }, 30_000);

  it('CJK text breaks between characters when it is wider than its column (a visible - marks the break); nothing is cut', async () => {
    expect(breakLong('成本报告')).toEqual(['成', '本', '报', '告']);
    expect(breakLong('Cost成本ID-42')).toEqual(['Cost', '成', '本', 'ID-42']);
    expect(breakLong('a'.repeat(40))).toEqual(['a'.repeat(40)]);
    expect(breakLong('0a0a0a0a-0000-4000-8000-00000000000a')).toEqual(['0a0a0a0a-0000-4000-8000-00000000000a']);
    const long = '云计算费用报告'.repeat(25); // 175 CJK characters (cost 1,750: under the cell cap), no spaces
    const m = buildEngagementReportModel(assembleReportFacts(sampleInput({ groups: [g({}), g({ isTotal: false, chargeCategory: long, rowCount: '1' })] })), ENGAGEMENT);
    const shown = pdfShownStrings(await renderEngagementReportPdf(m));
    const at = shown.findIndex((t) => t.startsWith('云计算'));
    const lines = shown.slice(at, at + 4).filter((t) => /^[云计算费用报告]/.test(t));
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines.slice(0, -1)) expect(l).toMatch(/-$/);
    expect(lines.map((l, i) => (i < lines.length - 1 ? l.slice(0, -1) : l)).join('')).toBe(long);
  }, 30_000);

  it("the data caps weigh each CJK character as 10 Latin ones and each font switch as 10 (layout cost): visible marker, page-1 count", () => {
    expect([PDF_CJK_COST, PDF_FONT_SWITCH_COST]).toEqual([10, 10]);
    expect(pdfTextCost('ab 成本')).toBe(3 + 2 * PDF_CJK_COST + PDF_FONT_SWITCH_COST);
    expect(pdfTextCost('成 本 报')).toBe(3 * PDF_CJK_COST + 2 + 4 * PDF_FONT_SWITCH_COST);
    const m = buildEngagementReportModel(assembleReportFacts(sampleInput({ groups: [g({}), g({ isTotal: false, chargeCategory: '成本'.repeat(1_500), rowCount: '1' })] })), ENGAGEMENT);
    const texts = treeTexts(<EngagementReportDocument model={m} />);
    const cell = texts.find((t) => t.startsWith('成本成本'))!;
    expect(cell).toBe(`${'成本'.repeat(100)}... [truncated 2800 characters; see XLSX/JSON for the full text]`);
    expect(texts.filter((t) => t.startsWith('PDF length limit: '))).toEqual([PDF_TRUNCATION_NOTE(1)]);
    // Mixed text is cut where its cost reaches the cap, never inside a character.
    expect(pdfCutToCost('ab成本cd', 22)).toBe('ab成');
    expect(pdfCutToCost('ab成本cd', 21)).toBe('ab');
  });

  for (const kind of ['cjk-spaced', 'cjk-dense'] as const) {
    it(`a hostile ${kind} input (50 cells of 2,000 CJK characters${kind === 'cjk-spaced' ? ' separated by spaces' : ''}) renders within 15 s and bounded memory (external watchdog)`, () => {
      const child = path.join(__dirname, 'fixtures', 'pdfRenderChild.tsx');
      const r = spawnSync(process.execPath, ['--import', 'tsx', child, kind], { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' });
      expect(r.signal, 'killed by the watchdog: the render did not finish in time').toBeNull();
      const out = JSON.parse(r.stdout.trim()) as { ms: number; rss: number; bytes: number };
      expect(out.rss).toBeLessThan(700 * 1024 * 1024);
      expect(out.bytes).toBeGreaterThan(0);
    }, 20_000);
  }

  it("one PDF render at a time (its text layer is set on the shared font objects); a further request is refused as busy", async () => {
    expect(PDF_MAX_CONCURRENT_RENDERS).toBe(1);
    const m = buildEngagementReportModel(assembleReportFacts(sampleInput()), ENGAGEMENT);
    const results = await Promise.allSettled([renderEngagementReportPdf(m), renderEngagementReportPdf(m), renderEngagementReportPdf(m)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect((results[2] as PromiseRejectedResult).reason).toBeInstanceOf(PdfBusyError);
    // The slots are released: the next render succeeds.
    expect((await renderEngagementReportPdf(m)).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }, 30_000);
});

describe('unsupported text: preflight and the refusal policy (default refuse)', () => {
  const withCells = (cells: string[]) =>
    buildEngagementReportModel(assembleReportFacts(sampleInput({ groups: [g({}), ...cells.map((c) => g({ isTotal: false, chargeCategory: c, rowCount: '1' }))] })), ENGAGEMENT);

  it('the default policy is refuse', () => {
    expect(PDF_UNSUPPORTED_TEXT_POLICY).toBe('refuse');
  });

  it('counts cell values per kind (a value with two kinds counts once in cells and once per kind); the message names counts only', () => {
    const m = withCells(['مرحبا', 'नमस्ते', 'สวัสดี', 'Paid 👍🏽', 'שלום 😀', 'e\u0301', '\uE000 private', 'Москва 成本']);
    const counts = pdfPreflight(m);
    expect(counts).toEqual({ cells: 7, complex: 5, emoji: 2, other: 1 });
    expect(PDF_UNSUPPORTED_MESSAGE(counts)).toBe(
      '7 cell values contain characters the PDF cannot render (complex scripts or combining marks: 5; emoji: 2; other: 1); download XLSX or JSON for the full text.',
    );
    expect(PDF_UNSUPPORTED_MESSAGE({ cells: 1, complex: 0, emoji: 1, other: 0 })).toMatch(/^1 cell value contains characters /);
  });

  it('refuses Vietnamese/Yoruba dot-below letters, characters outside the Basic Multilingual Plane, and glyph twins used together', () => {
    expect(pdfPreflight(withCells(['Phòng học dịch vụ', 'ọja ṣe ẹ', 'Phòng Nguyễn']))).toEqual({ cells: 2, complex: 2, emoji: 0, other: 0 });
    expect(pdfPreflight(withCells(['a\u{20BB7}b', 'a\u{1F170}b']))).toEqual({ cells: 2, complex: 0, emoji: 1, other: 1 });
    // U+4E00 and the Kangxi radical U+2F00 are one glyph: U+4E00 is drawn, U+2F00 is refused (its text layer would read U+4E00).
    expect(pdfPreflight(withCells(['\u4e00 cost', 'other']))).toEqual({ cells: 0, complex: 0, emoji: 0, other: 0 });
    expect(pdfPreflight(withCells(['\u4e00 cost', '\u2f00 radical']))).toEqual({ cells: 1, complex: 0, emoji: 0, other: 1 });
  });

  // Each example next to a value that the font draws with the same glyph, rendered as separate PDFs in both orders.
  const TWINS: [string, string][] = [
    ['クラウド\u30fbサービス', 'A\u00b7B'],
    ['10\uff5e20件', '10\u301c20件'],
    ['云服务\u22ef\u22ef', 'a\u2026b'],
    ['计算\uff0f存储', 'a\u2215b'],
    ['\uff40quoted\uff40', '\u2035x'],
    ['\uffa1\uffa4\uffb7\uffc2\uffdc', '\u3131\u3134\u3147\u314f\u3163'],
    ['\u58ff', '\u58ab'],
    ['\u3031 \u3035', 'x'],
  ];
  for (const order of ['example first', 'twin first'] as const) {
    it(`common CJK punctuation and symbols render and extract exactly in either render order (${order})`, async () => {
      const shown = async (text: string) => pdfShownStrings(await renderEngagementReportPdf(withCells([text]))).join('');
      for (const [example, twin] of TWINS) {
        const [a, b] = order === 'example first' ? [example, twin] : [twin, example];
        expect(await shown(a), `U+${[...a].map((c) => c.codePointAt(0)!.toString(16)).join(' ')}`).toContain(a);
        expect(await shown(b), `U+${[...b].map((c) => c.codePointAt(0)!.toString(16)).join(' ')}`).toContain(b);
      }
    }, 120_000);
  }

  it('both code points of one glyph in one PDF are refused (both values counted); a joined vertical repeat sequence is refused by the text-layer check', () => {
    expect(pdfPreflight(withCells(['10\uff5e20件', '10\u301c20件']))).toEqual({ cells: 2, complex: 0, emoji: 0, other: 2 });
    expect(pdfPreflight(withCells(['\u3033\u3035']))).toEqual({ cells: 1, complex: 0, emoji: 0, other: 1 });
  });

  it('a refused PDF logs no React error stack (the refusal happens before rendering)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(renderEngagementReportPdf(withCells(['مرحبا']))).rejects.toBeInstanceOf(PdfUnsupportedTextError);
      expect(err).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it("substitute draws a refused glyph twin as '?' and keeps its canonical twin", () => {
    const m = withCells(['\u4e00 cost', '\u2f00 radical']);
    const texts = treeTexts(<EngagementReportDocument model={m} policy="substitute" />);
    expect(texts).toContain('\u4e00 cost');
    expect(texts).toContain('? radical');
    expect(texts).toContain(PDF_GLYPH_NOTE(1));
  });

  it('refuse: no PDF is produced, the error carries the counts and never a cell value', async () => {
    const m = withCells(['مرحبا بالعالم', 'Usage']);
    const err = await renderEngagementReportPdf(m).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PdfUnsupportedTextError);
    expect((err as PdfUnsupportedTextError).counts).toEqual({ cells: 1, complex: 1, emoji: 0, other: 0 });
    expect((err as Error).message).not.toContain('مرحبا');
    expect(() => treeTexts(<EngagementReportDocument model={m} />)).toThrow(PdfUnsupportedTextError);
  });

  it("substitute (the one-switch alternative): the same input renders with '?' and the page-1 count instead", async () => {
    const m = withCells(['مرحبا', 'Paid 👍🏽']);
    const shown = pdfShownStrings(await renderEngagementReportPdf(m, 'substitute'));
    expect(shown).toContain('?????');
    expect(shown).toContain('Paid ??');
    expect(shown.join('')).toContain('PDF font: 2 cell values contain characters the PDF cannot render');
  }, 30_000);
});

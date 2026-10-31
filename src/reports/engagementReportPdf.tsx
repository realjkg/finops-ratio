// Engagement report PDF (1.0): renders the ONE engagement report model with the
// existing @react-pdf stack and the bundled Noto fonts (pdfFonts.ts: local files,
// no font fetch). Server-only: imported only through the
// /api/v1/reports/engagement route.
//
// Every title, column and cell is the model's string, verbatim: amounts are the
// exact decimal text, never formatted or rounded; N/A cells read 'N/A' with the
// reason in the row's Note. One page group per section: the report title, the
// section title and (for tables) the column header repeat on every page; wide
// sections print one block per row so ids and hashes fit unbroken. Text in the
// declared supported scripts (Latin, Greek, Cyrillic, Chinese, Japanese, Korean)
// is drawn faithfully; any other character is never drawn as a missing-glyph box:
// by default (PDF_UNSUPPORTED_TEXT_POLICY) the PDF is refused with counts and the
// XLSX/JSON carry the full text; the 'substitute' policy draws a visible '?' and
// says on the first page how many cell values that affected.
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';
import type { Style } from '@react-pdf/types';
import { BUILT_IN_THEMES } from '@/theme/themes';
import { DATA_TEXT_CELLS, type EngagementReportModel, type ReportSection } from './engagementReportModel';
import { deterministicPdf } from './pdfBytes';
import { classifyPdfChar, loadPdfFonts, pdfCharFace, PDF_FONT_FAMILY, textLayerFaults, unsupportedKinds, type UnsupportedKind } from './pdfFonts';

// The print surface uses the Light theme's executive colors (no hard-coded colors; src/theme/tokens.test.ts).
const LIGHT = BUILT_IN_THEMES.light.colors;
const INK = LIGHT['exec-text'];
const MUTED = LIGHT['exec-muted'];
const BORDER = LIGHT['exec-border'];
const BOLD = 700;
const styles = StyleSheet.create({
  page: { paddingTop: 28, paddingBottom: 36, paddingHorizontal: 28, fontFamily: PDF_FONT_FAMILY, fontSize: 7, color: INK },
  title: { fontWeight: BOLD, fontSize: 12 },
  section: { fontWeight: BOLD, fontSize: 10, marginTop: 4, marginBottom: 6 },
  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: BORDER, paddingVertical: 3 },
  head: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: INK, paddingVertical: 3 },
  th: { fontWeight: BOLD, color: MUTED, paddingRight: 4 },
  td: { paddingRight: 4 },
  record: { borderBottomWidth: 0.5, borderBottomColor: BORDER, paddingVertical: 4 },
  note: { marginTop: 8, color: MUTED },
  footer: { position: 'absolute', bottom: 16, left: 28, right: 28, fontSize: 6, color: MUTED, textAlign: 'center' },
});

/**
 * What the PDF does when a value holds characters it cannot draw faithfully (pdfFonts.ts classifies them):
 * 'refuse' (default) renders no PDF and the route answers 422 with the counts per kind, pointing to XLSX/JSON;
 * 'substitute' draws each such character as a visible '?' and states the count on the first page.
 */
export type PdfUnsupportedPolicy = 'refuse' | 'substitute';
export const PDF_UNSUPPORTED_TEXT_POLICY: PdfUnsupportedPolicy = 'refuse';

/** The model text as the PDF draws it under the 'substitute' policy: any character the bundled fonts cannot draw faithfully becomes a visible '?'. */
export function pdfGlyphText(text: string): string {
  return [...text].map((ch) => (classifyPdfChar(ch) === 'ok' ? ch : '?')).join('');
}
/** A value whose text layer would be wrong in this document (textLayerFaults), under 'substitute': everything outside ASCII becomes '?'. */
const asciiOnly = (text: string) => text.replace(/[^\n\x20-\x7e]/gu, '?');
export const PDF_GLYPH_NOTE = (n: number) =>
  `PDF font: ${n} cell value${n === 1 ? '' : 's'} contain${n === 1 ? 's' : ''} characters the PDF cannot render (outside its supported scripts), shown here as '?'. The XLSX and JSON show the full text.`;

const FOOTER = (title: string, generatedAt: string, page: number, pages: number) => `${title} · generated ${generatedAt} · page ${page} of ${pages}`;

export type PdfUnsupportedCounts = { cells: number } & Record<UnsupportedKind, number>;
/** Fixed text: counts only, never a cell value. */
export const PDF_UNSUPPORTED_MESSAGE = (c: PdfUnsupportedCounts) =>
  `${c.cells} cell value${c.cells === 1 ? '' : 's'} contain${c.cells === 1 ? 's' : ''} characters the PDF cannot render (complex scripts or combining marks: ${c.complex}; emoji: ${c.emoji}; other: ${c.other}); download XLSX or JSON for the full text.`;
export class PdfUnsupportedTextError extends Error {
  constructor(readonly counts: PdfUnsupportedCounts) {
    super(PDF_UNSUPPORTED_MESSAGE(counts));
    this.name = 'PdfUnsupportedTextError';
  }
}

// Chinese, Japanese and Korean text may break between any two of its characters
// (it has no spaces); otherwise only an unbroken token longer than 40 characters
// (hostile or truncated data) may break, every 4 characters; ordinary words, ids
// and hashes never do. react-pdf marks a break inside a token with a '-'.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\u3000-\u303f\uff00-\uffef]/u;
const chunk = (cps: string[]) => (cps.length <= 40 ? [cps.join('')] : Array.from({ length: Math.ceil(cps.length / 4) }, (_, i) => cps.slice(i * 4, i * 4 + 4).join('')));
export const breakLong = (word: string): string[] => {
  const cps = [...word]; // code points: a surrogate pair is never split
  if (!CJK.test(word)) return chunk(cps);
  const parts: string[] = [];
  let run: string[] = [];
  for (const ch of cps) {
    if (!CJK.test(ch)) {
      run.push(ch);
      continue;
    }
    parts.push(...(run.length ? chunk(run) : []), ch);
    run = [];
  }
  return run.length ? [...parts, ...chunk(run)] : parts;
};

/** Narrow sections print as tables; wide ones as one block per row ("Column: value" lines), so ids and hashes fit unbroken. */
export const pdfLayout = (s: ReportSection): 'table' | 'records' => (s.columns.length <= 4 ? 'table' : 'records');

function widths(s: ReportSection): string[] {
  const w = s.columns.map((c, i) => (c === 'Note' ? 3 : i === 1 ? 4 : 1.5));
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((x) => `${((x / total) * 100).toFixed(3)}%`);
}
const T = ({ style, children }: { style: Style | Style[]; children: string }) => (
  <Text style={style} hyphenationCallback={breakLong}>
    {children}
  </Text>
);

// Render-cost bounds (PDF only; the shared model, XLSX and screen keep the full text). react-pdf lays out
// synchronously, so the read deadline cannot stop a render: the text it lays out is capped instead. The caps
// count cost units: one per character, PDF_CJK_COST per character drawn by the CJK face (its layout costs about
// ten times more per character), and PDF_FONT_SWITCH_COST each time the face changes (each change is a separate
// layout run: 50 cells of 2,000 CJK characters separated by spaces took 37.7 s uncapped, in the review of PR 164).
export const PDF_CJK_COST = 10;
export const PDF_FONT_SWITCH_COST = 10;
export const PDF_CELL_MAX_CHARS = 2_000;
export const PDF_TOTAL_MAX_CHARS = 100_000;
export const PDF_CELL_FLOOR_CHARS = 200;
/** Model-authored text (labels, reasons, warnings) is never budgeted; it is bounded by construction, and this ceiling only guards that. */
export const PDF_MODEL_TEXT_MAX_CHARS = 8_000;
/** Appended where a cell's PDF text is cut (the XLSX and JSON keep the full text). */
export const PDF_TRUNCATION_MARKER = (n: number) => `... [truncated ${n} characters; see XLSX/JSON for the full text]`;
export const PDF_TRUNCATION_NOTE = (n: number) =>
  `PDF length limit: ${n} cell value${n === 1 ? ' was' : 's were'} truncated (at most ${PDF_CELL_MAX_CHARS} characters per cell, and ${PDF_CELL_FLOOR_CHARS} per cell once the document holds ${PDF_TOTAL_MAX_CHARS}; a Chinese, Japanese or Korean character counts as ${PDF_CJK_COST}); the XLSX and JSON carry the full text.`;

/** Layout cost of a text in cap units (see PDF_CJK_COST and PDF_FONT_SWITCH_COST). */
export function pdfTextCost(text: string): number {
  return costPrefix(text, Infinity).cost;
}
/** The longest prefix of the text whose cost is at most maxCost (never cuts inside a character). */
export function pdfCutToCost(text: string, maxCost: number): string {
  return text.slice(0, costPrefix(text, maxCost).end);
}
function costPrefix(text: string, maxCost: number): { cost: number; end: number } {
  let cost = 0;
  let end = 0;
  let face: number | null = null;
  for (const ch of text) {
    const f = pdfCharFace(ch) === 2 ? 2 : 0;
    const next = cost + (f === 2 ? PDF_CJK_COST : 1) + (face !== null && f !== face ? PDF_FONT_SWITCH_COST : 0);
    if (next > maxCost) break;
    cost = next;
    face = f;
    end += ch.length;
  }
  return { cost, end };
}

/** Every text value the PDF shows, in document order (title, then per section its title, columns and cells): the order pdfView shows them in. */
const pdfDocumentTexts = (model: EngagementReportModel) => [model.title, ...model.sections.flatMap((s) => [s.title, ...s.columns, ...s.rows.flat()])];

/**
 * Counts the text values (title, section titles, columns, cells) holding characters the PDF cannot draw, per kind;
 * cells = values with any. A glyph twin colliding with another code point in the same document counts as 'other'.
 */
export function pdfPreflight(model: EngagementReportModel): PdfUnsupportedCounts {
  return refusalCounts(model, buildView(model, 'refuse').faults);
}

/** Per-character kinds on the full model text, plus the text-layer faults of the shown (capped) text. */
function refusalCounts(model: EngagementReportModel, faults: ReadonlySet<number>): PdfUnsupportedCounts {
  const counts: PdfUnsupportedCounts = { cells: 0, complex: 0, emoji: 0, other: 0 };
  pdfDocumentTexts(model).forEach((t, i) => {
    const kinds = unsupportedKinds(t);
    if (faults.has(i)) kinds.add('other');
    if (kinds.size > 0) counts.cells += 1;
    for (const k of kinds) counts[k] += 1;
  });
  return counts;
}

/**
 * The model's text as this PDF shows it: the unsupported-text policy for every value (refuse throws; substitute
 * draws '?'); the per-cell cap, the document budget and the floor only for cells that carry imported or configured
 * free text (DATA_TEXT_CELLS), in document order. Requires loadPdfFonts().
 */
function pdfView(model: EngagementReportModel, policy: PdfUnsupportedPolicy) {
  if (policy === 'refuse') {
    const view = buildView(model, 'refuse');
    const counts = refusalCounts(model, view.faults);
    if (counts.cells > 0) throw new PdfUnsupportedTextError(counts);
    return view;
  }
  const first = buildView(model, 'substitute');
  return first.faults.size === 0 ? first : buildView(model, 'substitute', first.faults);
}

/** The shown texts with caps (and, under 'substitute', '?' for unsupported characters and ASCII-only for the given faulty values), plus the text-layer faults of the result. */
function buildView(model: EngagementReportModel, policy: PdfUnsupportedPolicy, faulty: ReadonlySet<number> = new Set()) {
  let budget = PDF_TOTAL_MAX_CHARS;
  let glyph = 0;
  let cut = 0;
  // Everything drawn, for the text-layer check: the shown values (with their pdfDocumentTexts index), the
  // footer copy of the title, and the fixed page furniture (notes, footer) at index -1.
  const shown: { text: string; bold: boolean; index: number }[] = [PDF_GLYPH_NOTE(2), PDF_TRUNCATION_NOTE(2), FOOTER('', '', 2, 2)].map((text) => ({ text, bold: false, index: -1 }));
  let next = 0;
  const show = (text: string, data = false, bold = false) => {
    const index = next++;
    const out = cap(text, data, index);
    shown.push({ text: out, bold, index });
    if (index === 0) shown.push({ text: out, bold: false, index }); // the title is also the regular-weight footer
    return out;
  };
  const cap = (text: string, data: boolean, index: number) => {
    const sub = policy === 'substitute' ? pdfGlyphText(text) : text;
    const g = faulty.has(index) ? asciiOnly(sub) : sub;
    if (g !== text) glyph += 1;
    // Once the document budget is spent, every data cell still keeps its first PDF_CELL_FLOOR_CHARS.
    const limit = data ? Math.min(PDF_CELL_MAX_CHARS, Math.max(budget, PDF_CELL_FLOOR_CHARS)) : PDF_MODEL_TEXT_MAX_CHARS;
    const cost = pdfTextCost(g);
    if (cost <= limit) {
      if (data) budget = Math.max(0, budget - cost);
      return g;
    }
    cut += 1;
    if (data) budget = Math.max(0, budget - limit);
    const kept = pdfCutToCost(g, limit);
    return `${kept}${PDF_TRUNCATION_MARKER(g.length - kept.length)}`;
  };
  const title = show(model.title, false, true);
  const isData = (s: ReportSection, r: string[], i: number) =>
    s.id === 'summary' ? i === 1 && DATA_TEXT_CELLS.summaryItems.includes(r[0]) : (DATA_TEXT_CELLS.columns[s.id] ?? []).includes(s.columns[i]);
  const sections = model.sections.map((s) => ({
    ...s,
    title: show(s.title, false, true),
    columns: s.columns.map((c) => show(c, false, true)),
    rows: s.rows.map((r) => r.map((c, i) => show(c, isData(s, r, i)))),
  }));
  const faults = new Set([...textLayerFaults(shown)].map((i) => shown[i].index).filter((i) => i >= 0));
  return { title, sections, glyph, cut, faults };
}

function SectionPages({ view, section, generatedAt, first }: { view: ReturnType<typeof pdfView>; section: ReportSection; generatedAt: string; first: boolean }) {
  const w = widths(section);
  const table = pdfLayout(section) === 'table';
  return (
    <Page size="A4" orientation="landscape" style={styles.page} wrap>
      <View fixed>
        <T style={styles.title}>{view.title}</T>
        <T style={styles.section}>{section.title}</T>
        {table && (
          <View style={styles.head}>
            {section.columns.map((c, i) => (
              <T key={i} style={[styles.th, { width: w[i] }]}>{c}</T>
            ))}
          </View>
        )}
      </View>
      {section.rows.map((r, ri) =>
        table ? (
          <View key={ri} style={styles.row}>
            {r.map((cell, i) => (
              <T key={i} style={[styles.td, { width: w[i] }]}>{cell}</T>
            ))}
          </View>
        ) : (
          // A record never splits across pages, so no page shows amounts without their currency and source.
          <View key={ri} style={styles.record} wrap={false}>
            {r.map((cell, i) =>
              cell === '' ? null : (
                <View key={i} style={{ flexDirection: 'row' }}>
                  <T style={[styles.th, { width: '22%' }]}>{section.columns[i]}</T>
                  <T style={[styles.td, { width: '78%' }]}>{cell}</T>
                </View>
              ),
            )}
          </View>
        ),
      )}
      {first && view.glyph > 0 && <T style={styles.note}>{PDF_GLYPH_NOTE(view.glyph)}</T>}
      {first && view.cut > 0 && <T style={styles.note}>{PDF_TRUNCATION_NOTE(view.cut)}</T>}
      <Text style={styles.footer} fixed render={({ pageNumber, totalPages }) => FOOTER(view.title, generatedAt, pageNumber, totalPages)} />
    </Page>
  );
}

export function EngagementReportDocument({ model, policy = PDF_UNSUPPORTED_TEXT_POLICY }: { model: EngagementReportModel; policy?: PdfUnsupportedPolicy }) {
  const view = pdfView(model, policy);
  return (
    <Document title={view.title} author="Ratio" creator="Ratio" producer="Ratio" creationDate={new Date(model.generatedAt)} modificationDate={new Date(model.generatedAt)}>
      {view.sections.map((s, i) => (
        <SectionPages key={s.id} view={view} section={s} generatedAt={model.generatedAt} first={i === 0} />
      ))}
    </Document>
  );
}

/** Renders in flight at most (each blocks the event loop for seconds; more would only queue past the request deadline). */
export const PDF_MAX_CONCURRENT_RENDERS = 2;
export const PDF_BUSY_MESSAGE = 'The PDF renderer is busy; retry in a few seconds, or download XLSX or JSON.';
export class PdfBusyError extends Error {
  constructor() {
    super(PDF_BUSY_MESSAGE);
    this.name = 'PdfBusyError';
  }
}
let rendering = 0;

/**
 * Renders the PDF, or throws PdfBusyError (all render slots taken) or PdfUnsupportedTextError (refuse policy)
 * before any layout work. Same model, same bytes.
 */
export async function renderEngagementReportPdf(model: EngagementReportModel, policy: PdfUnsupportedPolicy = PDF_UNSUPPORTED_TEXT_POLICY): Promise<Buffer> {
  if (rendering >= PDF_MAX_CONCURRENT_RENDERS) throw new PdfBusyError(); // checked and taken before the first await
  rendering += 1;
  try {
    await loadPdfFonts();
    // The document builds its view first: under 'refuse' it throws PdfUnsupportedTextError before any layout.
    return deterministicPdf(await renderToBuffer(<EngagementReportDocument model={model} policy={policy} />));
  } finally {
    rendering -= 1;
  }
}

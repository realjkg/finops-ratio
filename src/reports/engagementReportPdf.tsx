// Engagement report PDF (1.0): renders the ONE engagement report model with the
// existing @react-pdf stack and its built-in Helvetica (offline, no font fetch;
// see src/executive/reportPdf.tsx). Server-only: imported only through the
// /api/v1/reports/engagement route.
//
// Every title, column and cell is the model's string, verbatim: amounts are the
// exact decimal text, never formatted or rounded; N/A cells read 'N/A' with the
// reason in the row's Note. One page group per section: the report title, the
// section title and (for tables) the column header repeat on every page; wide
// sections print one block per row so ids and hashes fit unbroken. Helvetica only has Windows-1252 glyphs, so any other
// character is drawn as a visible '?' and the first page says how many cell
// values that affected (the XLSX and the screen show the full text).
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';
import type { Style } from '@react-pdf/types';
import { BUILT_IN_THEMES } from '@/theme/themes';
import { DATA_TEXT_CELLS, type EngagementReportModel, type ReportSection } from './engagementReportModel';

// The print surface uses the Light theme's executive colors (no hard-coded colors; src/theme/tokens.test.ts).
const LIGHT = BUILT_IN_THEMES.light.colors;
const INK = LIGHT['exec-text'];
const MUTED = LIGHT['exec-muted'];
const BORDER = LIGHT['exec-border'];
const styles = StyleSheet.create({
  page: { paddingTop: 28, paddingBottom: 36, paddingHorizontal: 28, fontFamily: 'Helvetica', fontSize: 7, color: INK },
  title: { fontFamily: 'Helvetica-Bold', fontSize: 12 },
  section: { fontFamily: 'Helvetica-Bold', fontSize: 10, marginTop: 4, marginBottom: 6 },
  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: BORDER, paddingVertical: 3 },
  head: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: INK, paddingVertical: 3 },
  th: { fontFamily: 'Helvetica-Bold', color: MUTED, paddingRight: 4 },
  td: { paddingRight: 4 },
  record: { borderBottomWidth: 0.5, borderBottomColor: BORDER, paddingVertical: 4 },
  note: { marginTop: 8, color: MUTED },
  footer: { position: 'absolute', bottom: 16, left: 28, right: 28, fontSize: 6, color: MUTED, textAlign: 'center' },
});

// Windows-1252 printable characters beyond Latin-1 that Helvetica (WinAnsiEncoding) can draw.
const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const drawable = (ch: string) => {
  const c = ch.codePointAt(0) as number;
  return ch === '\n' || ch === '\t' || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || CP1252_EXTRA.has(ch);
};
/** The model text as the built-in PDF font can draw it: any other character becomes a visible '?'. */
export function pdfGlyphText(text: string): string {
  return [...text].map((ch) => (drawable(ch) ? ch : '?')).join('');
}
export const PDF_GLYPH_NOTE = (n: number) =>
  `PDF font: ${n} cell value${n === 1 ? '' : 's'} contain${n === 1 ? 's' : ''} characters outside the PDF's built-in font (Windows-1252), shown here as '?'. The XLSX and the screen show the full text.`;

// Only an unbroken token longer than 40 characters (hostile or truncated data)
// may break, every 4 characters; ordinary words, ids and hashes never do.
const breakLong = (word: string) => {
  const cps = [...word]; // code points: a surrogate pair is never split
  if (cps.length <= 40) return [word];
  return Array.from({ length: Math.ceil(cps.length / 4) }, (_, i) => cps.slice(i * 4, i * 4 + 4).join(''));
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
// synchronously, so the read deadline cannot stop a render: the text it lays out is capped instead.
export const PDF_CELL_MAX_CHARS = 2_000;
export const PDF_TOTAL_MAX_CHARS = 100_000;
export const PDF_CELL_FLOOR_CHARS = 200;
/** Model-authored text (labels, reasons, warnings) is never budgeted; it is bounded by construction, and this ceiling only guards that. */
export const PDF_MODEL_TEXT_MAX_CHARS = 8_000;
export const PDF_TRUNCATION_NOTE = (n: number) =>
  `PDF length limit: ${n} cell value${n === 1 ? ' was' : 's were'} truncated (at most ${PDF_CELL_MAX_CHARS} characters per cell, and ${PDF_CELL_FLOOR_CHARS} per cell once the document holds ${PDF_TOTAL_MAX_CHARS}); the XLSX and JSON carry the full text.`;

/**
 * The model's text as this PDF shows it: glyph fallback for every cell; the per-cell cap, the document budget and
 * the floor only for cells that carry imported or configured free text (DATA_TEXT_CELLS), in document order.
 */
function pdfView(model: EngagementReportModel) {
  let budget = PDF_TOTAL_MAX_CHARS;
  let glyph = 0;
  let cut = 0;
  const show = (text: string, data = false) => {
    const g = pdfGlyphText(text);
    if (g !== text) glyph += 1;
    // Once the document budget is spent, every data cell still keeps its first PDF_CELL_FLOOR_CHARS.
    const limit = data ? Math.min(PDF_CELL_MAX_CHARS, Math.max(budget, PDF_CELL_FLOOR_CHARS)) : PDF_MODEL_TEXT_MAX_CHARS;
    if (g.length <= limit) {
      if (data) budget = Math.max(0, budget - g.length);
      return g;
    }
    cut += 1;
    if (data) budget = Math.max(0, budget - limit);
    return `${g.slice(0, limit)}... [truncated ${g.length - limit} characters; see XLSX/JSON for the full text]`;
  };
  const title = show(model.title);
  const isData = (s: ReportSection, r: string[], i: number) =>
    s.id === 'summary' ? i === 1 && DATA_TEXT_CELLS.summaryItems.includes(r[0]) : (DATA_TEXT_CELLS.columns[s.id] ?? []).includes(s.columns[i]);
  const sections = model.sections.map((s) => ({ ...s, title: show(s.title), columns: s.columns.map((c) => show(c)), rows: s.rows.map((r) => r.map((c, i) => show(c, isData(s, r, i)))) }));
  return { title, sections, glyph, cut };
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
      <Text style={styles.footer} fixed render={({ pageNumber, totalPages }) => `${view.title} · generated ${generatedAt} · page ${pageNumber} of ${totalPages}`} />
    </Page>
  );
}

export function EngagementReportDocument({ model }: { model: EngagementReportModel }) {
  const view = pdfView(model);
  return (
    <Document title={view.title} author="Ratio" creator="Ratio" producer="Ratio" creationDate={new Date(model.generatedAt)} modificationDate={new Date(model.generatedAt)}>
      {view.sections.map((s, i) => (
        <SectionPages key={s.id} view={view} section={s} generatedAt={model.generatedAt} first={i === 0} />
      ))}
    </Document>
  );
}

export function renderEngagementReportPdf(model: EngagementReportModel): Promise<Buffer> {
  return renderToBuffer(<EngagementReportDocument model={model} />);
}

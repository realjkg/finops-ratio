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
import type { EngagementReportModel, ReportSection } from './engagementReportModel';

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
    {pdfGlyphText(children)}
  </Text>
);

function SectionPages({ model, section }: { model: EngagementReportModel; section: ReportSection }) {
  const w = widths(section);
  const table = pdfLayout(section) === 'table';
  const glyphNote = section.id === 'summary' ? countGlyphChanges(model) : 0;
  return (
    <Page size="A4" orientation="landscape" style={styles.page} wrap>
      <View fixed>
        <T style={styles.title}>{model.title}</T>
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
          <View key={ri} style={styles.record}>
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
      {glyphNote > 0 && <T style={styles.note}>{PDF_GLYPH_NOTE(glyphNote)}</T>}
      <Text style={styles.footer} fixed render={({ pageNumber, totalPages }) => `${pdfGlyphText(model.title)} · generated ${model.generatedAt} · page ${pageNumber} of ${totalPages}`} />
    </Page>
  );
}

function countGlyphChanges(model: EngagementReportModel): number {
  const all = [model.title, ...model.sections.flatMap((s) => [s.title, ...s.columns, ...s.rows.flat()])];
  return all.filter((t) => pdfGlyphText(t) !== t).length;
}

export function EngagementReportDocument({ model }: { model: EngagementReportModel }) {
  return (
    <Document title={pdfGlyphText(model.title)} author="Ratio" creator="Ratio" producer="Ratio" creationDate={new Date(model.generatedAt)} modificationDate={new Date(model.generatedAt)}>
      {model.sections.map((s) => (
        <SectionPages key={s.id} model={model} section={s} />
      ))}
    </Document>
  );
}

export function renderEngagementReportPdf(model: EngagementReportModel): Promise<Buffer> {
  return renderToBuffer(<EngagementReportDocument model={model} />);
}

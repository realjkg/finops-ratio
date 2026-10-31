// Text-layer fidelity of the bundled PDF fonts: EVERY supported code point of the
// Basic Multilingual Plane is drawn with the report's font family (code points that
// share a glyph in separate PDFs, characters the font joins on lines of their own),
// and the PDF's text layer
// (decoded through the embedded fonts' ToUnicode maps, as a PDF reader does) must
// give back exactly the input. This is what "supported" means for the PDF.
import { Document, Page, Text, renderToBuffer } from '@react-pdf/renderer';
import { beforeAll, describe, expect, it } from 'vitest';
import { classifyPdfChar, loadPdfFonts, PDF_FONT_FAMILY, pdfGlyphKey, planTextLayer } from './pdfFonts';
import { pdfPageStrings } from './fixtures/pdfText';

const PER_LINE = 40;

/** Supported code points from U+0080 (ASCII is covered by every other test), in documents without shared glyphs. */
function corpus(): string[][] {
  const docs: { chars: string[]; seen: Set<string> }[] = [];
  for (let cp = 0x80; cp <= 0xffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (classifyPdfChar(ch) !== 'ok' || ch === '\n') continue;
    const key = pdfGlyphKey(ch);
    let doc = docs.find((d) => !d.seen.has(key));
    if (!doc) docs.push((doc = { chars: [], seen: new Set() }));
    doc.seen.add(key);
    doc.chars.push(ch);
  }
  return docs.map((d) => d.chars);
}

beforeAll(() => loadPdfFonts());

describe('PDF text layer: supported characters extract as themselves', () => {
  const roundTrip = async (chars: string[], wrong: string[]) => {
    const split = Array.from({ length: Math.ceil(chars.length / PER_LINE) }, (_, i) => chars.slice(i * PER_LINE, i * PER_LINE + PER_LINE).join(''));
    const joined = planTextLayer(split.map((text) => ({ text, bold: false }))).faults;
    const lines = split.flatMap((l, i) => (joined.has(i) ? [...l] : [l]));
    const plan = planTextLayer(lines.map((text) => ({ text, bold: false })));
    expect([...plan.faults], 'a single character never faults').toEqual([]);
    plan.apply();
    const pdf = await renderToBuffer(
      <Document>
        <Page size="A4" orientation="landscape" style={{ fontFamily: PDF_FONT_FAMILY, fontSize: 7, padding: 20 }} wrap>
          {lines.map((l, i) => (
            <Text key={i}>{`[${i}]${l}`}</Text>
          ))}
        </Page>
      </Document>,
    );
    const text = pdfPageStrings(pdf)
      .map((p) => p.join(''))
      .join('');
    const got = new Map<number, string>();
    // Each line starts with its ASCII marker; ASCII is not in the corpus, so the markers split the text layer unambiguously.
    for (const m of text.matchAll(/\[(\d+)\]([^[]*)/g)) got.set(Number(m[1]), (got.get(Number(m[1])) ?? '') + m[2]);
    lines.forEach((l, i) => {
      const g = [...(got.get(i) ?? '')];
      [...l].forEach((ch, k) => {
        if (g[k] !== ch) wrong.push(`U+${ch.codePointAt(0)!.toString(16).toUpperCase()}->${g[k] === undefined ? '(missing)' : `U+${g[k].codePointAt(0)!.toString(16).toUpperCase()}`}`);
      });
      if (g.length !== [...l].length) wrong.push(`line ${i}: ${g.length} characters, expected ${[...l].length}`);
    });
  };

  it('every supported character in the corpus round-trips through the PDF text layer exactly', async () => {
    const docs = corpus();
    expect(docs.flat().length).toBeGreaterThan(40_000);
    const wrong: string[] = [];
    // Forward, then the twin documents again in reverse: the text layer must not depend on render history.
    for (const chars of [...docs, ...docs.slice(1).reverse()]) await roundTrip(chars, wrong);
    expect(wrong.slice(0, 40)).toEqual([]);
  }, 600_000);
});

// Text-layer fidelity of the bundled PDF fonts: every supported code point of the
// Basic Multilingual Plane (Han and Hangul syllables sampled, one of each pair of
// glyph twins) is drawn with the report's font family, and the PDF's text layer
// (decoded through the embedded fonts' ToUnicode maps, as a PDF reader does) must
// give back exactly the input. This is what "supported" means for the PDF.
import { Document, Page, Text, renderToBuffer } from '@react-pdf/renderer';
import { beforeAll, describe, expect, it } from 'vitest';
import { classifyPdfChar, loadPdfFonts, PDF_FONT_FAMILY, pdfGlyphKey } from './pdfFonts';
import { pdfPageStrings } from './fixtures/pdfText';

const SAMPLED = /^[\p{Script=Han}가-힣]$/u;
const PER_LINE = 40;

/** Supported code points from U+0080 (ASCII is covered by every other test), one per shared glyph. */
function corpus(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let cp = 0x80; cp <= 0xffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (classifyPdfChar(ch) !== 'ok' || ch === '\n') continue;
    if (SAMPLED.test(ch) && cp % 13 !== 0) continue;
    const key = pdfGlyphKey(ch);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ch);
  }
  return out;
}

beforeAll(() => loadPdfFonts());

describe('PDF text layer: supported characters extract as themselves', () => {
  it('every supported character in the corpus round-trips through the PDF text layer exactly', async () => {
    const chars = corpus();
    expect(chars.length).toBeGreaterThan(5_000);
    const lines = Array.from({ length: Math.ceil(chars.length / PER_LINE) }, (_, i) => chars.slice(i * PER_LINE, i * PER_LINE + PER_LINE).join(''));
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
    const wrong: string[] = [];
    lines.forEach((l, i) => {
      const g = [...(got.get(i) ?? '')];
      [...l].forEach((ch, k) => {
        if (g[k] !== ch) wrong.push(`U+${ch.codePointAt(0)!.toString(16).toUpperCase()}->${g[k] === undefined ? '(missing)' : `U+${g[k].codePointAt(0)!.toString(16).toUpperCase()}`}`);
      });
      if (g.length !== [...l].length) wrong.push(`line ${i}: ${g.length} characters, expected ${[...l].length}`);
    });
    expect(wrong.slice(0, 40)).toEqual([]);
  }, 120_000);
});

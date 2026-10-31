// Text-layer fidelity of the bundled PDF fonts: EVERY supported code point of the
// Basic Multilingual Plane is drawn with the report's font family and the PDF's
// text layer (decoded through the embedded fonts' ToUnicode maps, as a PDF reader
// does) must give back exactly the input. Code points that share a glyph go to
// separate PDFs (one glyph has one text per document), and characters the font
// joins with a neighbor are drawn alone, so the corpus also proves that every
// supported character is exact on its own. This is what "supported" means.
import { Document, Page, Text, renderToBuffer } from '@react-pdf/renderer';
import { beforeAll, describe, expect, it } from 'vitest';
import { classifyPdfChar, loadPdfFonts, PDF_FONT_FAMILY, pdfGlyphKey, planTextLayer } from './pdfFonts';
import { pdfPageStrings } from './fixtures/pdfText';

const PER_LINE = 40;

/** Every supported code point from U+0080 (ASCII is covered by every other test), split into documents without shared glyphs. */
function documents(): string[][] {
  const docs: { chars: string[]; keys: Set<string> }[] = [];
  for (let cp = 0x80; cp <= 0xffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (classifyPdfChar(ch) !== 'ok' || ch === '\n') continue;
    const key = pdfGlyphKey(ch);
    let doc = docs.find((d) => !d.keys.has(key));
    if (!doc) docs.push((doc = { chars: [], keys: new Set() }));
    doc.keys.add(key);
    doc.chars.push(ch);
  }
  return docs.map((d) => d.chars);
}

/** Lines of PER_LINE characters; a line whose characters the font joins is split into one line per character. */
function lines(chars: string[]): string[] {
  const out = Array.from({ length: Math.ceil(chars.length / PER_LINE) }, (_, i) => chars.slice(i * PER_LINE, i * PER_LINE + PER_LINE).join(''));
  const joined = planTextLayer(out.map((text) => ({ text, bold: false }))).faults;
  return out.flatMap((l, i) => (joined.has(i) ? [...l] : [l]));
}

async function roundTrip(ls: string[]): Promise<string[]> {
  const plan = planTextLayer(ls.map((text) => ({ text, bold: false })));
  expect([...plan.faults].map((i) => ls[i]), 'single characters never fault').toEqual([]);
  plan.apply();
  const pdf = await renderToBuffer(
    <Document>
      <Page size="A4" orientation="landscape" style={{ fontFamily: PDF_FONT_FAMILY, fontSize: 7, padding: 20 }} wrap>
        {ls.map((l, i) => (
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
  ls.forEach((l, i) => {
    const g = [...(got.get(i) ?? '')];
    [...l].forEach((ch, k) => {
      if (g[k] !== ch) wrong.push(`U+${ch.codePointAt(0)!.toString(16).toUpperCase()}->${g[k] === undefined ? '(missing)' : `U+${g[k].codePointAt(0)!.toString(16).toUpperCase()}`}`);
    });
    if (g.length !== [...l].length) wrong.push(`line ${i}: ${g.length} characters, expected ${[...l].length}`);
  });
  return wrong;
}

beforeAll(() => loadPdfFonts());

describe('PDF text layer: supported characters extract as themselves', () => {
  it('every supported BMP code point round-trips through the PDF text layer exactly (glyph twins in separate PDFs, both orders)', async () => {
    const docs = documents();
    const total = docs.reduce((n, d) => n + d.length, 0);
    expect(total).toBeGreaterThan(40_000);
    expect(docs.length).toBeGreaterThan(1);
    const wrong: string[] = [];
    // Forward, then the twin documents again in reverse order: the text layer must not depend on render history.
    for (const d of [...docs, ...docs.slice(1).reverse(), docs[0]]) wrong.push(...(await roundTrip(lines(d))));
    expect(wrong.slice(0, 40)).toEqual([]);
  }, 600_000);
});

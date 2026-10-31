// Bundled PDF fonts (server-only; loaded from local files, never fetched). The
// engagement report PDF draws text with Noto Sans (Latin, Greek, Cyrillic and
// common symbols, regular and bold) and falls back per character to Noto Sans
// CJK SC (Han, kana, Hangul; one regular weight, so bold CJK text prints at the
// regular weight). Both are under the SIL Open Font License 1.1, vendored
// unmodified under assets/fonts with their sources and sha256 in
// assets/fonts/PROVENANCE.md; notices in docs/THIRD_PARTY_NOTICES.md.
//
// Supported scripts are DECLARED, not "every character a font happens to have":
// a character is drawn only when it is in the Basic Multilingual Plane, its
// script is in PDF_SUPPORTED_SCRIPTS, it is not a mark, control, format,
// private-use or unassigned code point, and a bundled font draws it as exactly
// ONE glyph (a letter the font only composes from base + mark, such as the
// Vietnamese/Yoruba dot below, loses its mark in the PDF text layer). Code points
// that share one glyph ("glyph twins", e.g. U+4E00 and the radical U+2F00), and
// contextual forms or ligatures that reuse another character's glyph, are fine
// alone but collide in the text layer when both appear in one PDF
// (textLayerFaults simulates the text layer per document). Everything else is classified (complex script or
// combining mark, emoji, other) so the PDF can refuse it instead of drawing a
// missing-glyph box or a wrong text layer; pdfExtraction.test.tsx round-trips
// every supported code point through the PDF text layer.
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Font } from '@react-pdf/renderer';

/** Resolved from the working directory (the repository root in tests, /app in the image, which copies the whole tree). */
export const PDF_FONT_DIR = path.join(process.cwd(), 'assets', 'fonts');
export const PDF_FONTS = [
  { family: 'NotoSans', fontWeight: 400, file: 'NotoSans-Regular.ttf', sha256: 'f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8' },
  { family: 'NotoSans', fontWeight: 700, file: 'NotoSans-Bold.ttf', sha256: '87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9' },
  { family: 'NotoSansCJKsc', fontWeight: 400, file: 'NotoSansCJKsc-Regular.otf', sha256: '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b' },
] as const;
/** The style fontFamily: react-pdf takes each character from the first family that has a glyph for it. */
export const PDF_FONT_FAMILY = ['NotoSans', 'NotoSansCJKsc'];
export const PDF_SUPPORTED_SCRIPTS = ['Latin', 'Greek', 'Cyrillic', 'Common', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Bopomofo'] as const;

type Glyph = { id: number; codePoints: number[] };
type Face = {
  hasGlyphForCodePoint(cp: number): boolean;
  glyphForCodePoint(cp: number): Glyph;
  characterSet: number[];
  layout(text: string, features?: unknown, ...rest: unknown[]): { glyphs: Glyph[] };
};
let loaded: Promise<Face[]> | null = null;
/** In PDF_FONTS order: 0 Noto Sans regular, 1 Noto Sans bold, 2 Noto Sans CJK SC. */
let faces: Face[] | null = null;

/** Registers the bundled fonts once, by absolute local path, after checking each file's sha256 (a wrong or missing file fails closed). */
export function loadPdfFonts(): Promise<void> {
  loaded ??= (async () => {
    for (const f of PDF_FONTS) {
      const src = path.join(PDF_FONT_DIR, f.file);
      const sha = createHash('sha256').update(fs.readFileSync(src)).digest('hex');
      if (sha !== f.sha256) throw new Error(`bundled PDF font ${f.file} does not match its recorded sha256`);
      Font.register({ family: f.family, src, fontWeight: f.fontWeight });
    }
    return Promise.all(
      PDF_FONTS.map(async (f) => {
        const source = Font.getFont({ fontFamily: f.family, fontWeight: f.fontWeight });
        await source.load();
        return fixTextLayer(source.data as unknown as Face);
      }),
    );
  })().catch((err: unknown) => {
    loaded = null;
    throw err;
  });
  return loaded.then((f) => {
    faces = f;
  });
}

/** Ligature and contextual-alternate features are off for every layout of these faces (react-pdf passes none). */
export const PDF_LAYOUT_FEATURES = Object.freeze({ liga: false, clig: false, dlig: false, calt: false });
/** Code points that rank below another code point drawn with the same glyph (typographic spaces, compatibility forms, radicals, dingbats, Extension A). */
const SECONDARY = /^[\u2000-\u200a\u2700-\u27bf\u2b00-\u2bff\u2e80-\u2fdf\u3400-\u4dbf\uf900-\ufaff]$/u;
const rank = (cp: number) => {
  const ch = String.fromCodePoint(cp);
  return ch.normalize('NFC') !== ch || SECONDARY.test(ch) ? 1 : 0;
};

/**
 * Makes the PDF text layer exact and independent of what was rendered before, on the font objects react-pdf uses:
 * (1) layouts run without ligatures or contextual alternates (a ligature glyph maps to one text for the whole
 * process); (2) fontkit gives each glyph the code points of the FIRST character it was created for, and the PDF's
 * ToUnicode map uses them, so every glyph is created up front for its canonical character (rank, then lowest code
 * point): a glyph twin (U+2F00 next to U+4E00) is then refused by classifyPdfChar instead of extracting as the other.
 */
function fixTextLayer(face: Face): Face {
  const layout = face.layout.bind(face);
  face.layout = (text, features, ...rest) => layout(text, features ?? { ...PDF_LAYOUT_FEATURES }, ...rest); // a fresh object: fontkit adds to it
  for (const cp of [...face.characterSet].sort((a, b) => rank(a) - rank(b) || a - b)) face.glyphForCodePoint(cp);
  return face;
}

const loadedFaces = (): Face[] => {
  if (!faces) throw new Error('PDF fonts are not loaded: await loadPdfFonts() first');
  return faces;
};

export type UnsupportedKind = 'complex' | 'emoji' | 'other';
const SUPPORTED_SCRIPT = new RegExp(`^[${PDF_SUPPORTED_SCRIPTS.map((s) => `\\p{Script=${s}}`).join('')}]$`, 'u');
/** Marks (combining accents need mark positioning), controls, format characters, surrogates, private use, unassigned, line/paragraph separators. */
const NEVER_DRAWN = /^[\p{M}\p{C}\p{Zl}\p{Zp}]$/u;
/** Conjoining Hangul jamo compose into syllables only through shaping (not verified); precomposed syllables are supported. */
const CONJOINING_JAMO = /^[ᄀ-ᇿꥠ-꥿ힰ-퟿]$/u;
/** Vertical kana repeat marks: the CJK face joins them with their neighbor even without ligature features. */
const VERTICAL_REPEAT = /^[\u3031-\u3035]$/u;
const EMOJI = /^[\p{Extended_Pictographic}\p{Emoji_Component}]$/u;
const COMPLEX = new RegExp(
  `^[\\p{M}\\u1100-\\u11FF\\uA960-\\uA97F\\uD7B0-\\uD7FF${[
    'Arabic', 'Hebrew', 'Syriac', 'Thaana', 'Nko', 'Samaritan', 'Mandaic', 'Adlam', 'Hanifi_Rohingya',
    'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala',
    'Thai', 'Lao', 'Tibetan', 'Myanmar', 'Khmer', 'Mongolian', 'Balinese', 'Javanese', 'Sundanese', 'Tai_Tham', 'New_Tai_Lue', 'Buginese', 'Chakma', 'Limbu',
  ]
    .map((s) => `\\p{Script=${s}}`)
    .join('')}]$`,
  'u',
);

const KINDS = ['ok', 'complex', 'emoji', 'other'] as const;
/** Basic Multilingual Plane results, cached (0 = not yet classified): fixed tables, so hostile text cannot grow them. */
const bmp = new Uint8Array(0x10000);
/** For a drawn character: face * 0x10000 + glyph id + 1 (the glyph its face draws it with). */
const drawn = new Int32Array(0x10000);

/** The face a drawn character uses (react-pdf takes the first family with a glyph) and its single glyph, or null. */
function draw(ch: string, cp: number): { face: number; glyph: number } | null {
  const [regular, bold, cjk] = loadedFaces();
  const face = regular.hasGlyphForCodePoint(cp) ? 0 : cjk.hasGlyphForCodePoint(cp) ? 2 : -1;
  if (face < 0) return null;
  // Exactly one glyph whose text-layer code points are this character (in the bold face too, for Latin).
  const one = (f: Face) => {
    const glyphs = f.layout(ch).glyphs;
    return glyphs.length === 1 && glyphs[0].codePoints.length === 1 && glyphs[0].codePoints[0] === cp ? glyphs[0].id : -1;
  };
  const glyph = one(face === 0 ? regular : cjk);
  return { face, glyph: face === 0 && one(bold) < 0 ? -1 : glyph };
}

function classify(ch: string, cp: number): 'ok' | UnsupportedKind {
  if (ch === '\n') return 'ok';
  if (cp <= 0xffff && SUPPORTED_SCRIPT.test(ch) && !NEVER_DRAWN.test(ch) && !CONJOINING_JAMO.test(ch) && !VERTICAL_REPEAT.test(ch)) {
    const d = draw(ch, cp);
    // Drawn as several glyphs (base + mark: the text layer would lose the mark), or as a glyph twin's glyph.
    if (d && d.glyph < 0) return [...ch.normalize('NFD')].length > 1 ? 'complex' : 'other';
    if (d) {
      drawn[cp] = d.face * 0x10000 + d.glyph + 1;
      return 'ok';
    }
  }
  if (EMOJI.test(ch)) return 'emoji';
  if (COMPLEX.test(ch)) return 'complex';
  return 'other';
}

/** 'ok' when the PDF draws the character (one code point) faithfully, as one glyph of a bundled font; otherwise the reason it cannot. */
export function classifyPdfChar(ch: string): 'ok' | UnsupportedKind {
  const cp = ch.codePointAt(0) as number;
  if (cp > 0xffff) return classify(ch, cp);
  if (bmp[cp] === 0) bmp[cp] = KINDS.indexOf(classify(ch, cp)) + 1;
  return KINDS[bmp[cp] - 1];
}

/** The face that draws a supported character (0 Noto Sans, 2 Noto Sans CJK SC); -1 for a newline or an unsupported character. */
export function pdfCharFace(ch: string): number {
  if (ch === '\n' || classifyPdfChar(ch) !== 'ok') return -1;
  return Math.floor((drawn[ch.codePointAt(0) as number] - 1) / 0x10000);
}

/** "face:glyph" of a supported character: two code points with the same key are one glyph in the PDF. */
export function pdfGlyphKey(ch: string): string {
  const face = pdfCharFace(ch);
  if (face < 0) throw new Error('character is not drawn by the bundled fonts');
  return `${face}:${(drawn[ch.codePointAt(0) as number] - 1) % 0x10000}`;
}

type Laid = { id: number; codePoints: number[] };

/**
 * Simulates the PDF text layer for one document. react-pdf lays out each run of one face (fontkit, default
 * features: ligatures, contextual alternates, composition), and the PDF maps each glyph to the code points of the
 * FIRST run that used it (pdfkit's ToUnicode). A value is faulty when its runs do not map back to its exact text
 * (a glyph dropped a code point) or when one of its glyphs already maps to different code points elsewhere in the
 * document (glyph twins such as U+4E00 and U+2F00, or the U+FB01 ligature next to an "fi" ligature): either way a
 * reader would extract the wrong text. Returns the indexes of the faulty values (both sides of a collision).
 * Items are the shown texts with their weight (bold Latin uses its own face); unsupported characters must
 * already be removed or substituted.
 */
export function textLayerFaults(items: { text: string; bold: boolean }[]): Set<number> {
  const all = loadedFaces();
  const owner = new Map<string, { text: string; index: number }>();
  const faults = new Set<number>();
  items.forEach(({ text, bold }, index) => {
    let start = 0;
    const cps = [...text];
    while (start < cps.length) {
      const face = pdfCharFace(cps[start]);
      let end = start + 1;
      while (end < cps.length && pdfCharFace(cps[end]) === face) end += 1;
      const run = cps.slice(start, end).join('');
      start = end;
      if (face < 0) continue; // newlines (layout only) and characters the caller has already refused
      const f = face === 0 && bold ? 1 : face;
      const glyphs = all[f].layout(run).glyphs as Laid[];
      if (glyphs.map((g) => String.fromCodePoint(...g.codePoints)).join('') !== run) faults.add(index);
      for (const g of glyphs) {
        const key = `${f}:${g.id}`;
        const mapped = String.fromCodePoint(...g.codePoints);
        const first = owner.get(key);
        if (!first) owner.set(key, { text: mapped, index });
        else if (first.text !== mapped) faults.add(index).add(first.index);
      }
    }
  });
  return faults;
}

/** The kinds of unsupported characters in one text value (empty: the PDF can draw all of it). */
export function unsupportedKinds(text: string): Set<UnsupportedKind> {
  const kinds = new Set<UnsupportedKind>();
  for (const ch of text) {
    const k = classifyPdfChar(ch);
    if (k !== 'ok') kinds.add(k);
  }
  return kinds;
}

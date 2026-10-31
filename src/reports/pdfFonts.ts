// Bundled PDF fonts (server-only; loaded from local files, never fetched). The
// engagement report PDF draws text with Noto Sans (Latin, Greek, Cyrillic and
// common symbols, regular and bold) and falls back per character to Noto Sans
// CJK SC (Han, kana, Hangul; one regular weight, so bold CJK text prints at the
// regular weight). Both are under the SIL Open Font License 1.1, vendored
// unmodified under assets/fonts with their sources and sha256 in
// assets/fonts/PROVENANCE.md; notices in docs/THIRD_PARTY_NOTICES.md.
//
// Supported scripts are DECLARED, not "every character a font happens to have":
// a character is drawn only when its script is in PDF_SUPPORTED_SCRIPTS, it is
// not a mark, control, format, private-use or unassigned code point, and a
// bundled font has a glyph for it. Everything else is classified (complex
// script or combining mark, emoji, other) so the PDF can refuse it instead of
// drawing a missing-glyph box: react-pdf here does no complex-script shaping
// or right-to-left layout that this repository has verified.
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

type Glyphs = { hasGlyphForCodePoint(cp: number): boolean };
let loaded: Promise<Glyphs[]> | null = null;
let glyphs: Glyphs[] | null = null;

/** Registers the bundled fonts once, by absolute local path, after checking each file's sha256 (a wrong or missing file fails closed). */
export function loadPdfFonts(): Promise<void> {
  loaded ??= (async () => {
    for (const f of PDF_FONTS) {
      const src = path.join(PDF_FONT_DIR, f.file);
      const sha = createHash('sha256').update(fs.readFileSync(src)).digest('hex');
      if (sha !== f.sha256) throw new Error(`bundled PDF font ${f.file} does not match its recorded sha256`);
      Font.register({ family: f.family, src, fontWeight: f.fontWeight });
    }
    // The regular faces decide coverage (the bold face has the same character set; pdfFonts.test.ts).
    return Promise.all(
      PDF_FONTS.filter((f) => f.fontWeight === 400).map(async (f) => {
        const source = Font.getFont({ fontFamily: f.family, fontWeight: 400 });
        await source.load();
        return source.data as unknown as Glyphs;
      }),
    );
  })().catch((err: unknown) => {
    loaded = null;
    throw err;
  });
  return loaded.then((g) => {
    glyphs = g;
  });
}

const fonts = (): Glyphs[] => {
  if (!glyphs) throw new Error('PDF fonts are not loaded: await loadPdfFonts() first');
  return glyphs;
};

export type UnsupportedKind = 'complex' | 'emoji' | 'other';
const SUPPORTED_SCRIPT = new RegExp(`^[${PDF_SUPPORTED_SCRIPTS.map((s) => `\\p{Script=${s}}`).join('')}]$`, 'u');
/** Marks (combining accents need mark positioning), controls, format characters, surrogates, private use, unassigned, line/paragraph separators. */
const NEVER_DRAWN = /^[\p{M}\p{C}\p{Zl}\p{Zp}]$/u;
/** Conjoining Hangul jamo compose into syllables only through shaping (not verified); precomposed syllables are supported. */
const CONJOINING_JAMO = /^[ᄀ-ᇿꥠ-꥿ힰ-퟿]$/u;
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
/** Basic Multilingual Plane results, cached (0 = not yet classified): a fixed 64 KiB table, so hostile text cannot grow it. */
const bmp = new Uint8Array(0x10000);

function classify(ch: string, cp: number): 'ok' | UnsupportedKind {
  if (ch === '\n' || ch === '\t') return 'ok';
  if (SUPPORTED_SCRIPT.test(ch) && !NEVER_DRAWN.test(ch) && !CONJOINING_JAMO.test(ch) && fonts().some((f) => f.hasGlyphForCodePoint(cp))) return 'ok';
  if (EMOJI.test(ch)) return 'emoji';
  if (COMPLEX.test(ch)) return 'complex';
  return 'other';
}

/** 'ok' when the PDF draws the character (one code point) faithfully with a bundled font; otherwise the reason it cannot. */
export function classifyPdfChar(ch: string): 'ok' | UnsupportedKind {
  const cp = ch.codePointAt(0) as number;
  if (cp > 0xffff) return classify(ch, cp);
  if (bmp[cp] === 0) bmp[cp] = KINDS.indexOf(classify(ch, cp)) + 1;
  return KINDS[bmp[cp] - 1];
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

// Bundled PDF fonts: pinned local files (hashes recorded in PROVENANCE.md),
// registered by local path only, never fetched; the declared supported scripts
// and the deterministic classification of everything else.
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Font } from '@react-pdf/renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { orderPdfObjects, stableSubsetTags } from './pdfBytes';
import { classifyPdfChar, loadPdfFonts, PDF_FONT_DIR, PDF_FONT_FAMILY, PDF_FONTS, PDF_SUPPORTED_SCRIPTS, unsupportedKinds } from './pdfFonts';

const ROOT = path.resolve(__dirname, '..', '..');
/** The sources Font.register received while the fonts loaded (captured once: spies are reset between tests). */
const registered: unknown[] = [];
beforeAll(async () => {
  const spy = vi.spyOn(Font, 'register');
  await loadPdfFonts();
  registered.push(...spy.mock.calls.map(([d]) => (d as { src: unknown }).src));
  spy.mockRestore();
});

describe('bundled font files', () => {
  it('are registered once each, by an absolute local path under assets/fonts (never a URL or data URI)', () => {
    expect(PDF_FONT_DIR).toBe(path.join(ROOT, 'assets', 'fonts'));
    const srcs = registered as string[];
    expect(srcs).toEqual(PDF_FONTS.map((f) => path.join(PDF_FONT_DIR, f.file)));
    for (const s of srcs) {
      expect(path.isAbsolute(s), s).toBe(true);
      expect(s).not.toMatch(/^(https?:|data:|\/\/)/);
      expect(fs.existsSync(s), s).toBe(true);
    }
    expect(PDF_FONT_FAMILY).toEqual(['NotoSans', 'NotoSansCJKsc']);
  });

  it('match the sha256 recorded in code and in assets/fonts/PROVENANCE.md (pinned, unmodified upstream files)', () => {
    const provenance = fs.readFileSync(path.join(PDF_FONT_DIR, 'PROVENANCE.md'), 'utf8');
    for (const f of PDF_FONTS) {
      const sha = createHash('sha256').update(fs.readFileSync(path.join(PDF_FONT_DIR, f.file))).digest('hex');
      expect(sha, f.file).toBe(f.sha256);
      expect(provenance, f.file).toMatch(new RegExp(`${f.file.replace('.', '\\.')}.*${sha}`));
    }
    expect(fs.readdirSync(PDF_FONT_DIR).sort()).toEqual(['NotoSans-Bold.ttf', 'NotoSans-Regular.ttf', 'NotoSansCJKsc-Regular.otf', 'PROVENANCE.md']);
  });

  it('ship with the copyright notices and the full OFL 1.1 text in docs/THIRD_PARTY_NOTICES.md', () => {
    const notices = fs.readFileSync(path.join(ROOT, 'docs', 'THIRD_PARTY_NOTICES.md'), 'utf8');
    expect(notices).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
    expect(notices).toContain('Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)');
    expect(notices).toContain('© 2014-2021 Adobe (http://www.adobe.com/).');
    expect(notices).toContain('THE FONT SOFTWARE IS PROVIDED "AS IS"');
  });

  it('a file that does not match its hash fails closed (no font is registered from it)', async () => {
    vi.resetModules();
    const fresh = await import('./pdfFonts');
    const read = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => Buffer.from('not a font'));
    await expect(fresh.loadPdfFonts()).rejects.toThrow(/NotoSans-Regular\.ttf does not match its recorded sha256/);
    read.mockRestore();
  });

  it('the bold face covers every character the regular face covers', async () => {
    const face = async (w: number) => {
      const s = Font.getFont({ fontFamily: 'NotoSans', fontWeight: w });
      await s.load();
      return s.data as unknown as { hasGlyphForCodePoint(c: number): boolean };
    };
    const [regular, bold] = [await face(400), await face(700)];
    const missing: number[] = [];
    for (let c = 0; c <= 0xffff; c += 1) if (regular.hasGlyphForCodePoint(c) && !bold.hasGlyphForCodePoint(c)) missing.push(c);
    expect(missing).toEqual([]);
  });
});

describe('declared supported scripts and the classification of everything else', () => {
  it('declares Latin, Greek, Cyrillic, common symbols and Chinese/Japanese/Korean only', () => {
    expect([...PDF_SUPPORTED_SCRIPTS]).toEqual(['Latin', 'Greek', 'Cyrillic', 'Common', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Bopomofo']);
  });

  it.each([
    ['Latin accents', 'Éclair Çà ñ ü Øresund ß ŁŻ ǅ Ẽ'],
    ['Cyrillic', 'Москва Счёт Ґ Ӂ'],
    ['Greek', 'Ωμέγα λογαριασμός ἄ'],
    ['Simplified Chinese', '成本报告 云计算费用'],
    ['Japanese', 'コスト 請求書 ひらがな ｶﾅ'],
    ['Korean', '비용 보고서 ㄱ'],
    ['currency and punctuation', '€ £ ¥ ₩ ₽ ₹ $ − – — “” ‘’ … · ¢ ©®™ 、。「」（）'],
    ['amounts', '-2.61370000000 20.62033861840 1,200 (3.00)'],
    ['tab and newline', 'a\tb\nc'],
  ])('%s: every character is drawn', (_, text) => {
    expect([...text].filter((ch) => classifyPdfChar(ch) !== 'ok')).toEqual([]);
  });

  it.each([
    ['Arabic', 'مرحبا', 'complex'],
    ['Hebrew', 'שלום', 'complex'],
    ['Devanagari', 'नमस्ते', 'complex'],
    ['Tamil', 'வணக்கம்', 'complex'],
    ['Thai', 'สวัสดี', 'complex'],
    ['Khmer', 'សួស្តី', 'complex'],
    ['combining acute (decomposed é)', '́', 'complex'],
    ['conjoining Hangul jamo', '가', 'complex'],
    ['emoji', '😀', 'emoji'],
    ['emoji skin tone', '\u{1F3FD}', 'emoji'],
    ['emoji presentation selector', '️', 'emoji'],
    ['zero width joiner', '‍', 'emoji'],
    ['regional indicator (flag half)', '\u{1F1FA}', 'emoji'],
    ['right-to-left mark', '‏', 'other'],
    ['NUL control', '\u0000', 'other'],
    ['private use', '', 'other'],
    ['noncharacter', '￿', 'other'],
    ['lone surrogate', '\uD800', 'other'],
    ['Armenian (not declared)', 'Բ', 'other'],
    ['Georgian (not declared)', 'ა', 'other'],
    ['line separator', ' ', 'other'],
  ])('%s is %s', (_, text, kind) => {
    for (const ch of text) expect(classifyPdfChar(ch), JSON.stringify(ch)).toBe(kind);
  });

  it('unsupportedKinds collects the distinct kinds in one value', () => {
    expect([...unsupportedKinds('Paid 👍🏽 مرحبا ')].sort()).toEqual(['complex', 'emoji', 'other']);
    expect(unsupportedKinds('Москва 成本 비용 コスト').size).toBe(0);
  });

  it('classification is the same on every call (the cached table answers like a fresh classification)', () => {
    const sample = ['A', 'é', '成', '😀', '́', '', 'م'];
    const first = sample.map(classifyPdfChar);
    expect(sample.map(classifyPdfChar)).toEqual(first);
  });
});

describe('deterministic bytes', () => {
  it('rewrites the random six-letter subset tags in order of first appearance, keeping the byte length', () => {
    const pdf = Buffer.from('/BaseFont /QWERTY+NotoSans-Regular /FontName /QWERTY+NotoSans-Regular /BaseFont /ZXCVBN+NotoSansCJKsc-Regular stream ABCDEF+x', 'latin1');
    const out = stableSubsetTags(pdf);
    expect(out.toString('latin1')).toBe('/BaseFont /RATIOA+NotoSans-Regular /FontName /RATIOA+NotoSans-Regular /BaseFont /RATIOB+NotoSansCJKsc-Regular stream ABCDEF+x');
    expect(out.length).toBe(pdf.length);
  });

  it('writes objects in object-number order with a rebuilt xref; each object keeps its bytes', () => {
    const objs = ['1 0 obj\n<< /Type /Catalog >>\nendobj\n', '2 0 obj\n<< /Length 3 >>\nstream\nabc\nendstream\nendobj\n'];
    const head = '%PDF-1.3\n';
    const xref = (offs: number[]) => `xref\n0 3\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    const swapped = head + objs[1] + objs[0];
    const pdf = Buffer.from(`${swapped}${xref([head.length + objs[1].length, head.length])}trailer\n<<\n/Size 3\n/Root 1 0 R\n>>\nstartxref\n${swapped.length}\n%%EOF\n`, 'latin1');
    const ordered = head + objs[0] + objs[1];
    expect(orderPdfObjects(pdf).toString('latin1')).toBe(`${ordered}${xref([head.length, head.length + objs[0].length])}trailer\n<<\n/Size 3\n/Root 1 0 R\n>>\nstartxref\n${ordered.length}\n%%EOF\n`);
    expect(() => orderPdfObjects(Buffer.from('%PDF-1.3\nno xref'))).toThrow(/unexpected PDF layout/);
  });
});

describe('offline: PDF generation never touches the network', () => {
  it('a child process with fetch, http(s), net, tls and dns trapped renders a CJK report; nothing was attempted', () => {
    const child = path.join(__dirname, 'fixtures', 'pdfOfflineChild.tsx');
    const r = spawnSync(process.execPath, ['--import', 'tsx', child], { cwd: ROOT, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
    expect(r.signal, r.stderr).toBeNull();
    const out = JSON.parse(r.stdout.trim()) as { attempts: string[]; dataUrlFetches: number; bytes: number; trapped: string[] };
    expect(out.trapped).toEqual(['fetch', 'http.request', 'http.get', 'https.request', 'https.get', 'net.connect', 'net.createConnection', 'tls.connect', 'dns.lookup']);
    expect(out.attempts).toEqual([]);
    expect(out.bytes).toBeGreaterThan(0);
    // The layout engine's WebAssembly is read from an in-memory data: URL (no network); nothing else used fetch.
    expect(out.dataUrlFetches).toBeLessThanOrEqual(1);
  }, 35_000);
});

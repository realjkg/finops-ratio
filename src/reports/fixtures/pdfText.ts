// Test-only helpers to read text back out of the engagement report PDF without a
// PDF library: (1) walk the @react-pdf element tree (calling our function
// components), and (2) inflate the PDF content streams (Node zlib) and decode the
// hex strings of the TJ text operators through each embedded font's ToUnicode
// CMap (the bundled fonts are Identity-H: two bytes per glyph). A font without a
// ToUnicode CMap (a built-in one) is read one byte per character, Windows-1252.
import zlib from 'zlib';
import type { ReactElement } from 'react';

/** Text nodes of a react-pdf element tree, in document order. */
export function treeTexts(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === 'string' || typeof n === 'number') out.push(String(n));
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object' && 'type' in n) {
      const el = n as ReactElement<{ children?: unknown }>;
      walk(typeof el.type === 'function' ? (el.type as (p: unknown) => unknown)(el.props) : el.props.children);
    }
  };
  walk(node);
  return out;
}

const CP1252: Record<number, string> = { 0x80: '€', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x96: '–', 0x97: '—' };

/** Indirect objects: number -> { dict text, inflated stream text (latin1) or null }. */
function pdfObjects(pdf: Buffer): Map<number, { dict: string; stream: string | null }> {
  const s = pdf.toString('latin1');
  const objs = new Map<number, { dict: string; stream: string | null }>();
  for (const m of s.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) {
    const at = m[2].indexOf('stream');
    if (at < 0) {
      objs.set(Number(m[1]), { dict: m[2], stream: null });
      continue;
    }
    const raw = /stream\r?\n([\s\S]*?)\r?\n?endstream/.exec(m[2])?.[1] ?? '';
    let stream: string | null;
    try {
      stream = /\/FlateDecode/.test(m[2].slice(0, at)) ? zlib.inflateSync(Buffer.from(raw, 'latin1')).toString('latin1') : raw;
    } catch {
      stream = null;
    }
    objs.set(Number(m[1]), { dict: m[2].slice(0, at), stream });
  }
  return objs;
}

/** A CMap destination: UTF-16BE hex, possibly with spaces between code units. */
const utf16 = (hex: string) => Buffer.from(hex.replace(/\s+/g, ''), 'hex').swap16().toString('utf16le');

/** A ToUnicode CMap as code (hex) -> text (react-pdf's pdfkit writes bfchar entries only). */
export function parseToUnicode(cmap: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]*)>/g)) map.set(m[1].toLowerCase(), utf16(m[2]));
  }
  return map;
}

/** Every TJ string of every content stream, decoded; one entry per text-showing operator. */
export function pdfShownStrings(pdf: Buffer): string[] {
  return pdfPageStrings(pdf).flat();
}

/** The decoded TJ strings per content stream (react-pdf writes one content stream per page). */
export function pdfPageStrings(pdf: Buffer): string[][] {
  const objs = pdfObjects(pdf);
  // Font resource name (react-pdf names them once per document) -> ToUnicode map, when the font has one.
  const cmaps = new Map<string, Map<string, string> | null>();
  for (const { dict } of objs.values()) {
    for (const fonts of dict.matchAll(/\/Font\s*<<([^>]*)>>/g)) {
      for (const f of fonts[1].matchAll(/\/([\w.-]+)\s+(\d+) 0 R/g)) {
        const ref = /\/ToUnicode (\d+) 0 R/.exec(objs.get(Number(f[2]))?.dict ?? '')?.[1];
        const cmap = ref ? objs.get(Number(ref))?.stream : null;
        cmaps.set(f[1], cmap ? parseToUnicode(cmap) : null);
      }
    }
  }
  const pages: string[][] = [];
  for (const { stream } of objs.values()) {
    if (stream === null || !/\bTJ\b/.test(stream)) continue;
    const out: string[] = [];
    pages.push(out);
    let cmap: Map<string, string> | null = null;
    for (const op of stream.matchAll(/\/([\w.-]+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ/g)) {
      if (op[1] !== undefined) {
        cmap = cmaps.get(op[1]) ?? null;
        continue;
      }
      const hex = [...op[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]).join('');
      let text = '';
      if (cmap) for (let i = 0; i < hex.length; i += 4) text += cmap.get(hex.slice(i, i + 4).toLowerCase()) ?? '\ufffd';
      else
        for (let i = 0; i < hex.length; i += 2) {
          const b = parseInt(hex.slice(i, i + 2), 16);
          text += CP1252[b] ?? String.fromCharCode(b);
        }
      out.push(text);
    }
  }
  return pages.filter((p) => p.length > 0);
}

/** The embedded fonts: BaseFont names of the Type0 fonts and whether each carries a font program (FontFile2/FontFile3). */
export function pdfEmbeddedFonts(pdf: Buffer): { name: string; embedded: boolean; toUnicode: boolean }[] {
  const objs = pdfObjects(pdf);
  const out: { name: string; embedded: boolean; toUnicode: boolean }[] = [];
  for (const { dict } of objs.values()) {
    if (!/\/Subtype \/Type0/.test(dict)) continue;
    const name = /\/BaseFont \/([^\s/]+)/.exec(dict)?.[1] ?? '';
    const desc = /\/DescendantFonts \[(\d+) 0 R\]/.exec(dict)?.[1];
    const fd = /\/FontDescriptor (\d+) 0 R/.exec(objs.get(Number(desc))?.dict ?? '')?.[1];
    out.push({ name, embedded: /\/FontFile[23] \d+ 0 R/.test(objs.get(Number(fd))?.dict ?? ''), toUnicode: /\/ToUnicode \d+ 0 R/.test(dict) });
  }
  return out;
}

export const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

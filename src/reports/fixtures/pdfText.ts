// Test-only helpers to read text back out of the engagement report PDF without a
// PDF library: (1) walk the @react-pdf element tree (calling our function
// components), and (2) inflate the PDF content streams (Node zlib) and decode the
// hex strings of the TJ text operators (the built-in Helvetica uses one byte per
// character, Windows-1252).
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

/** Every TJ/Tj string of every content stream, decoded; one entry per text-showing operator. */
export function pdfShownStrings(pdf: Buffer): string[] {
  const s = pdf.toString('latin1');
  const out: string[] = [];
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let body: string;
    try {
      body = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const op of body.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      const hex = [...op[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]).join('');
      let text = '';
      for (let i = 0; i < hex.length; i += 2) {
        const b = parseInt(hex.slice(i, i + 2), 16);
        text += CP1252[b] ?? String.fromCharCode(b);
      }
      out.push(text);
    }
  }
  return out;
}

export const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

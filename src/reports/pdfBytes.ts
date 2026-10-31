// Identical PDF bytes for the same report model (server-only). react-pdf's
// pdfkit (1) names each embedded font subset with a random six-letter tag and
// (2) writes compressed stream objects in the order their compression finishes,
// which varies between renders in one process. Both are rewritten here without
// touching any object's content: the tags get stable names of the same length,
// and the objects are written in object-number order with a rebuilt xref table.

/** Rewrites the random subset tags in order of first appearance (same length). */
export function stableSubsetTags(pdf: Buffer): Buffer {
  const s = pdf.toString('latin1');
  const tags = [...new Set([...s.matchAll(/\/(?:BaseFont|FontName) \/([A-Z]{6})\+/g)].map((m) => m[1]))];
  if (tags.length > 26) throw new Error('too many embedded font subsets');
  const stable = new Map(tags.map((t, i) => [t, `RATIO${String.fromCharCode(65 + i)}`]));
  return Buffer.from(s.replace(/\/([A-Z]{6})\+/g, (m, t: string) => (stable.has(t) ? `/${stable.get(t)}+` : m)), 'latin1');
}

/** Writes the objects in object-number order (each object's bytes unchanged) and rebuilds the xref table and startxref. */
export function orderPdfObjects(pdf: Buffer): Buffer {
  const s = pdf.toString('latin1');
  const xrefAt = s.lastIndexOf('\nxref\n') + 1;
  const head = /^xref\n0 (\d+)\n0000000000 65535 f \n/.exec(s.slice(xrefAt));
  const tail = /startxref\n\d+(\n%%EOF\n?)$/.exec(s);
  if (xrefAt === 0 || !head || !tail) throw new Error('unexpected PDF layout: no single classic xref table');
  const count = Number(head[1]) - 1;
  const entries = s.slice(xrefAt + head[0].length).split('\n').slice(0, count);
  if (!entries.every((e) => /^\d{10} 00000 n $/.test(e))) throw new Error('unexpected PDF layout: free or malformed xref entries');
  const at = entries.map((e, i) => ({ num: i + 1, offset: Number(e.slice(0, 10)) })).sort((a, b) => a.offset - b.offset);
  const body = new Map(at.map((o, k) => [o.num, s.slice(o.offset, k + 1 < at.length ? at[k + 1].offset : xrefAt)]));
  let out = s.slice(0, at[0].offset);
  const offsets: number[] = [];
  for (let n = 1; n <= count; n += 1) {
    offsets.push(out.length);
    out += body.get(n);
  }
  const trailer = s.slice(s.indexOf('trailer', xrefAt), tail.index);
  const xrefStart = out.length;
  out += `xref\n0 ${count + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}${trailer}startxref\n${xrefStart}${tail[1]}`;
  return Buffer.from(out, 'latin1');
}

export const deterministicPdf = (pdf: Buffer): Buffer => orderPdfObjects(stableSubsetTags(pdf));

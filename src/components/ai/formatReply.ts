// Turns a plain-text Frank reply into display blocks: a heading, paragraphs,
// section labels, bulleted and numbered lists, and the source footnote. Pure,
// no HTML: the component renders the blocks as React elements, so nothing the
// reply contains is ever interpreted as markup.
//
// The reply text itself is unchanged (spoken replies, tests and copy/paste all
// read it as before); only its presentation changes.

export interface Inline {
  text: string;
  strong: boolean;
}

export type ReplyBlock =
  | { kind: 'heading'; inline: Inline[] }
  | { kind: 'label'; inline: Inline[] }
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'source'; inline: Inline[] };

const BOLD = /\*\*([^*\n]+)\*\*/g;
const HEADING_MD = /^\s{0,3}#{1,4}\s+(.+?)\s*#*\s*$/;
const WHOLE_BOLD = /^\s*\*\*([^*\n]+)\*\*\s*$/;
const BULLET = /^\s*(?:•|-|\*|·)\s+(.+)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.+)$/;
/** A short line that introduces what follows: "Assumptions:", "What I can't do:". */
const LABEL = /^\s*([^\s•*#-][^.!?]{0,58}):\s*$/;
const SOURCE = /^\s*Source:\s/;

/** Split **bold** runs out of a line; anything unmatched stays literal text. */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of line.matchAll(BOLD)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: line.slice(last, at), strong: false });
    out.push({ text: m[1], strong: true });
    last = at + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), strong: false });
  return out.length > 0 ? out : [{ text: line, strong: false }];
}

export function parseReply(content: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  let list: { ordered: boolean; items: Inline[][] } | null = null;
  const flush = () => {
    if (list) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };

  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flush();
      return;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = numbered !== null;
      const text = (bullet ?? numbered)![1];
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push(parseInline(text));
      return;
    }
    flush();
    const md = HEADING_MD.exec(line);
    const whole = WHOLE_BOLD.exec(line);
    if (md) blocks.push({ kind: 'heading', inline: parseInline(md[1]) });
    else if (whole && i === first) blocks.push({ kind: 'heading', inline: [{ text: whole[1], strong: true }] });
    else if (whole) blocks.push({ kind: 'label', inline: [{ text: whole[1], strong: true }] });
    else if (SOURCE.test(line)) blocks.push({ kind: 'source', inline: parseInline(line.trim()) });
    else if (LABEL.test(line)) blocks.push({ kind: 'label', inline: parseInline(line.trim().replace(/:$/, '')) });
    else blocks.push({ kind: 'paragraph', inline: parseInline(line.trim()) });
  });
  flush();
  return blocks;
}

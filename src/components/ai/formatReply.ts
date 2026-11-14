// Turns a plain-text Frank reply into display blocks: a heading, paragraphs,
// section labels, bulleted and numbered lists, preformatted text (code fences
// and pipe tables) and the source footnote. Pure, no HTML: the component
// renders the blocks as React elements, so nothing the reply contains is ever
// interpreted as markup.
//
// The reply text itself is unchanged (spoken replies, tests and copy/paste all
// read it as before); only its presentation changes. No word is dropped,
// reordered or renumbered: ordered lists keep the numbers that were typed.

export interface Inline {
  text: string;
  strong: boolean;
  /** An inline code span: shown literally, never parsed for **bold**. */
  code?: boolean;
}

export type ReplyBlock =
  | { kind: 'heading'; inline: Inline[] }
  | { kind: 'label'; inline: Inline[] }
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'list'; ordered: false; items: Inline[][] }
  | { kind: 'list'; ordered: true; items: Inline[][]; numbers: number[] }
  | { kind: 'pre'; text: string }
  | { kind: 'source'; inline: Inline[] };

const BOLD = /\*\*([^*\n]+)\*\*/g;
/** CommonMark ATX heading; a closing "#" run counts only after a space ("# Use C#" keeps its "#"). */
const HEADING_MD = /^\s{0,3}#{1,4}\s+(.+?)(?:\s+#+)?\s*$/;
const WHOLE_BOLD = /^\s*\*\*([^*\n]+)\*\*\s*$/;
const BULLET = /^\s*(?:•|-|\*|·)\s+(.+)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.+)$/;
/** A short title that introduces what follows ("Next questions:", "What I can't do:"): words only, no figures. */
const LABEL = /^\s*([A-Z][A-Za-z'’ /&-]{0,48}):\s*$/;
const SOURCE = /^\s*Source:\s/;
/**
 * CommonMark fences: an opening fence's info string may not contain its fence
 * character (so "```sql SELECT 1```" on one line is inline code, kept as text),
 * and only a bare fence line closes it.
 */
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const isOpening = (m: RegExpExecArray): boolean => m[1][0] !== '`' || !m[2].includes('`');
const isClosing = (line: string, open: string): boolean => {
  const m = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return m !== null && m[1][0] === open[0] && m[1].length >= open.length;
};
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/** **bold** runs in text that holds no code span; anything unmatched stays literal. */
function boldRuns(text: string, out: Inline[]): void {
  let last = 0;
  for (const m of text.matchAll(BOLD)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), strong: false });
    out.push({ text: m[1], strong: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), strong: false });
}

/**
 * Code spans in `text` as [open, close) delimiter positions (CommonMark): a run of
 * N backticks is closed by the next run of exactly N; a run with no such closer is
 * literal text. Linear: every backtick run is collected once, and each opener finds
 * its closer through a per-length cursor that only moves forward.
 */
function codeSpans(text: string): Array<{ start: number; end: number; ticks: number }> {
  const runs: Array<{ at: number; n: number }> = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let n = 0;
    while (text[i + n] === '`') n++;
    runs.push({ at: i, n });
    i += n;
  }
  const byLength = new Map<number, number[]>();
  runs.forEach((r, k) => {
    const list = byLength.get(r.n);
    if (list) list.push(k);
    else byLength.set(r.n, [k]);
  });
  const cursor = new Map<number, number>();
  const spans: Array<{ start: number; end: number; ticks: number }> = [];
  for (let k = 0; k < runs.length; k++) {
    const { at, n } = runs[k];
    const same = byLength.get(n) as number[];
    let c = cursor.get(n) ?? 0;
    while (c < same.length && same[c] <= k) c++;
    cursor.set(n, c);
    if (c >= same.length) continue; // no closer: literal backticks
    const close = same[c];
    spans.push({ start: at, end: runs[close].at + n, ticks: n });
    k = close; // runs inside the span are code, not delimiters
  }
  return spans;
}

/**
 * Split text into code spans and **bold** runs. Code spans are found first, so
 * asterisks inside code stay literal; an unmatched backtick run is plain text.
 * Line breaks inside a span become spaces and every other space is kept; line
 * breaks in plain text become spaces (CommonMark soft breaks).
 */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const span of codeSpans(line)) {
    boldRuns(line.slice(last, span.start), out);
    let body = line.slice(span.start + span.ticks, span.end - span.ticks).replace(/\n/g, ' ');
    if (body.length > 2 && body.startsWith(' ') && body.endsWith(' ') && body.trim() !== '') body = body.slice(1, -1);
    out.push({ text: body, strong: false, code: true });
    last = span.end;
  }
  boldRuns(line.slice(last), out);
  for (const seg of out) if (!seg.code) seg.text = seg.text.replace(/\n/g, ' ');
  return out.length > 0 ? out : [{ text: line, strong: false }];
}

/** A line that can only continue a paragraph (no block marker of any kind). */
function isPlainLine(line: string): boolean {
  if (line.trim() === '') return false;
  const fence = FENCE_OPEN.exec(line);
  if (fence && isOpening(fence)) return false;
  return ![TABLE_ROW, NUMBERED, BULLET, HEADING_MD, WHOLE_BOLD, SOURCE, LABEL].some((rx) => rx.test(line));
}

/** Items keep their raw text until the list closes, so a code span can run over wrapped lines. */
type OpenList = { ordered: false; items: string[] } | { ordered: true; items: string[]; numbers: number[] };

export function parseReply(content: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  let list: OpenList | null = null;
  const flush = () => {
    if (list) {
      // Each item is parsed once, with its wrapped lines, so spans keep their text.
      const items = list.items.map((raw) => parseInline(raw.trimEnd()));
      blocks.push(list.ordered ? { kind: 'list', ordered: true, items, numbers: list.numbers } : { kind: 'list', ordered: false, items });
    }
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();

    // Code fence: everything up to the closing fence (or the end) is kept verbatim.
    const fence = FENCE_OPEN.exec(line);
    if (fence && isOpening(fence)) {
      flush();
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !isClosing(lines[j], fence[1])) body.push(lines[j++]);
      blocks.push({ kind: 'pre', text: body.join('\n') });
      i = j;
      continue;
    }
    // Pipe table: consecutive rows are kept verbatim so their columns stay aligned.
    if (TABLE_ROW.test(line)) {
      flush();
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i].trimEnd())) rows.push(lines[i++].trimEnd());
      i--;
      blocks.push({ kind: 'pre', text: rows.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      // A blank line does not end an open list: an indented paragraph or another
      // item of the same kind may follow (a loose list). Anything else ends it.
      if (!list) flush();
      continue;
    }

    // An indented line that is not itself a list item continues the last item
    // ("1. Foo" / "   continues here"). Unindented lines stay their own paragraph.
    const open: OpenList | null = list;
    if (open && /^(?:\s{2,}|\t)\S/.test(line) && !NUMBERED.test(line) && !BULLET.test(line)) {
      // The raw line (trailing spaces kept): a code span may need them; flush() trims the item's end.
      open.items[open.items.length - 1] += `\n${lines[i].replace(/^\s+/, '')}`;
      continue;
    }

    // Match on the raw line so an item keeps trailing spaces a code span may need.
    const numbered = NUMBERED.exec(lines[i]);
    const bullet = numbered ? null : BULLET.exec(lines[i]);
    if (numbered) {
      const current: OpenList | null = list;
      if (current && current.ordered) {
        current.items.push(numbered[2]);
        current.numbers.push(Number(numbered[1]));
      } else {
        flush();
        list = { ordered: true, items: [numbered[2]], numbers: [Number(numbered[1])] };
      }
      continue;
    }
    if (bullet) {
      const current: OpenList | null = list;
      if (current && !current.ordered) current.items.push(bullet[1]);
      else {
        // A bullet nested under a numbered item is its own list; the numbered
        // list resumes with its typed numbers afterwards.
        flush();
        list = { ordered: false, items: [bullet[1]] };
      }
      continue;
    }

    flush();
    const md = HEADING_MD.exec(line);
    const whole = WHOLE_BOLD.exec(line);
    if (md) blocks.push({ kind: 'heading', inline: parseInline(md[1]) });
    else if (whole && i === first) blocks.push({ kind: 'heading', inline: [{ text: whole[1], strong: true }] });
    else if (whole) blocks.push({ kind: 'label', inline: [{ text: whole[1], strong: true }] });
    else if (SOURCE.test(line)) blocks.push({ kind: 'source', inline: parseInline(line.trim()) });
    else if (LABEL.test(line)) blocks.push({ kind: 'label', inline: parseInline(line.trim().replace(/:$/, '')) });
    else {
      // A run of plain paragraph lines (no list, table, fence, heading, label or
      // blank line between them) is read once. Without a backtick each line is its
      // own paragraph, as before. With one, the exact code spans over the whole run
      // decide where paragraphs end: at every line break outside a span, so a span
      // can continue over lines (CommonMark). Leading indentation is dropped; spaces
      // inside a span are kept. Each line is scanned once, so this is linear.
      let end = i + 1;
      while (end < lines.length && isPlainLine(lines[end].trimEnd())) end++;
      const run = lines.slice(i, end);
      if (!run.some((l) => l.includes('`'))) {
        for (const l of run) blocks.push({ kind: 'paragraph', inline: parseInline(l.trim()) });
      } else {
        const joined = run.map((l) => l.replace(/^\s+/, '')).join('\n');
        const spans = codeSpans(joined);
        let from = 0;
        let s = 0;
        for (let at = joined.indexOf('\n'); at >= 0; at = joined.indexOf('\n', at + 1)) {
          while (s < spans.length && spans[s].end <= at) s++;
          if (s < spans.length && spans[s].start < at) continue; // inside a span
          blocks.push({ kind: 'paragraph', inline: parseInline(joined.slice(from, at).trimEnd()) });
          from = at + 1;
        }
        blocks.push({ kind: 'paragraph', inline: parseInline(joined.slice(from).trimEnd()) });
      }
      i = end - 1;
    }
  }
  flush();
  return blocks;
}

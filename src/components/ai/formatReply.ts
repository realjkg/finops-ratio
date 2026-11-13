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

/** Length of the first backtick run in `text` that no run of the same length closes, or 0. */
function openTickRun(text: string): number {
  for (let i = 0; i < text.length; ) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let n = 0;
    while (text[i + n] === '`') n++;
    let closed = -1;
    for (let j = i + n; j < text.length; ) {
      if (text[j] !== '`') {
        j++;
        continue;
      }
      let m = 0;
      while (text[j + m] === '`') m++;
      if (m === n) {
        closed = j;
        break;
      }
      j += m;
    }
    if (closed < 0) return n;
    i = closed + n;
  }
  return 0;
}

/**
 * Split a line into code spans and **bold** runs. Code spans are found first
 * (CommonMark: a run of N backticks closed by a run of exactly N), so asterisks
 * inside code stay literal; an unmatched backtick run is plain text.
 */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      text += line[i++];
      continue;
    }
    let n = 0;
    while (line[i + n] === '`') n++;
    let close = -1;
    for (let j = i + n; j < line.length; ) {
      if (line[j] !== '`') {
        j++;
        continue;
      }
      let m = 0;
      while (line[j + m] === '`') m++;
      if (m === n) {
        close = j;
        break;
      }
      j += m;
    }
    if (close < 0) {
      text += line.slice(i, i + n);
      i += n;
      continue;
    }
    let body = line.slice(i + n, close).replace(/\n/g, ' ');
    if (body.length > 2 && body.startsWith(' ') && body.endsWith(' ') && body.trim() !== '') body = body.slice(1, -1);
    boldRuns(text, out);
    text = '';
    out.push({ text: body, strong: false, code: true });
    i = close + n;
  }
  boldRuns(text, out);
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

type OpenList = { ordered: false; items: Inline[][] } | { ordered: true; items: Inline[][]; numbers: number[] };

export function parseReply(content: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  let list: OpenList | null = null;
  const flush = () => {
    if (list) blocks.push(list.ordered ? { kind: 'list', ordered: true, items: list.items, numbers: list.numbers } : { kind: 'list', ordered: false, items: list.items });
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
      flush();
      continue;
    }

    const numbered = NUMBERED.exec(line);
    const bullet = numbered ? null : BULLET.exec(line);
    if (numbered) {
      const current: OpenList | null = list;
      if (current && current.ordered) {
        current.items.push(parseInline(numbered[2]));
        current.numbers.push(Number(numbered[1]));
      } else {
        flush();
        list = { ordered: true, items: [parseInline(numbered[2])], numbers: [Number(numbered[1])] };
      }
      continue;
    }
    if (bullet) {
      const current: OpenList | null = list;
      if (current && !current.ordered) current.items.push(parseInline(bullet[1]));
      else {
        // A bullet nested under a numbered item is its own list; the numbered
        // list resumes with its typed numbers afterwards.
        flush();
        list = { ordered: false, items: [parseInline(bullet[1])] };
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
      // A code span left open on this line continues over the following plain
      // paragraph lines (never into a list, table, fence, heading or blank
      // line) until a backtick run of the same length closes it (CommonMark).
      let text = line.trim();
      const open = openTickRun(text);
      if (open > 0) {
        let j = i + 1;
        const joined: string[] = [];
        // Bounded lookahead keeps a reply with a stray backtick linear in practice.
        while (j < lines.length && j - i <= 40 && isPlainLine(lines[j].trimEnd())) {
          joined.push(lines[j].trim());
          if (openTickRun([text, ...joined].join('\n')) !== open) break;
          j++;
        }
        if (j < lines.length && joined.length > 0 && openTickRun([text, ...joined].join('\n')) !== open) {
          text = [text, ...joined].join('\n');
          i = j;
        }
      }
      blocks.push({ kind: 'paragraph', inline: parseInline(text) });
    }
  }
  flush();
  return blocks;
}

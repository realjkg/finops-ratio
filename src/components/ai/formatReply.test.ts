// Frank replies are plain text with a light convention (a **bold** first line,
// "Label:" lines, "•" bullets, numbered rows, a "Source:" line). parseReply
// turns that into blocks for readable rendering without touching the text.

import { describe, expect, it } from 'vitest';
import { parseInline, parseReply } from './formatReply';

const SAMPLE = [
  "**I'm Frank Coster, Ratio's FinOps accountability partner**",
  'I help leaders see what their AI spend returns.',
  'What I do:',
  '• Show cost, value and Value / cost',
  '• Rank teams',
  "What I can't do:",
  '• Guess',
  'In this view: 11 workloads across 7 teams, $41,212/mo of spend at Value / cost 8.6× (value evidence: assumed).',
  'Source: demo dataset as of 2026-06-25 — computed by a deterministic mock (no LLM, nothing live).',
  'Next questions:',
  '• "Which team is driving the highest cost?"',
].join('\n');

describe('parseReply', () => {
  it('splits a reply into heading, paragraphs, labels, lists and the source line', () => {
    expect(parseReply(SAMPLE).map((b) => b.kind)).toEqual([
      'heading', 'paragraph', 'label', 'list', 'label', 'list', 'paragraph', 'source', 'label', 'list',
    ]);
  });

  it('drops the ** markers and the trailing colon of labels, and keeps every word', () => {
    const blocks = parseReply(SAMPLE);
    const text = (b: (typeof blocks)[number]) =>
      b.kind === 'list' ? b.items.map((i) => i.map((s) => s.text).join('')).join('|') : b.kind === 'pre' ? b.text : b.inline.map((s: { text: string }) => s.text).join('');
    expect(text(blocks[0])).toBe("I'm Frank Coster, Ratio's FinOps accountability partner");
    expect(text(blocks[2])).toBe('What I do');
    expect(text(blocks[3])).toBe('Show cost, value and Value / cost|Rank teams');
    expect(blocks.map(text).join(' ')).not.toContain('**');
  });

  it('a line with a colon in the middle is a paragraph, not a label', () => {
    expect(parseReply('**H**\nIn this view: 3 workloads.')[1].kind).toBe('paragraph');
    expect(parseReply('**H**\nContext: Legal costs $1/mo at Value / cost 2.0× (value evidence: assumed).')[1].kind).toBe('paragraph');
  });

  it('numbered rows become an ordered list, and a bold line after the first is a label', () => {
    const blocks = parseReply('**Top teams**\n1. Legal — $1/mo\n2. Sales — $2/mo\n**Assumptions**\n- a');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'list', 'label', 'list']);
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: true });
    expect(blocks[3]).toMatchObject({ kind: 'list', ordered: false });
  });

  it('markdown headings from a live model are headings', () => {
    expect(parseReply('## Summary\ntext')[0]).toMatchObject({ kind: 'heading' });
  });

  it('plain text with no convention is paragraphs, unchanged', () => {
    expect(parseReply('one\ntwo')).toEqual([
      { kind: 'paragraph', inline: [{ text: 'one', strong: false }] },
      { kind: 'paragraph', inline: [{ text: 'two', strong: false }] },
    ]);
    expect(parseReply('')).toEqual([]);
  });
});

describe('parseInline', () => {
  it('marks **bold** runs and leaves an unmatched ** as text', () => {
    expect(parseInline('a **b** c')).toEqual([
      { text: 'a ', strong: false },
      { text: 'b', strong: true },
      { text: ' c', strong: false },
    ]);
    expect(parseInline('2 ** 3')).toEqual([{ text: '2 ** 3', strong: false }]);
  });
});

describe('review round 6: live-model reply shapes keep their text', () => {
  it('ordered lists keep the numbers that were typed', () => {
    const a = parseReply('3. Marketing\n4. Legal');
    expect(a[0]).toMatchObject({ kind: 'list', ordered: true, numbers: [3, 4] });
    const b = parseReply('1. CX\n2. Revenue\n\nNote on the next one\n\n3. Marketing');
    expect(b.flatMap((x) => (x.kind === 'list' && x.ordered ? [x.numbers] : []))).toEqual([[1, 2], [3]]);
    const c = parseReply('1. First step\n   - sub point\n2. Second step');
    expect(c.flatMap((x) => (x.kind === 'list' && x.ordered ? x.numbers : []))).toEqual([1, 2]);
  });

  it('a heading keeps a "#" that is part of a word; a closing "#" run is dropped', () => {
    const text = (s: string) => {
      const b = parseReply(s)[0];
      return b.kind === 'heading' ? b.inline.map((i) => i.text).join('') : null;
    };
    expect(text('# Use C#')).toBe('Use C#');
    expect(text('## Title ##')).toBe('Title');
  });

  it.each(['2 alert(s), most severe first:', 'Total: $1,234 / mo:', '6 initiative(s) need attention:'])('a data line is a paragraph, not a label: %s', (line) => {
    expect(parseReply(`**H**\n${line}`)[1].kind).toBe('paragraph');
  });

  it.each(['Next questions:', "What I can't do:", 'Follow-ups:', 'Assumptions:', 'Who I am:'])('a short title line is a label: %s', (line) => {
    expect(parseReply(`**H**\n${line}`)[1].kind).toBe('label');
  });

  it('code fences and pipe tables keep their exact text and spacing', () => {
    const fenced = '**H**\n```\na   b\n  c\n```\nafter';
    expect(parseReply(fenced)).toEqual([
      { kind: 'heading', inline: [{ text: 'H', strong: true }] },
      { kind: 'pre', text: 'a   b\n  c' },
      { kind: 'paragraph', inline: [{ text: 'after', strong: false }] },
    ]);
    const table = '| Team | Cost |\n|---|---|\n| Legal | $1 |';
    expect(parseReply(table)).toEqual([{ kind: 'pre', text: table }]);
  });
});

describe('review round 7: inline code on one line is text, not a fence', () => {
  it('a one-line ```code``` span keeps its text', () => {
    const blocks = parseReply('```sql SELECT * FROM t```\nafter');
    expect(blocks).toEqual([
      { kind: 'paragraph', inline: [{ text: 'sql SELECT * FROM t', strong: false, code: true }] },
      { kind: 'paragraph', inline: [{ text: 'after', strong: false }] },
    ]);
    expect(parseReply('```bash npm install```')[0]).toMatchObject({ kind: 'paragraph' });
  });

  it('a line that starts with ``` but has more text is not a closing fence', () => {
    expect(parseReply('```\ncode\n``` then text\n```\nafter')).toEqual([
      { kind: 'pre', text: 'code\n``` then text' },
      { kind: 'paragraph', inline: [{ text: 'after', strong: false }] },
    ]);
  });

  it('a ~~~ fence closes only on ~~~, and a fence with an info string still opens', () => {
    expect(parseReply('~~~\na ``` b\n~~~')).toEqual([{ kind: 'pre', text: 'a ``` b' }]);
    expect(parseReply('```ts\nconst a = 1;\n```')).toEqual([{ kind: 'pre', text: 'const a = 1;' }]);
  });
});

describe('review round 9 (Copilot): code spans and tilde fences', () => {
  it('asterisks inside a code span are literal, not bold', () => {
    expect(parseInline('Use `2 ** 3 ** 2` here')).toEqual([
      { text: 'Use ', strong: false },
      { text: '2 ** 3 ** 2', strong: false, code: true },
      { text: ' here', strong: false },
    ]);
    expect(parseInline('**bold** and `a**b**c`')).toEqual([
      { text: 'bold', strong: true },
      { text: ' and ', strong: false },
      { text: 'a**b**c', strong: false, code: true },
    ]);
  });

  it('a one-line ```code``` span is inline code with its full text', () => {
    expect(parseReply('```sql SELECT * FROM t```')).toEqual([
      { kind: 'paragraph', inline: [{ text: 'sql SELECT * FROM t', strong: false, code: true }] },
    ]);
  });

  it('an unmatched backtick stays literal text', () => {
    expect(parseInline('a ` b **c**')).toEqual([
      { text: 'a ` b ', strong: false },
      { text: 'c', strong: true },
    ]);
  });

  it('a ~~~ fence may carry "~" in its info string', () => {
    expect(parseReply('~~~ lang~tag\nx ~ y\n~~~\nafter')).toEqual([
      { kind: 'pre', text: 'x ~ y' },
      { kind: 'paragraph', inline: [{ text: 'after', strong: false }] },
    ]);
  });
});

describe('review round 11 (Copilot): multi-line code spans', () => {
  it('a code span that continues over plain lines is one span with its text intact', () => {
    expect(parseReply('see `alpha\n2 ** 3 ** 2\nomega` end')).toEqual([
      {
        kind: 'paragraph',
        inline: [
          { text: 'see ', strong: false },
          { text: 'alpha 2 ** 3 ** 2 omega', strong: false, code: true },
          { text: ' end', strong: false },
        ],
      },
    ]);
  });

  it('an unclosed backtick does not join lines', () => {
    expect(parseReply('a `b\nc').map((b) => b.kind)).toEqual(['paragraph', 'paragraph']);
  });

  it('a code span never continues into a list, table, fence or blank line', () => {
    expect(parseReply('a `b\n- c`').map((b) => b.kind)).toEqual(['paragraph', 'list']);
    expect(parseReply('a `b\n\nc`').map((b) => b.kind)).toEqual(['paragraph', 'paragraph']);
    expect(parseReply('a `b\n| x` | y |').map((b) => b.kind)).toEqual(['paragraph', 'pre']);
  });
});

describe('review round 11: a stray backtick in a long reply stays fast and loses nothing', () => {
  it('5,000 plain lines after an unclosed backtick parse quickly as separate paragraphs', () => {
    const text = ['a ` b', ...Array.from({ length: 5000 }, (_, n) => `line ${n}`)].join('\n');
    const t0 = performance.now();
    const blocks = parseReply(text);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(blocks).toHaveLength(5001);
  });
});

describe('review round 12 (Copilot): multi-line spans keep exact delimiters and spaces', () => {
  const codeOf = (s: string) =>
    parseReply(s).flatMap((b) => (b.kind === 'paragraph' ? b.inline.filter((x) => x.code).map((x) => x.text) : []));

  it('spaces before a line break inside a span are kept (the break becomes one space)', () => {
    expect(codeOf('run `printf "a  \nb"` now')).toEqual(['printf "a   b"']);
  });

  it('a trailing unmatched backtick of the same length does not stop the span from closing', () => {
    expect(codeOf('see `alpha\n2 ** 3 ** 2\nomega` and a stray `')).toEqual(['alpha 2 ** 3 ** 2 omega']);
  });

  it('a new span opened on the closing line is found too', () => {
    // CommonMark strips one space only when the content starts AND ends with one, so "x y " keeps it.
    expect(codeOf('see `alpha\n2 ** 3 ** 2\nomega` then ``x\ny `` done')).toEqual(['alpha 2 ** 3 ** 2 omega', 'x y ']);
    expect(codeOf('a `` x\ny `` b')).toEqual(['x y']);
  });

  it('lines not joined by a span stay separate paragraphs, with their text', () => {
    const blocks = parseReply('one `a` two\nthree **b**');
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'paragraph']);
  });

  it('adversarial stray backticks stay linear', () => {
    const lines = Array.from({ length: 4000 }, (_, n) => `l${n} ${'`'.repeat((n % 7) + 1)} x`);
    const t0 = performance.now();
    parseReply(lines.join('\n'));
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('review round 13: span matching and paragraph splitting are linear', () => {
  it('a 1 MB reply of unclosable backtick runs renders quickly', () => {
    const lines = Array.from({ length: 12000 }, (_, n) => `row ${n} ${'`'.repeat((n % 50) + 1)} ${'x'.repeat(50)}`);
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(900_000);
    const t0 = performance.now();
    const blocks = parseReply(text);
    expect(performance.now() - t0).toBeLessThan(700);
    // Runs of equal length pair up across lines (CommonMark), so count words, not blocks: none is lost.
    const words = blocks.flatMap((b) => (b.kind === 'paragraph' ? b.inline.map((x) => x.text) : [])).join(' ');
    expect(words.match(/\brow \d+\b/g)).toHaveLength(12000);
  });

  it('one long line with increasing run lengths renders quickly', () => {
    const line = Array.from({ length: 600 }, (_, n) => `${'`'.repeat(n + 1)} w`).join(' ');
    const t0 = performance.now();
    parseInline(line);
    expect(performance.now() - t0).toBeLessThan(150);
  });
});

describe('review round 14 (Copilot summary): wrapped list items stay in their item', () => {
  const items = (s: string) =>
    parseReply(s).map((b) => (b.kind === 'list' ? { list: b.items.map((i) => i.map((x) => x.text).join('')), numbers: b.ordered ? b.numbers : null } : { [b.kind]: true }));

  it('an indented line continues the item above it', () => {
    expect(items('1. Foo\n   continues here\n2. Bar')).toEqual([{ list: ['Foo continues here', 'Bar'], numbers: [1, 2] }]);
    expect(items('- item one\n  wraps onto two\n- item two')).toEqual([{ list: ['item one wraps onto two', 'item two'], numbers: null }]);
  });

  it('an indented paragraph after a blank line stays in the item, and the list continues', () => {
    expect(items('- a\n\n  more about a\n- b')).toEqual([{ list: ['a more about a', 'b'], numbers: null }]);
    expect(items('1. a\n\n2. b')).toEqual([{ list: ['a', 'b'], numbers: [1, 2] }]);
  });

  it('an unindented line after a list is still its own paragraph (mock replies rely on this)', () => {
    expect(items('• one\nIn this view: 3 workloads.')).toEqual([{ list: ['one'], numbers: null }, { paragraph: true }]);
    expect(items('- a\n\nAfter the list.')).toEqual([{ list: ['a'], numbers: null }, { paragraph: true }]);
  });
});

describe('review round 16 (Copilot): code spans across wrapped list-item lines', () => {
  const code = (s: string) =>
    parseReply(s).flatMap((b) => (b.kind === 'list' ? b.items.flatMap((i) => i.filter((x) => x.code).map((x) => x.text)) : []));

  it.each([
    ['1. see `alpha\n   2 ** 3 ** 2\n   omega` end\n2. next'],
    ['- see `alpha\n  2 ** 3 ** 2\n  omega` end\n- next'],
  ])('keeps the operators: %s', (s) => {
    expect(code(s)).toEqual(['alpha 2 ** 3 ** 2 omega']);
  });

  it('wrapped plain text still joins with one space', () => {
    const b = parseReply('1. Foo\n   continues here');
    expect(b[0].kind === 'list' ? b[0].items[0].map((x) => x.text).join('') : null).toBe('Foo continues here');
  });
});

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
      { kind: 'paragraph', inline: [{ text: '```sql SELECT * FROM t```', strong: false }] },
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

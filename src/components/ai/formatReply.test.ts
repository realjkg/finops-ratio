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
      b.kind === 'list' ? b.items.map((i) => i.map((s) => s.text).join('')).join('|') : b.inline.map((s) => s.text).join('');
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

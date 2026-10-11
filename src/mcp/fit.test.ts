import { describe, expect, it } from 'vitest';
import { fitToBudget } from './fit';
import { utf8Length, type JsonValue } from './jsonSafe';

const body = (n: number): { [key: string]: JsonValue } => ({
  data: { rows: Array.from({ length: n }, (_, i) => ({ key: `row-${i}`, amount: '1.00' })), total: '100.00' }, revision: 'r1', truncated: false,
});

describe('fitToBudget', () => {
  it('leaves a body that fits, at exactly the cap', () => {
    const b = body(4);
    const size = utf8Length(JSON.stringify(b));
    expect(fitToBudget(b, size, 'truncate')).toEqual({ ok: true, text: JSON.stringify(b), truncated: false });
    expect(b.truncation).toBeUndefined();
  });
  it('truncates one byte under the cap with an explicit marker', () => {
    const b = body(40);
    const size = utf8Length(JSON.stringify(b));
    const r = fitToBudget(b, size - 1, 'truncate');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(utf8Length(r.text)).toBeLessThanOrEqual(size - 1);
      const p = JSON.parse(r.text) as { truncated: boolean; truncation: { reason: string; omitted_items: number; max_bytes: number }; data: { rows: unknown[]; total: string } };
      expect(p.truncated).toBe(true);
      expect(p.truncation.reason).toBe('result_size_cap');
      expect(p.truncation.omitted_items + p.data.rows.length).toBe(40);
      expect(p.data.total).toBe('100.00');
    }
  });
  it('rejects in reject mode', () => {
    expect(fitToBudget(body(40), 100, 'reject')).toEqual({ ok: false });
  });
  it('gives up when emptying arrays is not enough', () => {
    expect(fitToBudget(body(40), 20, 'truncate')).toEqual({ ok: false });
    expect(fitToBudget({ data: { s: 'x'.repeat(500) }, truncated: false }, 100, 'truncate')).toEqual({ ok: false });
  });
});

import { describe, expect, it } from 'vitest';
import type { CostFinding } from '@/costsource/CostSourceClient';
import { RECOMMEND_INPUT_ERROR_MESSAGES } from './errors';
import { fromCostFinding, toCostFindings } from './findings';
import { toJsonSafe } from './money';
import {
  DEFAULT_MAX_OUTPUT_PER_CURRENCY, MAX_CORROBORATING, MAX_OUTPUT_PER_CURRENCY, MAX_RANK_INPUT, rankRecommendations, scoreOf,
} from './rank';
import { lcg } from './testRows';
import type { NativeRecommendation } from './types';
import { validateNativeRecommendation } from './validate';

const B = (n: number | string) => BigInt(n);

function nr(over: Partial<NativeRecommendation> = {}): NativeRecommendation {
  return {
    source: 'aws_compute_optimizer', sourceId: 's1', resourceId: 'res-1', category: 'rightsize',
    currentSpendMinor: B(100000), estimatedSavingsMinor: B(10000), currency: 'USD',
    confidence: 'high', effort: 'low', risk: 'low', evidence: ['e'], period: 'monthly', valueContext: 'none_available',
    ...over,
  };
}
const flat = (r: ReturnType<typeof rankRecommendations>, c = 'USD') => r.groups.find((g) => g.currency === c)?.items ?? [];

describe('scoring formula', () => {
  it('hand computed', () => {
    // high/low/low: 10000 x 10000 x 10000 x 10000 = 1e16 -> weighted 10000
    expect(scoreOf(nr())).toBe(B('10000000000000000'));
    expect(flat(rankRecommendations([nr()]))[0].weightedSavingsMinor).toBe(B(10000));
    // medium/medium/medium: 10000 x 7000 x 8500 x 8000 = 4.76e15 -> 4760
    const m = nr({ confidence: 'medium', effort: 'medium', risk: 'medium' });
    expect(flat(rankRecommendations([m]))[0].weightedSavingsMinor).toBe(B(4760));
    // low/high/high: 10000 x 4000 x 6500 x 5500 = 1.43e15 -> 1430
    expect(flat(rankRecommendations([nr({ confidence: 'low', effort: 'high', risk: 'high' })]))[0].weightedSavingsMinor).toBe(B(1430));
  });
  it('ranks by weighted savings, not raw savings', () => {
    const big = nr({ sourceId: 'big', resourceId: 'a', estimatedSavingsMinor: B(10000), confidence: 'low', effort: 'high', risk: 'high' });
    const small = nr({ sourceId: 'small', resourceId: 'b', estimatedSavingsMinor: B(5000) });
    const items = flat(rankRecommendations([big, small]));
    expect(items.map((i) => [i.sourceId, i.rank])).toEqual([['small', 1], ['big', 2]]);
  });
  it('states the formula', () => {
    expect(rankRecommendations([]).formula).toContain('confidenceWeight');
  });
});

describe('de-duplication', () => {
  it('keeps the higher-confidence item and records the others as corroborating', () => {
    const a = nr({ source: 'aws_compute_optimizer', sourceId: 'a', confidence: 'medium', estimatedSavingsMinor: B(9000) });
    const b = nr({ source: 'azure_advisor', sourceId: 'b', confidence: 'high', estimatedSavingsMinor: B(8000) });
    const c = nr({ source: 'pointfive', sourceId: 'c', confidence: 'low', estimatedSavingsMinor: B(12000) });
    const r = rankRecommendations([a, b, c]);
    const items = flat(r);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'azure_advisor', sourceId: 'b', corroboratingTotal: 2 });
    expect(items[0].corroborating.map((x) => x.sourceId)).toEqual(['a', 'c']);
    expect(items[0].estimatedSavingsMinor).toBe(B(8000));
  });
  it('equal confidence: higher savings wins, then source name', () => {
    const a = nr({ source: 'azure_advisor', sourceId: 'a', estimatedSavingsMinor: B(5000) });
    const b = nr({ source: 'gcp_recommender', sourceId: 'b', estimatedSavingsMinor: B(6000) });
    expect(flat(rankRecommendations([a, b]))[0].sourceId).toBe('b');
    const c = nr({ source: 'azure_advisor', sourceId: 'c', estimatedSavingsMinor: B(5000) });
    const d = nr({ source: 'aws_compute_optimizer', sourceId: 'd', estimatedSavingsMinor: B(5000) });
    expect(flat(rankRecommendations([c, d]))[0].sourceId).toBe('d');
  });
  it('matches resource ids case-insensitively but not by guesswork', () => {
    const a = nr({ resourceId: 'ARN:Instance/I-1', sourceId: 'a' });
    const b = nr({ source: 'azure_advisor', resourceId: 'arn:instance/i-1', sourceId: 'b' });
    expect(flat(rankRecommendations([a, b]))).toHaveLength(1);
    const c = nr({ source: 'azure_advisor', resourceId: 'i-1', sourceId: 'c' });
    expect(flat(rankRecommendations([a, c]))).toHaveLength(2);
  });
  it('counts an exact repeat (same source and id) without listing it as corroboration', () => {
    const r = rankRecommendations([nr(), nr(), nr({ source: 'azure_advisor', sourceId: 'z' })]);
    expect(r.exactDuplicatesDropped).toBe(1);
    expect(flat(r)[0].corroboratingTotal).toBe(1);
  });
  it('lists at most MAX_CORROBORATING but counts them all', () => {
    const many = Array.from({ length: MAX_CORROBORATING + 5 }, (_, i) => nr({ sourceId: `s${i}`, confidence: 'low' }));
    const [top] = flat(rankRecommendations([nr({ sourceId: 'top' }), ...many]));
    expect(top.sourceId).toBe('top');
    expect(top.corroborating).toHaveLength(MAX_CORROBORATING);
    expect(top.corroboratingTotal).toBe(MAX_CORROBORATING + 5);
  });
  it('never merges across currencies', () => {
    const r = rankRecommendations([nr(), nr({ currency: 'EUR' })]);
    expect(r.groups.map((g) => g.currency)).toEqual(['EUR', 'USD']);
    expect(r.groups.every((g) => g.items.length === 1 && g.items[0].corroboratingTotal === 0)).toBe(true);
  });
  it('keeps different categories separate, flags them, and does not double count', () => {
    const a = nr({ category: 'rightsize', estimatedSavingsMinor: B(4000), sourceId: 'a' });
    const b = nr({ category: 'idle', estimatedSavingsMinor: B(10000), sourceId: 'b' });
    const g = rankRecommendations([a, b]).groups[0];
    expect(g.items).toHaveLength(2);
    expect(g.listedSavingsMinor).toBe(B(14000));
    expect(g.nonOverlappingSavingsMinor).toBe(B(10000));
    expect(g.items.find((i) => i.category === 'idle')?.otherCategoriesOnResource).toEqual(['rightsize']);
  });
});

describe('implausible items', () => {
  const cases: Array<[string, unknown, string]> = [
    ['negative savings', nr({ estimatedSavingsMinor: B(-1) }), 'negative_savings'],
    ['zero savings', nr({ estimatedSavingsMinor: B(0) }), 'zero_savings'],
    ['savings above spend', nr({ estimatedSavingsMinor: B(100001) }), 'savings_exceed_spend'],
    ['NaN savings', nr({ estimatedSavingsMinor: NaN as never }), 'non_finite_amount'],
    ['Infinity savings', nr({ estimatedSavingsMinor: Infinity as never }), 'non_finite_amount'],
    ['number savings', nr({ estimatedSavingsMinor: 5 as never }), 'non_integer_amount'],
    ['negative spend', nr({ currentSpendMinor: B(-5) }), 'invalid_amount'],
    ['NaN spend', nr({ currentSpendMinor: NaN as never }), 'non_finite_amount'],
    ['absurd savings', nr({ estimatedSavingsMinor: B('10000000000000000'), currentSpendMinor: null }), 'implausible_amount'],
    ['unknown source', nr({ source: 'x' as never }), 'invalid_source'],
    ['bad currency', nr({ currency: 'usd' }), 'invalid_currency'],
    ['bad confidence', nr({ confidence: 'certain' as never }), 'invalid_rating'],
    ['bad category', nr({ category: 'delete' as never }), 'invalid_category'],
    ['empty resource', nr({ resourceId: '' }), 'invalid_resource'],
    ['evidence not array', nr({ evidence: 'x' as never }), 'invalid_evidence'],
    ['too much evidence', nr({ evidence: new Array(9).fill('e') }), 'invalid_evidence'],
    ['wrong period', nr({ period: 'annual' as never }), 'invalid_shape'],
    ['null', null, 'not_an_object'],
    ['array', [], 'not_an_object'],
  ];
  for (const [name, item, code] of cases) {
    it(`rejects ${name}; the batch survives`, () => {
      const r = rankRecommendations([nr({ sourceId: 'ok1', resourceId: 'x' }), item as NativeRecommendation, nr({ sourceId: 'ok2', resourceId: 'y' })]);
      expect(flat(r)).toHaveLength(2);
      expect(r.rejected).toBe(1);
      expect(r.rejectedByReason).toEqual({ [code]: 1 });
    });
  }
  it('savings equal to spend is allowed; null spend is allowed', () => {
    expect(validateNativeRecommendation(nr({ estimatedSavingsMinor: B(100000) })).ok).toBe(true);
    expect(validateNativeRecommendation(nr({ currentSpendMinor: null })).ok).toBe(true);
  });
  it('a throwing item is rejected, not thrown, and not echoed', () => {
    const hostile = { get source(): string { throw new Error('SECRET-MARKER-123'); } };
    const r = rankRecommendations([hostile as never, nr()]);
    expect(r.rejectedByReason).toEqual({ unexpected_error: 1 });
    expect(JSON.stringify(toJsonSafe(r))).not.toContain('SECRET-MARKER-123');
  });
});

describe('caps', () => {
  const distinct = (n: number, c = 'USD') =>
    Array.from({ length: n }, (_, i) => nr({ sourceId: `s${i}`, resourceId: `r${i}`, currency: c, estimatedSavingsMinor: B(1000 + i), currentSpendMinor: null }));
  it('default per-currency output cap, with the truncated count', () => {
    const g = rankRecommendations(distinct(DEFAULT_MAX_OUTPUT_PER_CURRENCY)).groups[0];
    expect(g.items).toHaveLength(DEFAULT_MAX_OUTPUT_PER_CURRENCY);
    expect(g.truncated).toBe(0);
    const over = rankRecommendations(distinct(DEFAULT_MAX_OUTPUT_PER_CURRENCY + 1)).groups[0];
    expect(over.items).toHaveLength(DEFAULT_MAX_OUTPUT_PER_CURRENCY);
    expect(over.truncated).toBe(1);
    expect(over.items[0].estimatedSavingsMinor).toBe(B(1000 + DEFAULT_MAX_OUTPUT_PER_CURRENCY));
  });
  it('hard output cap is 1000 per currency; 1001 is refused as an option', () => {
    const g = rankRecommendations(distinct(MAX_OUTPUT_PER_CURRENCY + 1), { maxOutputPerCurrency: MAX_OUTPUT_PER_CURRENCY }).groups[0];
    expect(g.items).toHaveLength(MAX_OUTPUT_PER_CURRENCY);
    expect(g.truncated).toBe(1);
    expect(() => rankRecommendations([], { maxOutputPerCurrency: MAX_OUTPUT_PER_CURRENCY + 1 })).toThrow(RECOMMEND_INPUT_ERROR_MESSAGES.INVALID_INPUT);
    for (const bad of [0, -1, 1.5, NaN]) expect(() => rankRecommendations([], { maxOutputPerCurrency: bad })).toThrow();
  });
  it('caps apply per currency', () => {
    const r = rankRecommendations([...distinct(3, 'USD'), ...distinct(3, 'EUR')], { maxOutputPerCurrency: 2 });
    expect(r.groups.map((g) => [g.currency, g.items.length, g.truncated])).toEqual([['EUR', 2, 1], ['USD', 2, 1]]);
  });
  it('input cap: exactly MAX_RANK_INPUT works, one past is refused', () => {
    const items = new Array<NativeRecommendation>(MAX_RANK_INPUT).fill(nr());
    const r = rankRecommendations(items);
    expect(r.inputCount).toBe(MAX_RANK_INPUT);
    expect(r.exactDuplicatesDropped).toBe(MAX_RANK_INPUT - 1);
    items.push(nr());
    expect(() => rankRecommendations(items)).toThrow(RECOMMEND_INPUT_ERROR_MESSAGES.TOO_MANY_ITEMS);
    expect(() => rankRecommendations('x' as never)).toThrow(RECOMMEND_INPUT_ERROR_MESSAGES.INVALID_INPUT);
  });
});

describe('determinism', () => {
  it('ties are broken by a documented total order, whatever the input order', () => {
    // Identical scores and savings: order must come from source, then sourceId, then resource.
    const items = [
      nr({ source: 'gcp_recommender', sourceId: 'a', resourceId: 'r1' }),
      nr({ source: 'azure_advisor', sourceId: 'b', resourceId: 'r2' }),
      nr({ source: 'azure_advisor', sourceId: 'a', resourceId: 'r3' }),
      nr({ source: 'aws_compute_optimizer', sourceId: 'z', resourceId: 'r4' }),
    ];
    const expected = ['aws_compute_optimizer:z', 'azure_advisor:a', 'azure_advisor:b', 'gcp_recommender:a'];
    const rnd = lcg(5);
    for (let k = 0; k < 20; k++) {
      const shuffled = [...items];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      expect(flat(rankRecommendations(shuffled)).map((i) => `${i.source}:${i.sourceId}`)).toEqual(expected);
    }
  });
  it('identical output on repeat; does not mutate inputs', () => {
    const items = [nr(), nr({ source: 'azure_advisor', sourceId: 'q' }), nr({ resourceId: 'other' })];
    const before = JSON.stringify(toJsonSafe(items));
    const a = rankRecommendations(items);
    const b = rankRecommendations(items);
    expect(toJsonSafe(a)).toEqual(toJsonSafe(b));
    expect(JSON.stringify(toJsonSafe(items))).toBe(before);
  });
});

describe('CostFinding adapters', () => {
  const ctx = { currency: 'USD', detectedAt: '2026-01-02T03:04:05Z' };
  it('emits compatible findings for one currency only', () => {
    const out = toCostFindings([nr({ estimatedSavingsMinor: B(7008) }), nr({ currency: 'EUR', sourceId: 'e' })], ctx);
    expect(out.skippedOtherCurrency).toBe(1);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      id: 'native:aws_compute_optimizer:s1', sourceId: 'native:aws_compute_optimizer', type: 'opportunity', category: 'rightsizing',
      resourceId: 'res-1', workloadId: null, estimatedMonthlySavings: 70.08, observedSpendDelta: 0, severity: 'info', status: 'open',
      detectedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(out.findings[0].title).toContain('no value context');
  });
  it('skips invalid items and tolerates a throwing resolver', () => {
    const out = toCostFindings([nr({ estimatedSavingsMinor: B(-1) }), nr()], { ...ctx, resolveWorkloadId: () => { throw new Error('x'); } });
    expect(out.skippedUnrepresentable).toBe(1);
    expect(out.findings[0].workloadId).toBeNull();
    expect(toCostFindings([nr()], { ...ctx, resolveWorkloadId: () => 'wl-1' }).findings[0].workloadId).toBe('wl-1');
  });
  it('refuses a bad context with fixed text', () => {
    expect(() => toCostFindings([], { currency: 'usd', detectedAt: ctx.detectedAt })).toThrow(RECOMMEND_INPUT_ERROR_MESSAGES.INVALID_INPUT);
    expect(() => toCostFindings([], { currency: 'USD', detectedAt: 'SECRET-MARKER-123' })).toThrow(/not in the expected shape$/);
  });
  const finding = (over: Partial<CostFinding> = {}): CostFinding => ({
    id: 'pf-1', sourceId: 'pointfive', type: 'opportunity', category: 'idle_resource', title: 't', resourceId: 'res-9', workloadId: null,
    estimatedMonthlySavings: 12.34, observedSpendDelta: 0, severity: 'warning', status: 'open', detectedAt: '2026-01-01T00:00:00Z', ...over,
  });
  it('lifts a PointFive opportunity with conservative defaults', () => {
    expect(fromCostFinding(finding(), 'USD')).toMatchObject({
      source: 'pointfive', sourceId: 'pf-1', category: 'idle', estimatedSavingsMinor: B(1234), confidence: 'low', currentSpendMinor: null,
    });
    expect(fromCostFinding(finding({ category: 'mystery' }), 'USD')?.category).toBe('other');
    expect(fromCostFinding(finding(), 'USD', { confidence: 'high' })?.confidence).toBe('high');
  });
  it('refuses anomalies, bad money and bad currency', () => {
    expect(fromCostFinding(finding({ type: 'anomaly' }), 'USD')).toBeNull();
    expect(fromCostFinding(finding({ estimatedMonthlySavings: -1 }), 'USD')).toBeNull();
    expect(fromCostFinding(finding({ estimatedMonthlySavings: NaN }), 'USD')).toBeNull();
    expect(fromCostFinding(finding({ estimatedMonthlySavings: 0 }), 'USD')).toBeNull();
    expect(fromCostFinding(finding(), 'usd')).toBeNull();
    expect(fromCostFinding(null as never, 'USD')).toBeNull();
  });
  it('a lifted PointFive item de-duplicates against a native item', () => {
    const lifted = fromCostFinding(finding({ resourceId: 'res-1', category: 'rightsizing' }), 'USD') as NativeRecommendation;
    const items = flat(rankRecommendations([lifted, nr()]));
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe('aws_compute_optimizer');
    expect(items[0].corroborating[0].source).toBe('pointfive');
  });
});

// Strict query validation for GET /api/v1/costs/published (pure, no DB).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMIT,
  MAX_CURSOR_CHARS,
  MAX_LIMIT,
  decodeCursor,
  encodeCursor,
  parsePublishedCostsQuery,
  type Cursor,
} from './query';

const ok = (q: Record<string, string | string[] | undefined>) => {
  const r = parsePublishedCostsQuery(q);
  if (!r.ok) throw new Error(`expected ok, got: ${r.message}`);
  return r.value;
};
const bad = (q: Record<string, string | string[] | undefined>) => {
  const r = parsePublishedCostsQuery(q);
  expect(r.ok, JSON.stringify(q)).toBe(false);
  return r.ok ? '' : r.message;
};

const CURSOR: Cursor = {
  billingPeriod: '2026-07-01',
  sourceId: '3f2b6c1e-9a4d-4e8b-8c1a-0123456789ab',
  artifactSha256: 'a'.repeat(64),
  rowOrdinal: '41',
};

describe('Q1 defaults', () => {
  it('an empty query is the whole published set, first page, default limit', () => {
    expect(ok({})).toEqual({ from: null, to: null, limit: DEFAULT_LIMIT, cursor: null });
    expect(DEFAULT_LIMIT).toBe(100);
    expect(MAX_LIMIT).toBe(500);
  });

  it('undefined values (absent params) are ignored', () => {
    expect(ok({ period: undefined, limit: undefined })).toEqual({ from: null, to: null, limit: 100, cursor: null });
  });
});

describe('Q2 period filter', () => {
  it('period=YYYY-MM is one billing month', () => {
    expect(ok({ period: '2026-07' })).toMatchObject({ from: '2026-07-01', to: '2026-07-01' });
  });

  it('from/to is an inclusive month range; either bound alone is allowed', () => {
    expect(ok({ from: '2026-01', to: '2026-08' })).toMatchObject({ from: '2026-01-01', to: '2026-08-01' });
    expect(ok({ from: '2026-01' })).toMatchObject({ from: '2026-01-01', to: null });
    expect(ok({ to: '2026-08' })).toMatchObject({ from: null, to: '2026-08-01' });
    expect(ok({ from: '2026-08', to: '2026-08' })).toMatchObject({ from: '2026-08-01', to: '2026-08-01' });
  });

  it('bounds are 2000-01..9999-12 (the worker bounds)', () => {
    expect(ok({ period: '2000-01' })).toMatchObject({ from: '2000-01-01' });
    expect(ok({ period: '9999-12' })).toMatchObject({ to: '9999-12-01' });
    for (const v of ['1999-12', '0000-01', '10000-01']) bad({ period: v });
  });

  it('refuses malformed months', () => {
    for (const v of ['2026-00', '2026-13', '2026-7', '26-07', '2026-07-01', '2026/07', ' 2026-07', '2026-07 ', '2026-07\n', '２０２６-07', '2026-0７', '+2026-07', '']) {
      bad({ period: v });
      bad({ from: v });
      bad({ to: v });
    }
  });

  it('refuses from > to and period combined with from/to', () => {
    bad({ from: '2026-08', to: '2026-07' });
    bad({ period: '2026-07', from: '2026-07' });
    bad({ period: '2026-07', to: '2026-07' });
  });
});

describe('Q3 pagination bounds', () => {
  it('limit is a decimal integer 1..500', () => {
    expect(ok({ limit: '1' }).limit).toBe(1);
    expect(ok({ limit: '17' }).limit).toBe(17);
    expect(ok({ limit: '500' }).limit).toBe(500);
  });

  it('refuses 0, > 500, negatives, fractions, exponents, hex, padding, leading zeros, non-digits, huge values', () => {
    for (const v of ['0', '501', '1000', '-1', '1.5', '1e2', '0x10', ' 5', '5 ', '', 'abc', '007', '10abc', '9'.repeat(400), 'Infinity', 'NaN', '٣']) {
      bad({ limit: v });
    }
  });

  it('cursor round-trips and is opaque base64url', () => {
    const c = encodeCursor(CURSOR);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c)).toEqual(CURSOR);
    expect(ok({ cursor: c }).cursor).toEqual(CURSOR);
  });

  it('refuses malformed cursors', () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
    const tuple = [CURSOR.billingPeriod, CURSOR.sourceId, CURSOR.artifactSha256, CURSOR.rowOrdinal];
    const cases: string[] = [
      '',
      'not base64!',
      'a+b/c=',
      'x'.repeat(MAX_CURSOR_CHARS + 1),
      Buffer.from('not json').toString('base64url'),
      enc({ billingPeriod: CURSOR.billingPeriod }),
      enc(tuple.slice(0, 3)),
      enc([...tuple, 'extra']),
      enc([1, CURSOR.sourceId, CURSOR.artifactSha256, CURSOR.rowOrdinal]),
      enc(['2026-07-02', CURSOR.sourceId, CURSOR.artifactSha256, CURSOR.rowOrdinal]),
      enc(['2026-13-01', CURSOR.sourceId, CURSOR.artifactSha256, CURSOR.rowOrdinal]),
      enc(['1999-12-01', CURSOR.sourceId, CURSOR.artifactSha256, CURSOR.rowOrdinal]),
      enc([CURSOR.billingPeriod, 'not-a-uuid', CURSOR.artifactSha256, CURSOR.rowOrdinal]),
      enc([CURSOR.billingPeriod, "x' OR '1'='1", CURSOR.artifactSha256, CURSOR.rowOrdinal]),
      enc([CURSOR.billingPeriod, CURSOR.sourceId, 'A'.repeat(64), CURSOR.rowOrdinal]),
      enc([CURSOR.billingPeriod, CURSOR.sourceId, 'a'.repeat(63), CURSOR.rowOrdinal]),
      enc([CURSOR.billingPeriod, CURSOR.sourceId, CURSOR.artifactSha256, '-1']),
      enc([CURSOR.billingPeriod, CURSOR.sourceId, CURSOR.artifactSha256, '1.5']),
      enc([CURSOR.billingPeriod, CURSOR.sourceId, CURSOR.artifactSha256, 41]),
      enc([CURSOR.billingPeriod, CURSOR.sourceId, CURSOR.artifactSha256, '9223372036854775808']),
      enc([CURSOR.billingPeriod, CURSOR.sourceId, CURSOR.artifactSha256, '01']),
    ];
    for (const c of cases) {
      expect(decodeCursor(c), c.slice(0, 80)).toBeNull();
      bad({ cursor: c });
    }
    // The largest bigint is still a valid ordinal.
    expect(decodeCursor(enc([CURSOR.billingPeriod, CURSOR.sourceId, CURSOR.artifactSha256, '9223372036854775807']))).not.toBeNull();
    expect(decodeCursor(enc([CURSOR.billingPeriod, CURSOR.sourceId, CURSOR.artifactSha256, '0']))).not.toBeNull();
  });
});

describe('Q4 strictness', () => {
  it('refuses unknown parameters, including any attempt to choose a tenant', () => {
    for (const k of ['tenant', 'tenantId', 'tenant_id', 'offset', 'sort', 'order', 'currency', 'source', 'PERIOD', 'Limit', '__proto__', 'constructor']) {
      bad({ [k]: '1' });
    }
  });

  it('refuses a parameter given more than once', () => {
    bad({ limit: ['1', '2'] });
    bad({ period: ['2026-07', '2026-07'] });
    bad({ cursor: [encodeCursor(CURSOR)] });
  });

  it('error messages are fixed strings that never echo the input', () => {
    const hostile = '<img src=x onerror=alert(1)>EVIL';
    for (const k of ['period', 'from', 'to', 'limit', 'cursor', 'tenant']) {
      const message = bad({ [k]: hostile });
      expect(message).not.toContain('EVIL');
      expect(message).not.toContain('<img');
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('a non-plain query object (prototype keys) is not consulted', () => {
    const q = Object.create({ tenant: 'inherited' }) as Record<string, string>;
    expect(ok(q)).toEqual({ from: null, to: null, limit: 100, cursor: null });
  });
});

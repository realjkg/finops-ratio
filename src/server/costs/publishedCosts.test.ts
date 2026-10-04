// readPublishedCosts without a database (Copilot review of 0a742b9):
//   - 4176238961: counts are bigint. A JS number loses precision above 2^53, so
//     rowCount is a decimal string (the money convention), exact end to end;
//   - 4176238982: the output may not depend on session settings. The SQL formats
//     every date and timestamp explicitly, and the read fails closed unless the
//     session's DateStyle, IntervalStyle and TimeZone are the pinned ones.
// The tenant transaction and the reader-login check are stubbed here; the real
// ones run in publishedCosts.db.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    settings: { iso: 'repeatable read', ro: 'on', datestyle: 'ISO, MDY', intervalstyle: 'postgres', timezone: 'UTC' } as Record<string, string>,
    totals: [] as Array<Record<string, string>>,
    queries: [] as string[],
  };
  const client = {
    query: async (sql: string) => {
      state.queries.push(sql);
      if (/transaction_isolation/.test(sql)) return { rows: [{ ...state.settings }] };
      if (/count\(\*\)/.test(sql)) return { rows: state.totals.map((r) => ({ ...r })) };
      return { rows: [] };
    },
  };
  return { state, client };
});

vi.mock('@/ingest/db/tenant', () => ({
  withTenantTransaction: async (_pool: unknown, _tenant: string, fn: (c: unknown) => Promise<unknown>) => fn(h.client),
}));
vi.mock('./readerLogin', () => ({ assertSafeReaderLogin: async () => undefined }));

import { PUBLISHED_COSTS_SQL, readPublishedCosts } from './publishedCosts';
import { READER_SESSION_OPTIONS } from './readerPool';

const TENANT = '11111111-1111-4111-8111-111111111111';
const Q = { from: null, to: null, limit: 100, cursor: null };
const pool = {} as never;

beforeEach(() => {
  h.state.settings = { iso: 'repeatable read', ro: 'on', datestyle: 'ISO, MDY', intervalstyle: 'postgres', timezone: 'UTC' };
  h.state.totals = [];
  h.state.queries = [];
});

describe('U1 rowCount is a decimal string, exact beyond 2^53 (Copilot 4176238961)', () => {
  it("a count of '9007199254740993' (2^53 + 1) round-trips exactly, through JSON too", async () => {
    h.state.totals = [{ billingPeriod: '2026-07-01', billingCurrency: 'USD', rowCount: '9007199254740993', billedCost: '1.50' }];
    const page = await readPublishedCosts(pool, TENANT, Q);
    expect(page.totals).toEqual([{ billingPeriod: '2026-07-01', billingCurrency: 'USD', rowCount: '9007199254740993', billedCost: '1.50' }]);
    expect(typeof page.totals?.[0].rowCount).toBe('string');
    expect(JSON.stringify(page)).toContain('"rowCount":"9007199254740993"');
    // As a JS number it would have been 9007199254740992.
    expect(Number('9007199254740993')).toBe(9007199254740992);
  });

  it('the largest bigint count is exact too', async () => {
    h.state.totals = [{ billingPeriod: '2026-07-01', billingCurrency: 'USD', rowCount: '9223372036854775807', billedCost: '0' }];
    expect((await readPublishedCosts(pool, TENANT, Q)).totals?.[0].rowCount).toBe('9223372036854775807');
  });
});

describe('U2 the read fails closed unless the session settings are the pinned ones (Copilot 4176238982)', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['DateStyle SQL, DMY', { datestyle: 'SQL, DMY' }],
    ['DateStyle German', { datestyle: 'German, DMY' }],
    ['IntervalStyle sql_standard', { intervalstyle: 'sql_standard' }],
    ['TimeZone America/Sao_Paulo', { timezone: 'America/Sao_Paulo' }],
    ['READ COMMITTED', { iso: 'read committed' }],
    ['not read-only', { ro: 'off' }],
  ];
  it.each(cases)('%s ⇒ refused before any read', async (_name, over) => {
    h.state.settings = { ...h.state.settings, ...over };
    await expect(readPublishedCosts(pool, TENANT, Q)).rejects.toThrow(/published-costs read requires/);
    expect(h.state.queries.some((q) => /cost_facts_published/.test(q))).toBe(false);
  });

  it('the pinned settings are accepted', async () => {
    await expect(readPublishedCosts(pool, TENANT, Q)).resolves.toMatchObject({ data: [], totals: [] });
  });

  it('the reader pool pins DateStyle, IntervalStyle and TimeZone at connection start', () => {
    expect(READER_SESSION_OPTIONS).toContain('-c DateStyle=ISO,MDY');
    expect(READER_SESSION_OPTIONS).toContain('-c IntervalStyle=postgres');
    expect(READER_SESSION_OPTIONS).toContain('-c TimeZone=UTC');
  });
});

describe('U3 every returned or cursor-encoded value is formatted explicitly, independent of session settings', () => {
  const sqls = () => [PUBLISHED_COSTS_SQL.page, PUBLISHED_COSTS_SQL.totals];

  it("billing_period is formatted with to_char(…, 'YYYY-MM-DD'), never date::text, in the page and in the totals", () => {
    for (const sql of sqls()) {
      expect(sql).toMatch(/pg_catalog\.to_char\(v\.billing_period, 'YYYY-MM-DD'\) AS "billingPeriod"/);
      expect(sql).not.toMatch(/billing_period::pg_catalog\.text/);
    }
  });

  it('no date or timestamp column is cast to text (DateStyle/TimeZone-dependent); timestamps go through to_char at UTC', () => {
    const page = PUBLISHED_COSTS_SQL.page;
    for (const col of ['charge_period_start', 'charge_period_end', 'published_at']) {
      expect(page).not.toMatch(new RegExp(`${col}::`));
      expect(page).toMatch(new RegExp(`pg_catalog\\.to_char\\(v\\.${col} AT TIME ZONE 'UTC', `));
    }
  });

  it('counts are cast to text in SQL (int8out is setting-independent) and never converted to a JS number', () => {
    expect(PUBLISHED_COSTS_SQL.totals).toMatch(/pg_catalog\.count\(\*\)::pg_catalog\.text AS "rowCount"/);
  });
});

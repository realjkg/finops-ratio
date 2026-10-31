import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, MAX_GROUP_BY, MAX_LIMIT, VIEW_QUERY_MESSAGES as M, encodeViewCursor, validateViewQuery, type Scope } from './query';
import { VIEWS, VIEW_IDS } from './views';
import { BU_A_SCOPE, TENANT, TENANT_SCOPE } from './fixtures/syntheticAllocation';

const base = { view: 'published_costs', period: '2024-09', measures: ['billedCost', 'effectiveCost'] };
const v = (o: Record<string, unknown>, scope: Scope = TENANT_SCOPE) => validateViewQuery({ ...base, ...o }, scope);
const rejects = (input: unknown, message: string, scope: Scope = TENANT_SCOPE) => {
  const r = validateViewQuery(input, scope);
  expect(r).toEqual({ ok: false, message });
  return r;
};

describe('view registry', () => {
  it('declares all nine named views with owner source, grain, keys, money, provenance and freshness', () => {
    expect([...VIEW_IDS].sort()).toEqual(['ai_billed_cost', 'ai_usage', 'budget_vs_actual', 'cost_by_business_unit', 'inventory_mapping', 'outcomes_value', 'published_costs', 'reconciliation_results', 'source_registry']);
    for (const id of VIEW_IDS) {
      const d = VIEWS[id];
      expect(d.id).toBe(id);
      for (const k of ['ownerSource', 'title'] as const) expect(d[k].length, `${id}.${k}`).toBeGreaterThan(0);
      for (const k of ['grain', 'keys', 'provenance', 'freshness', 'measures', 'dimensions'] as const) expect(d[k].length, `${id}.${k}`).toBeGreaterThan(0);
      expect(new Set(d.measures).size).toBe(d.measures.length);
      expect(new Set(d.dimensions).size).toBe(d.dimensions.length);
      expect(['tenant', 'business_unit']).toContain(d.scopeLevel);
      if (d.money) {
        expect(d.money.currencyField).toBe('currency');
        expect(d.money.bases.length).toBeGreaterThan(0);
      }
    }
    // Money-free views say so; money views never mix bases into one field.
    expect(VIEWS.inventory_mapping.money).toBeNull();
    expect(VIEWS.published_costs.money?.bases).toEqual(['billed', 'effective']);
    expect(VIEWS.ai_usage.money?.bases).toEqual(['estimated']);
    // Prerequisites that do not exist yet are named, not hidden.
    expect(VIEWS.source_registry.needs).toContain('R4 trust views (migration 0005)');
    expect(VIEWS.cost_by_business_unit.needs.join(' ')).toMatch(/R6/);
  });

  it('carries no reader-SQL marker strings, so a future client import passes check:bundle', () => {
    expect(JSON.stringify(VIEWS)).not.toMatch(/cost_facts_published|ratio\.tenant_id|pg_auth_members/);
  });
});

describe('ViewQuery validator: accepted shapes', () => {
  it('normalizes a month, defaults the limit and adds the tenant from scope (never from input)', () => {
    expect(v({})).toEqual({ ok: true, value: { tenantId: TENANT, view: 'published_costs', period: { from: '2024-09', to: '2024-09' }, measures: ['billedCost', 'effectiveCost'], groupBy: [], filters: {}, limit: DEFAULT_LIMIT, cursor: null, businessUnits: '*' } });
  });

  it('accepts a 12-month range, three group-bys, IN filters, limit 500 and a keyset cursor for the same view', () => {
    const cursor = encodeViewCursor('published_costs', ['2024-09', '0a0a0a0a-0000-4000-8000-00000000000a', 'USD']);
    const r = v({ period: { from: '2024-01', to: '2024-12' }, groupBy: ['currency', 'sourceId', 'chargeCategory'], filters: { currency: ['USD', 'EUR'], chargeCategory: 'Credit' }, limit: MAX_LIMIT, cursor });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.filters).toEqual({ currency: ['USD', 'EUR'], chargeCategory: ['Credit'] });
      expect(r.value.limit).toBe(500);
      expect(r.value.cursor).toEqual({ view: 'published_costs', after: ['2024-09', '0a0a0a0a-0000-4000-8000-00000000000a', 'USD'] });
    }
  });

  it('a BU-scoped caller gets its BU predicate added server-side and may filter within it', () => {
    const q = { view: 'cost_by_business_unit', period: '2024-09', measures: ['allocatedBilledCost'], groupBy: ['businessUnit'] };
    const r = validateViewQuery(q, BU_A_SCOPE);
    expect(r.ok && r.value.businessUnits).toEqual(['BU-A']);
    const f = validateViewQuery({ ...q, filters: { businessUnit: 'BU-A' } }, BU_A_SCOPE);
    expect(f.ok && f.value.filters).toEqual({ businessUnit: ['BU-A'] });
    // A tenant-wide caller may read the unallocated line.
    expect(validateViewQuery({ ...q, measures: ['unallocatedBilledCost'] }, TENANT_SCOPE).ok).toBe(true);
  });
});

describe('ViewQuery validator: rejections use fixed messages and never echo input', () => {
  const MARK = 'ZZ_ECHO_PROBE_7f3a';
  it('rejects unknown views, measures, group-bys and filters', () => {
    rejects({ ...base, view: `${MARK}` }, M.view);
    rejects({ ...base, view: 'toString' }, M.view);
    rejects({ ...base, measures: [`${MARK}`] }, M.measures);
    rejects({ ...base, measures: ['allocatedBilledCost'] }, M.measures); // a measure of another view
    rejects({ ...base, measures: [] }, M.measures);
    rejects({ ...base, measures: ['billedCost', 'billedCost'] }, M.measures);
    rejects({ ...base, groupBy: [`${MARK}`] }, M.groupBy);
    rejects({ ...base, groupBy: ['businessUnit'] }, M.groupBy); // a dimension of another view
    rejects({ ...base, groupBy: ['currency', 'sourceId', 'chargeCategory', 'billingPeriod'] }, M.groupBy);
    expect(MAX_GROUP_BY).toBe(3);
    rejects({ ...base, filters: { [MARK]: 'x' } }, M.filters);
    rejects({ ...base, filters: { currency: [] } }, M.filters);
    rejects({ ...base, filters: { currency: Array.from({ length: 11 }, (_, i) => `A${String.fromCharCode(65 + i)}C`) } }, M.filters);
  });

  it('rejects limits outside 1..500 and non-integers (limit 501 is the off-by-one guard)', () => {
    for (const limit of [501, 0, -1, 1.5, '100', Number.NaN, Infinity, 1e9]) rejects({ ...base, limit }, M.limit);
    expect(v({ limit: 1 }).ok).toBe(true);
    expect(v({ limit: 500 }).ok).toBe(true);
  });

  it('rejects malformed periods: bad month, reversed range, more than 12 months', () => {
    for (const period of ['2024-13', '2024-9', '1999-12', '2024-09-01', { from: '2024-05', to: '2024-04' }, { from: '2024-01', to: '2025-01' }, { from: '2024-01' }, { from: '2024-01', to: '2024-02', x: 1 }, 202409])
      rejects({ ...base, period }, M.period);
  });

  it('rejects malformed cursors and a cursor of another view', () => {
    const other = encodeViewCursor('source_registry', ['abc']);
    for (const cursor of ['', '!!!', 'a'.repeat(513), btoa('not json'), btoa(JSON.stringify({ view: 'published_costs' })), btoa(JSON.stringify(['published_costs'])), btoa(JSON.stringify(['published_costs', "x' OR 1=1"])), other, 7])
      rejects({ ...base, cursor }, M.cursor);
  });

  it('rejects SQL-looking and URL values, prototype keys, the tenant as input, and huge input', () => {
    for (const value of ["BU-A' OR '1'='1", 'BU-A; DROP TABLE x', 'BU-A--', 'select', 'Union All', 'https://example.test/x', '//example.test', 'a/*b*/', 'x'.repeat(65), 'BU\u0000A'])
      rejects({ view: 'cost_by_business_unit', period: '2024-09', measures: ['allocatedBilledCost'], filters: { businessUnit: value } }, M.filterValue);
    rejects({ ...base, filters: { currency: 'usd' } }, M.filterValue);
    rejects({ ...base, filters: { sourceId: 'not-a-uuid' } }, M.filterValue);
    rejects(JSON.parse('{"view":"published_costs","period":"2024-09","measures":["billedCost"],"__proto__":{"admin":true}}'), M.shape);
    rejects({ ...base, constructor: 'x' }, M.shape);
    rejects({ ...base, filters: JSON.parse('{"__proto__":{"currency":"USD"}}') }, M.filters);
    rejects({ ...base, tenantId: TENANT }, M.shape);
    rejects({ ...base, sql: 'select 1' }, M.shape);
    rejects({ ...base, url: 'https://example.test' }, M.shape);
    for (const bad of [null, undefined, 'published_costs', [base], new (class Q { view = 'published_costs'; })(), new Map()]) rejects(bad, M.shape);
    const huge: Record<string, unknown> = { ...base };
    for (let i = 0; i < 100_000; i++) huge[`k${i}`] = i;
    rejects(huge, M.shape);
    rejects({ ...base, measures: new Array(1_000_000).fill('billedCost') }, M.measures);
    rejects({ ...base, view: 'x'.repeat(1_000_000) }, M.view);
  });

  it('every rejection message is one of the fixed strings and contains no probe text', () => {
    const fixed = new Set(Object.values(M));
    const inputs: unknown[] = [{ ...base, view: MARK }, { ...base, measures: [MARK] }, { ...base, groupBy: [MARK] }, { ...base, filters: { [MARK]: MARK } }, { ...base, filters: { currency: MARK } }, { ...base, period: MARK }, { ...base, cursor: MARK }, { ...base, limit: MARK }, { ...base, [MARK]: 1 }];
    for (const i of inputs) {
      const r = validateViewQuery(i, TENANT_SCOPE);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(fixed.has(r.message as never)).toBe(true);
        expect(r.message).not.toContain(MARK);
      }
    }
  });
});

describe('Scope (produced by the future authorization layer, never by the caller)', () => {
  const buQuery = { view: 'cost_by_business_unit', period: '2024-09', measures: ['allocatedBilledCost'] };
  it('rejects an invalid scope', () => {
    for (const scope of [{ ...TENANT_SCOPE, tenantId: 'x' }, { ...TENANT_SCOPE, wildcard: 'yes' }, { ...BU_A_SCOPE, businessUnits: ["BU' OR 1=1"] }, { ...TENANT_SCOPE, wildcard: true, businessUnits: ['BU-A'] }, null])
      rejects(base, M.scope, scope as unknown as Scope);
  });

  it('a BU-scoped caller cannot read tenant-wide views, the unallocated line or another BU (rejected, not dropped)', () => {
    rejects(base, M.scopeView, BU_A_SCOPE);
    rejects({ ...base, view: 'reconciliation_results', measures: ['residual'] }, M.scopeView, BU_A_SCOPE);
    rejects({ ...buQuery, measures: ['unallocatedBilledCost'] }, M.scopeBusinessUnit, BU_A_SCOPE);
    rejects({ ...buQuery, filters: { businessUnit: 'unallocated' } }, M.scopeBusinessUnit, BU_A_SCOPE);
    rejects({ ...buQuery, filters: { businessUnit: 'BU-B' } }, M.scopeBusinessUnit, BU_A_SCOPE);
    rejects({ ...buQuery, filters: { businessUnit: ['BU-A', 'BU-B'] } }, M.scopeBusinessUnit, BU_A_SCOPE);
    rejects(buQuery, M.scopeView, { ...BU_A_SCOPE, businessUnits: [] });
  });
});

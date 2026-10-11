import { beforeEach, describe, expect, it } from 'vitest';
import { AllocationError } from './errors';
import { LIMITS } from './limits';
import { SUGGESTION_BUDGET, boundedEditDistance, evaluateTagPolicy, normalizeToken, type TagPolicy } from './tagPolicy';
import { TENANT, resetIds, row } from './testFixtures';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof AllocationError) return e.code;
    throw e;
  }
  return undefined;
}

const policy: TagPolicy = {
  rules: [
    { key: 'env', required: true, allowedValues: ['Production', 'Staging', 'Development'], aliases: { prd: 'Production', stg: 'Staging' } },
    { key: 'owner', required: true },
    { key: 'cost-center', required: false, allowedValues: ['CC-100', 'CC-200'] },
  ],
};
const ev = (rows: ReturnType<typeof row>[], p: TagPolicy = policy) => evaluateTagPolicy(TENANT, rows, p);
beforeEach(resetIds);

describe('boundedEditDistance', () => {
  it('computes OSA distance within the bound and null beyond it', () => {
    expect(boundedEditDistance('kitten', 'kitten', 2)).toBe(0);
    expect(boundedEditDistance('abc', 'abd', 2)).toBe(1);
    expect(boundedEditDistance('abcd', 'acbd', 2)).toBe(1); // transposition
    expect(boundedEditDistance('abc', 'xyz', 2)).toBeNull();
    expect(boundedEditDistance('abc', 'abcdef', 2)).toBeNull();
    expect(boundedEditDistance('', 'ab', 2)).toBe(2);
  });

  it('refuses strings over the length cap', () => {
    const at = 'a'.repeat(LIMITS.maxEditDistanceLength);
    expect(boundedEditDistance(at, at, 1)).toBe(0);
    expect(boundedEditDistance(at, at + 'a', 1)).toBeNull();
  });

  it('normalizes case, width and separators', () => {
    expect(normalizeToken(' Cost_Center-1 ')).toBe('costcenter1');
    expect(normalizeToken('ＰＲＯＤ')).toBe('prod');
  });
});

describe('violations and suggestions', () => {
  it('compliant rows produce no violations', () => {
    const r = ev([row({ tags: { env: 'Production', owner: 'alice' } })]);
    expect(r.violationCount).toBe(0);
    expect(r.currencies[0].compliancePctBySpend).toBe('100.00');
  });

  it('flags missing required keys, empty values and invalid values', () => {
    const r = ev([row({ tags: { env: '  ', 'cost-center': 'CC-999' } })]);
    const issues = r.violations[0].issues.map((i) => [i.kind, i.key]);
    expect(issues).toEqual([['EMPTY_VALUE', 'env'], ['MISSING_KEY', 'owner'], ['INVALID_VALUE', 'cost-center']]);
  });

  it('suggests case fixes ("prod" vs "Production" style) and aliases', () => {
    const r = ev([
      row({ tags: { env: 'production', owner: 'a' } }),
      row({ tags: { env: 'PRD', owner: 'a' } }),
      row({ tags: { env: 'prod', owner: 'a' } }),
      row({ tags: { env: 'Stagnig', owner: 'a' } }),
      row({ tags: { env: 'dev', owner: 'a' } }),
      row({ tags: { env: 'Develpoment', owner: 'a' } }),
      row({ tags: { env: 'zzzzzz', owner: 'a' } }),
    ]);
    const sug = [...r.violations].sort((a, b) => a.rowId.localeCompare(b.rowId)).map((v) => v.issues[0].suggestion && `${v.issues[0].suggestion.to}:${v.issues[0].suggestion.reason}`);
    expect(sug).toEqual(['Production:CASE', 'Production:ALIAS', 'Production:ABBREVIATION', 'Staging:TYPO', 'Development:ABBREVIATION', 'Development:TYPO', null]);
  });

  it('exact matching by default; ignoreCase makes case-only differences compliant', () => {
    const rows = [row({ tags: { env: 'production', owner: 'a' } })];
    expect(ev(rows).violationCount).toBe(1);
    expect(ev(rows, { ...policy, valueMatching: 'ignoreCase' }).violationCount).toBe(0);
  });

  it('suggests renaming a mistyped or differently cased required key', () => {
    const r = ev([row({ tags: { env: 'Production', Owner: 'a' } }), row({ tags: { env: 'Production', ownr: 'a' } }), row({ tags: { env: 'Production', 'own-er': 'a' } })]);
    const s = r.violations.map((v) => v.issues[0].suggestion).sort((a, b) => a!.from.localeCompare(b!.from));
    expect(s.map((x) => [x!.from, x!.to, x!.reason])).toEqual([
      ['own-er', 'owner', 'FORMAT'],
      ['Owner', 'owner', 'CASE'],
      ['ownr', 'owner', 'TYPO'],
    ]);
  });

  it('never suggests renaming a key that belongs to the policy', () => {
    const r = ev([row({ tags: { env: 'Production', 'cost-center': 'CC-100' } })]);
    expect(r.violations[0].issues[0].suggestion).toBeNull();
  });

  it('long strings get no typo suggestion but are still flagged', () => {
    const long = 'x'.repeat(LIMITS.maxEditDistanceLength + 1);
    const r = ev([row({ tags: { env: long, owner: 'a' } })]);
    expect(r.violations[0].issues[0]).toMatchObject({ kind: 'INVALID_VALUE', suggestion: null });
  });

  it('the suggestion budget is bounded and reported', () => {
    expect(SUGGESTION_BUDGET).toBeGreaterThan(0);
    const many: TagPolicy = { rules: [{ key: 'env', required: true, allowedValues: Array.from({ length: 400 }, (_, i) => `value-${String(i).padStart(4, '0')}`) }] };
    const rows = Array.from({ length: 600 }, (_, i) => ({ ...row({ tags: { env: `valuf-${String(i).padStart(4, '0')}x` } }), id: `b${i}` }));
    const t0 = Date.now();
    const r = ev(rows, many);
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(r.violationCount).toBe(600);
    expect(r.suggestionsTruncated).toBe(true);
  });

  it('issue counts summarize by key and kind', () => {
    const r = ev([row({ tags: {} }), row({ tags: { env: 'x', owner: 'a' } })]);
    expect(r.issueCounts).toEqual([
      { key: 'env', kind: 'INVALID_VALUE', count: 1 },
      { key: 'env', kind: 'MISSING_KEY', count: 1 },
      { key: 'owner', kind: 'MISSING_KEY', count: 1 },
    ]);
  });
});

describe('compliance percentages and spend at risk', () => {
  it('by spend and by resource count, per currency, rounded down', () => {
    const good = { env: 'Production', owner: 'a' };
    const r = ev([
      row({ amount: '70.00', tags: good, resourceId: 'i-1' }),
      row({ amount: '30.01', tags: {}, resourceId: 'i-2' }),
      row({ amount: '50', currency: 'JPY', tags: good, resourceId: 'j-1' }),
      row({ amount: '1', currency: 'JPY', tags: {}, resourceId: 'j-2' }),
    ]);
    const usd = r.currencies.find((c) => c.currency === 'USD')!;
    expect(usd.gross).toBe('100.01');
    expect(usd.atRisk).toBe('30.01');
    expect(usd.compliancePctBySpend).toBe('69.99'); // 69.993 -> rounded down
    expect(usd.compliancePctByResourceCount).toBe('50.00');
    const jpy = r.currencies.find((c) => c.currency === 'JPY')!;
    expect(jpy.atRisk).toBe('1');
    expect(jpy.compliancePctBySpend).toBe('98.03');
    expect(r.resources).toMatchObject({ total: 4, compliant: 2, nonCompliant: 2, compliancePct: '50.00' });
  });

  it('a resource is compliant only if every one of its rows is', () => {
    const r = ev([
      row({ tags: { env: 'Production', owner: 'a' }, resourceId: 'i-1' }),
      row({ tags: {}, resourceId: 'i-1' }),
    ]);
    expect(r.currencies[0]).toMatchObject({ resourceCount: 1, compliantResourceCount: 0 });
  });

  it('measures credits gross so they cannot offset a violation', () => {
    const r = ev([row({ amount: '-10.00', tags: {} }), row({ amount: '10.00', tags: {} })]);
    expect(r.currencies[0].atRisk).toBe('20.00');
    expect(r.currencies[0].compliancePctBySpend).toBe('0.00');
  });

  it('zero spend gives null percentages, no rows gives an empty report', () => {
    expect(ev([row({ amount: '0.00', tags: {} })]).currencies[0].compliancePctBySpend).toBeNull();
    const e = ev([]);
    expect(e.currencies).toEqual([]);
    expect(e.resources.compliancePct).toBeNull();
  });

  it('sorts violations by currency, then spend at risk, then row id', () => {
    const r = ev([
      row({ id: 'b', amount: '5.00', tags: {} }),
      row({ id: 'a', amount: '5.00', tags: {} }),
      row({ id: 'c', amount: '9.00', tags: {} }),
      row({ id: 'j', currency: 'JPY', amount: '1', tags: {} }),
    ]);
    expect(r.violations.map((v) => v.rowId)).toEqual(['j', 'c', 'a', 'b']);
  });

  it('is never overstated: 1 of 3 compliant is 33.33', () => {
    const r = ev([row({ tags: { env: 'Production', owner: 'a' } }), row({ tags: {} }), row({ tags: {} })]);
    expect(r.currencies[0].compliancePctBySpend).toBe('33.33');
  });
});

describe('policy validation, caps and hostile input', () => {
  const run = (p: unknown) => codeOf(() => ev([], p as TagPolicy));

  it('refuses malformed policies', () => {
    expect(run(null)).toBe('INVALID_POLICY');
    expect(run({ rules: 'x' })).toBe('INVALID_POLICY');
    expect(run({ rules: [], extra: 1 })).toBe('INVALID_POLICY');
    expect(run({ rules: [], valueMatching: 'fuzzy' })).toBe('INVALID_POLICY');
    expect(run({ rules: [], maxEditDistance: 9 })).toBe('INVALID_POLICY');
    expect(run({ rules: [{ key: 'a' }] })).toBe('INVALID_POLICY');
    expect(run({ rules: [{ key: 'a', required: true }, { key: 'a', required: false }] })).toBe('INVALID_POLICY');
    expect(run({ rules: [{ key: 'a', required: true, allowedValues: [] }] })).toBe('INVALID_POLICY');
    expect(run({ rules: [{ key: 'a', required: true, allowedValues: ['x', 'x'] }] })).toBe('INVALID_POLICY');
    expect(run({ rules: [{ key: 'a', required: true, aliases: { p: 'x' } }] })).toBe('INVALID_POLICY');
    expect(run({ rules: [{ key: 'a', required: true, allowedValues: ['x'], aliases: { p: 'y' } }] })).toBe('INVALID_POLICY');
    expect(run({ rules: [{ key: 'a', required: true, allowedValues: ['A', 'a'] }], valueMatching: 'ignoreCase' })).toBe('INVALID_POLICY');
    expect(run({ rules: [{ key: 'a\n', required: true }] })).toBe('INVALID_POLICY');
  });

  it('caps policy keys and allowed values: at the cap works, one past is refused', () => {
    const keys = (n: number) => ({ rules: Array.from({ length: n }, (_, i) => ({ key: `k${i}`, required: false })) });
    expect(run(keys(LIMITS.maxPolicyKeys))).toBeUndefined();
    expect(run(keys(LIMITS.maxPolicyKeys + 1))).toBe('TOO_MANY_POLICY_ENTRIES');
    const vals = (n: number) => ({ rules: [{ key: 'a', required: false, allowedValues: Array.from({ length: n }, (_, i) => `v${i}`) }] });
    expect(run(vals(LIMITS.maxAllowedValues))).toBeUndefined();
    expect(run(vals(LIMITS.maxAllowedValues + 1))).toBe('TOO_MANY_POLICY_ENTRIES');
  });

  it('enforces row validation, tenant scope and the row cap', () => {
    expect(codeOf(() => ev([row({ tenant: 'other' })]))).toBe('TENANT_MISMATCH');
    expect(codeOf(() => evaluateTagPolicy(TENANT, 'x' as never, policy))).toBe('INVALID_ROW');
    const rows = Array.from({ length: LIMITS.maxRows + 1 }, (_, i) => ({ ...row(), id: `r${i}` }));
    expect(codeOf(() => ev(rows))).toBe('TOO_MANY_ROWS');
  });

  it('treats prototype-pollution tag keys as ordinary data', () => {
    const tags = JSON.parse('{"__proto__":"x","constructor":"y","env":"Production","owner":"a"}') as Record<string, string>;
    const r = ev([row({ tags })]);
    expect(r.violationCount).toBe(0);
    const p: TagPolicy = { rules: [{ key: '__proto__', required: true }, { key: 'constructor', required: true }] };
    expect(ev([row({ tags })], p).violationCount).toBe(0);
    expect(ev([row({ tags: {} })], p).violationCount).toBe(1);
    expect(({} as Record<string, unknown>).env).toBeUndefined();
  });

  it('a required key present only on the prototype chain is still missing', () => {
    const p: TagPolicy = { rules: [{ key: 'toString', required: true }] };
    expect(ev([row({ tags: {} })], p).violationCount).toBe(1);
  });

  it('does not echo input in error text', () => {
    try {
      ev([row({ amount: 'SECRET-123' })]);
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET');
    }
  });

  it('returns at most maxViolationsReturned but counts all', () => {
    const rows = Array.from({ length: LIMITS.maxViolationsReturned + 5 }, (_, i) => ({ ...row({ tags: {} }), id: `v${i}` }));
    const r = ev(rows, { rules: [{ key: 'env', required: true }] });
    expect(r.violationCount).toBe(LIMITS.maxViolationsReturned + 5);
    expect(r.violations).toHaveLength(LIMITS.maxViolationsReturned);
    expect(r.truncated).toBe(true);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { allocateCosts, type AllocationConfig } from './allocate';
import { AllocationError } from './errors';
import { LIMITS } from './limits';
import type { AllocatableRow } from './rows';
import type { CostRule } from './rules';
import { UNALLOCATED, UNMATCHED_RULE_ID } from './targets';
import { TENANT, mulberry32, resetIds, row, stable, tagRule } from './testFixtures';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof AllocationError) return e.code;
    throw e;
  }
  return undefined;
}

const alloc = (rows: AllocatableRow[], config: AllocationConfig) => allocateCosts(TENANT, rows, config);
beforeEach(resetIds);

describe('rule precedence and first match', () => {
  const rules: CostRule[] = [
    tagRule('r-late', 20, 'env', 'prod', 'team-late'),
    tagRule('r-early', 10, 'env', 'prod', 'team-early'),
  ];

  it('lowest precedence number wins regardless of array order and records ruleId', () => {
    const l = alloc([row({ tags: { env: 'prod' } })], { rules });
    expect(l.lines).toHaveLength(1);
    expect(l.lines[0].kind).toBe('direct');
    expect(l.lines[0].ruleId).toBe('r-early');
    expect(l.lines[0].target).toEqual({ team: 'team-early' });
  });

  it('refuses equal precedence rather than picking a winner', () => {
    expect(codeOf(() => alloc([], { rules: [tagRule('a', 1, 'k', 'v', 't'), tagRule('b', 1, 'k', 'v', 't')] }))).toBe(
      'DUPLICATE_PRECEDENCE',
    );
  });

  it('refuses duplicate rule ids and reserved ids', () => {
    expect(codeOf(() => alloc([], { rules: [tagRule('a', 1, 'k', 'v', 't'), tagRule('a', 2, 'k', 'v', 't')] }))).toBe('DUPLICATE_RULE_ID');
    expect(codeOf(() => alloc([], { rules: [tagRule('UNALLOCATED', 1, 'k', 'v', 't')] }))).toBe('RESERVED_ID');
    expect(codeOf(() => alloc([], { rules: [tagRule('unmatched', 1, 'k', 'v', 't')] }))).toBe('RESERVED_ID');
  });

  it('requires every condition (AND)', () => {
    const r: CostRule = {
      id: 'both',
      precedence: 1,
      when: [
        { field: 'tag', key: 'env', match: { op: 'equals', value: 'prod' } },
        { field: 'account', match: { op: 'equals', value: 'acct-9' } },
      ],
      action: { kind: 'target', target: { team: 'x' } },
    };
    const l = alloc([row({ tags: { env: 'prod' } }), row({ tags: { env: 'prod' }, account: 'acct-9' })], { rules: [r] });
    expect(l.lines.map((x) => x.kind)).toEqual(['unallocated', 'direct']);
  });

  it('supports prefix, oneOf, exists, service, region and resource prefix matchers', () => {
    const rs: CostRule[] = [
      { id: 'res', precedence: 1, when: [{ field: 'resourceId', match: { op: 'prefix', value: 'arn:aws:ec2' } }], action: { kind: 'target', target: { application: 'compute' } } },
      { id: 'svc', precedence: 2, when: [{ field: 'service', match: { op: 'oneOf', values: ['S3', 'Glacier'] } }], action: { kind: 'target', target: { application: 'storage' } } },
      { id: 'reg', precedence: 3, when: [{ field: 'region', match: { op: 'prefix', value: 'eu-' } }], action: { kind: 'target', target: { costCenter: 'emea' } } },
      { id: 'has', precedence: 4, when: [{ field: 'tag', key: 'owner', match: { op: 'exists' } }], action: { kind: 'target', target: { team: 'owned' } } },
      { id: 'tp', precedence: 5, when: [{ field: 'tag', key: 'proj', match: { op: 'prefix', value: 'alpha-' } }], action: { kind: 'target', target: { team: 'alpha' } } },
    ];
    const l = alloc(
      [
        row({ resourceId: 'arn:aws:ec2:i-1' }),
        row({ service: 'Glacier' }),
        row({ region: 'eu-west-1' }),
        row({ tags: { owner: '' } }),
        row({ tags: { proj: 'alpha-7' } }),
        row({ tags: { proj: 'beta-7' } }),
        row({}),
      ],
      { rules: rs },
    );
    expect(l.lines.map((x) => x.ruleId)).toEqual(['res', 'svc', 'reg', 'has', 'tp', UNMATCHED_RULE_ID, UNMATCHED_RULE_ID]);
  });

  it('an absent field never matches, even a prefix of the empty text', () => {
    const r: CostRule = { id: 'r', precedence: 1, when: [{ field: 'region', match: { op: 'prefix', value: 'e' } }], action: { kind: 'target', target: { team: 't' } } };
    expect(alloc([row({})], { rules: [r] }).lines[0].kind).toBe('unallocated');
  });

  it('tag key lookup is exact; value case folding only with ignoreCase', () => {
    const exact = tagRule('e', 1, 'Env', 'Prod', 't');
    const folded: CostRule = { ...exact, id: 'f', when: [{ field: 'tag', key: 'Env', match: { op: 'equals', value: 'Prod' }, ignoreCase: true }] };
    const rows = [row({ tags: { Env: 'prod' } }), row({ tags: { env: 'Prod' } }), row({ tags: { Env: 'PROD' } })];
    expect(alloc(rows, { rules: [exact] }).lines.map((x) => x.kind)).toEqual(['unallocated', 'unallocated', 'unallocated']);
    expect(alloc(rows, { rules: [folded] }).lines.map((x) => x.kind)).toEqual(['direct', 'unallocated', 'direct']);
  });
});

describe('rule validation and caps', () => {
  const ok = tagRule('ok', 1, 'k', 'v', 't');
  it('accepts an empty rule set: everything is UNALLOCATED', () => {
    const l = alloc([row({ amount: '5.00' }), row({ amount: '7.50' })], { rules: [] });
    expect(l.lines.every((x) => x.kind === 'unallocated' && x.target === null && x.reason === 'NO_RULE_MATCHED')).toBe(true);
    expect(l.totals[0]).toMatchObject({ ledger: '12.50', allocated: '0.00', unallocated: '12.50' });
  });

  it('rule count cap: at the cap works, one past is refused', () => {
    const mk = (n: number): CostRule[] => Array.from({ length: n }, (_, i) => tagRule(`r${i}`, i, 'k', `v${i}`, 't'));
    expect(() => alloc([row()], { rules: mk(LIMITS.maxRules) })).not.toThrow();
    expect(codeOf(() => alloc([row()], { rules: mk(LIMITS.maxRules + 1) }))).toBe('TOO_MANY_RULES');
  });

  it('condition cap and oneOf cap', () => {
    const cond = { field: 'tag' as const, key: 'k', match: { op: 'equals' as const, value: 'v' } };
    const withN = (n: number): CostRule => ({ id: 'c', precedence: 1, when: Array.from({ length: n }, () => cond), action: { kind: 'target', target: { team: 't' } } });
    expect(() => alloc([], { rules: [withN(LIMITS.maxConditionsPerRule)] })).not.toThrow();
    expect(codeOf(() => alloc([], { rules: [withN(LIMITS.maxConditionsPerRule + 1)] }))).toBe('TOO_MANY_CONDITIONS');
    const oneOf = (n: number): CostRule => ({ id: 'o', precedence: 1, when: [{ field: 'service', match: { op: 'oneOf', values: Array.from({ length: n }, (_, i) => `s${i}`) } }], action: { kind: 'target', target: { team: 't' } } });
    expect(() => alloc([], { rules: [oneOf(LIMITS.maxListValues)] })).not.toThrow();
    expect(codeOf(() => alloc([], { rules: [oneOf(LIMITS.maxListValues + 1)] }))).toBe('TOO_MANY_VALUES');
  });

  it('refuses empty conditions, empty matcher values and empty oneOf', () => {
    const base = { id: 'x', precedence: 1, action: { kind: 'target', target: { team: 't' } } } as const;
    expect(codeOf(() => alloc([], { rules: [{ ...base, when: [] }] }))).toBe('INVALID_RULE');
    expect(codeOf(() => alloc([], { rules: [{ ...base, when: [{ field: 'service', match: { op: 'equals', value: '' } }] }] }))).toBe('INVALID_RULE');
    expect(codeOf(() => alloc([], { rules: [{ ...base, when: [{ field: 'service', match: { op: 'oneOf', values: [] } }] }] }))).toBe('INVALID_RULE');
  });

  it('refuses regex-style rules and RegExp values (no ReDoS surface)', () => {
    const bad = (when: unknown): unknown => ({ id: 'x', precedence: 1, when, action: { kind: 'target', target: { team: 't' } } });
    const run = (r: unknown) => codeOf(() => alloc([], { rules: [r as CostRule] }));
    expect(run(bad([{ field: 'service', match: { op: 'regex', value: '(a+)+$' } }]))).toBe('REGEX_NOT_ALLOWED');
    expect(run(bad([{ field: 'service', match: { op: 'equals', value: 'a', pattern: 'a' } }]))).toBe('REGEX_NOT_ALLOWED');
    expect(run(bad([{ field: 'service', match: { op: 'equals', value: /a+/ } }]))).toBe('REGEX_NOT_ALLOWED');
    expect(run(bad([{ field: 'regex', match: { op: 'equals', value: 'a' } }]))).toBe('REGEX_NOT_ALLOWED');
    expect(run({ ...(bad([{ field: 'all' }]) as object), glob: '*' })).toBe('REGEX_NOT_ALLOWED');
  });

  it('refuses unknown keys, fields, ops, and a non-array rule set', () => {
    const run = (r: unknown) => codeOf(() => alloc([], { rules: r as CostRule[] }));
    expect(run({})).toBe('INVALID_RULE');
    expect(run([{ ...ok, extra: 1 }])).toBe('INVALID_RULE');
    expect(run([{ ...ok, when: [{ field: 'bogus' }] }])).toBe('INVALID_RULE');
    expect(run([{ ...ok, when: [{ field: 'service', match: { op: 'contains', value: 'a' } }] }])).toBe('INVALID_RULE');
    expect(run([{ ...ok, precedence: 1.5 }])).toBe('INVALID_RULE');
    expect(run([{ ...ok, precedence: '1' }])).toBe('INVALID_RULE');
    expect(run([{ ...ok, action: { kind: 'target', target: {} } }])).toBe('INVALID_TARGET');
    expect(run([{ ...ok, action: { kind: 'target', target: { owner: 'x' } } }])).toBe('INVALID_TARGET');
    expect(run([{ ...ok, action: { kind: 'pool', poolId: 'nope' } }])).toBe('UNKNOWN_POOL');
  });

  it('refuses a target that impersonates UNALLOCATED, including lookalikes', () => {
    for (const name of ['UNALLOCATED', 'unallocated', ' Unallocated', 'ＵＮＡＬＬＯＣＡＴＥＤ']) {
      const r: CostRule = { id: 'x', precedence: 1, when: [{ field: 'all' }], action: { kind: 'target', target: { team: name } } };
      expect(codeOf(() => alloc([], { rules: [r] }))).toMatch(/RESERVED_ID|INVALID_TARGET/);
    }
  });

  it('a catch-all rule must be explicit', () => {
    const r: CostRule = { id: 'all', precedence: 99, when: [{ field: 'all' }], action: { kind: 'target', target: { costCenter: 'general' } } };
    const l = alloc([row(), row({ tags: { env: 'prod' } })], { rules: [tagRule('p', 1, 'env', 'prod', 'prodteam'), r] });
    expect(l.lines.map((x) => x.ruleId)).toEqual(['all', 'p']);
  });

  it('error messages never echo the offending value', () => {
    const secret = 'SECRET-VALUE-XYZ';
    try {
      alloc([row({ amount: secret })], { rules: [] });
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
    try {
      alloc([], { rules: [{ id: secret + '!!', precedence: 1, when: [{ field: 'all' }], action: { kind: 'target', target: { team: 't' } } }] });
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
});

describe('untagged bucket', () => {
  it('unmatched spend lands in an explicit UNALLOCATED line and is never dropped', () => {
    const l = alloc([row({ amount: '10.00', tags: { env: 'prod' } }), row({ amount: '3.33' })], { rules: [tagRule('p', 1, 'env', 'prod', 'a')] });
    const un = l.lines.filter((x) => x.kind === 'unallocated');
    expect(un).toHaveLength(1);
    expect(un[0]).toMatchObject({ amount: '3.33', ruleId: UNMATCHED_RULE_ID, reason: 'NO_RULE_MATCHED', target: null });
    expect(l.totals[0]).toMatchObject({ ledger: '13.33', allocated: '10.00', unallocated: '3.33' });
    expect(UNALLOCATED).toBe('UNALLOCATED');
  });

  it('negative amounts (credits) allocate and reconcile', () => {
    const l = alloc([row({ amount: '-4.00', tags: { env: 'prod' } }), row({ amount: '10.00', tags: { env: 'prod' } })], { rules: [tagRule('p', 1, 'env', 'prod', 'a')] });
    expect(l.totals[0].allocated).toBe('6.00');
  });
});

describe('row validation, tenant scope and caps', () => {
  it('refuses a row from another tenant for the whole batch', () => {
    expect(codeOf(() => alloc([row(), row({ tenant: 'tenant-b' })], { rules: [] }))).toBe('TENANT_MISMATCH');
  });

  it('refuses duplicate row ids and malformed rows', () => {
    expect(codeOf(() => alloc([row({ id: 'same' }), row({ id: 'same' })], { rules: [] }))).toBe('DUPLICATE_ROW_ID');
    const bad = (over: Record<string, unknown>) => codeOf(() => alloc([{ ...row(), ...over } as AllocatableRow], { rules: [] }));
    expect(bad({ id: '' })).toBe('INVALID_ROW');
    expect(bad({ account: 'a\nb' })).toBe('INVALID_ROW');
    expect(bad({ service: 'x‮y' })).toBe('INVALID_ROW');
    expect(bad({ periodStart: '2026-02-30T00:00:00Z' })).toBe('INVALID_TIMESTAMP');
    expect(bad({ periodStart: '2026-03-01' })).toBe('INVALID_TIMESTAMP');
    expect(bad({ periodStart: '2026-03-01T00:00:00+02:00' })).toBe('INVALID_TIMESTAMP');
    expect(bad({ currency: 'ZZZ' })).toBe('UNKNOWN_CURRENCY');
    expect(bad({ amount: '1e3' })).toBe('INVALID_DECIMAL');
    expect(bad({ tags: null })).toBe('INVALID_TAGS');
    expect(bad({ tags: { a: 1 } })).toBe('INVALID_TAGS');
    expect(bad({ tags: [] })).toBe('INVALID_TAGS');
  });

  it('rejects a non-array row list and a non-object row', () => {
    expect(codeOf(() => allocateCosts(TENANT, 'x' as unknown as AllocatableRow[], { rules: [] }))).toBe('INVALID_ROW');
    expect(codeOf(() => alloc([null as unknown as AllocatableRow], { rules: [] }))).toBe('INVALID_ROW');
  });

  it('attaches the row position to the error but never the value', () => {
    try {
      alloc([row(), row({ amount: 'bad' })], { rules: [] });
    } catch (e) {
      expect((e as AllocationError).index).toBe(1);
    }
  });

  it('row cap: at the cap works, one past is refused before per-row work', () => {
    const mk = (n: number): AllocatableRow[] => Array.from({ length: n }, (_, i) => ({ ...row(), id: `r${i}` }));
    expect(alloc(mk(LIMITS.maxRows), { rules: [] }).totals[0].rowCount).toBe(LIMITS.maxRows);
    expect(codeOf(() => alloc(mk(LIMITS.maxRows + 1), { rules: [] }))).toBe('TOO_MANY_ROWS');
  });

  it('tag count and size caps', () => {
    const tags = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v']));
    expect(() => alloc([row({ tags: tags(LIMITS.maxTagsPerRow) })], { rules: [] })).not.toThrow();
    expect(codeOf(() => alloc([row({ tags: tags(LIMITS.maxTagsPerRow + 1) })], { rules: [] }))).toBe('TAGS_TOO_LARGE');
    expect(() => alloc([row({ tags: { k: 'v'.repeat(LIMITS.maxTagValueLength) } })], { rules: [] })).not.toThrow();
    expect(codeOf(() => alloc([row({ tags: { k: 'v'.repeat(LIMITS.maxTagValueLength + 1) } })], { rules: [] }))).toBe('INVALID_TAGS');
  });

  it('refuse mode aborts on a sub-minor row; the default carries it exactly', () => {
    const r = row({ amount: '1.005' });
    expect(codeOf(() => alloc([r], { rules: [], rounding: 'refuse' }))).toBe('PRECISION_EXCEEDED');
    const l = alloc([r], { rules: [] });
    expect(l.totals[0]).toMatchObject({ roundedRows: 1, ledgerExact: '1.00500000000000', ledger: '1.00', roundingDifference: '0.00500000000000' });
    expect(alloc([r], { rules: [], rounding: 'half-even' }).totals[0].ledger).toBe('1.00');
  });

  it('1000 rows of 0.004 USD are not rounded away: ledger 4.00, residual 0', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ ...row({ amount: '0.004', tags: { env: 'prod' } }), id: `s${i}` }));
    const l = alloc(rows, { rules: [tagRule('p', 1, 'env', 'prod', 'a')] });
    expect(l.totals[0]).toMatchObject({ ledger: '4.00', allocated: '4.00', unallocated: '0.00', roundedRows: 1000, roundingResidualMinor: BigInt(0), roundingDifference: '0.00000000000000' });
    expect(l.lines.reduce((a, x) => a + x.minor, BigInt(0))).toBe(BigInt(400));
    // deterministic: the first 400 ids in code-unit order carry the cent
    expect(l.lines.filter((x) => x.minor === BigInt(1))).toHaveLength(400);
    const rev = alloc([...rows].reverse(), { rules: [tagRule('p', 1, 'env', 'prod', 'a')] });
    expect(stable(rev.lines.map((x) => [x.rowId, x.minor]).sort())).toBe(stable(l.lines.map((x) => [x.rowId, x.minor]).sort()));
  });

  it('a sub-cent row among good rows keeps the batch and the money', () => {
    const rows = [row({ amount: '10.00', tags: { env: 'prod' } }), row({ amount: '0.004', tags: { env: 'prod' } }), row({ amount: '0.004' }), row({ amount: '5.50' })];
    const l = alloc(rows, { rules: [tagRule('p', 1, 'env', 'prod', 'a')] });
    // exact total 15.508 -> 15.51
    expect(l.totals[0]).toMatchObject({ ledger: '15.51', roundedRows: 2 });
    expect(l.totals[0].allocatedMinor + l.totals[0].unallocatedMinor).toBe(l.totals[0].ledgerMinor);
  });

  it('pool shares are rounded once with the exact-sum guarantee', () => {
    const rows = Array.from({ length: 3 }, () => row({ amount: '0.001', tags: { o: 'shared' } }));
    const l = alloc(rows, {
      rules: [{ id: 'sh', precedence: 1, when: [{ field: 'tag', key: 'o', match: { op: 'equals', value: 'shared' } }], action: { kind: 'pool', poolId: 'pool' } }],
      pools: [{ id: 'pool', policy: { kind: 'even', targets: [{ team: 'a' }, { team: 'b' }, { team: 'c' }] } }],
    });
    expect(l.totals[0].ledger).toBe('0.00'); // exact 0.003 rounds to 0.00 once
    expect(l.lines.every((x) => x.minor === BigInt(0))).toBe(true);
    expect(l.totals[0].roundingDifference).toBe('0.00300000000000');
  });

  it('JPY residual stays exact for whole yen and rounds sub-yen once', () => {
    const l = alloc([row({ currency: 'JPY', amount: '0.4' }), row({ currency: 'JPY', amount: '0.4' }), row({ currency: 'JPY', amount: '0.4' })], { rules: [] });
    expect(l.totals[0]).toMatchObject({ ledger: '1', roundedRows: 3 });
  });

  it('refuses unknown config keys and a bad rounding value', () => {
    expect(codeOf(() => alloc([], { rules: [], bogus: 1 } as unknown as AllocationConfig))).toBe('INVALID_CONFIG');
    expect(codeOf(() => alloc([], { rules: [], rounding: 'up' } as unknown as AllocationConfig))).toBe('INVALID_CONFIG');
    expect(codeOf(() => allocateCosts('', [], { rules: [] }))).toBe('INVALID_TENANT');
  });
});

describe('prototype-pollution keys', () => {
  it('treats __proto__, constructor and prototype tags as inert data', () => {
    const tags = JSON.parse('{"__proto__":"evil","constructor":"c","prototype":"p","env":"prod"}') as Record<string, string>;
    const rule: CostRule = { id: 'p', precedence: 1, when: [{ field: 'tag', key: '__proto__', match: { op: 'equals', value: 'evil' } }], action: { kind: 'target', target: { team: 'poll' } } };
    const l = alloc([row({ tags })], { rules: [rule] });
    expect(l.lines[0].ruleId).toBe('p');
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'evil')).toBe(false);
    expect(({} as Record<string, unknown>).env).toBeUndefined();
  });

  it('does not match a tag key that exists only on the prototype chain', () => {
    const rule: CostRule = { id: 'p', precedence: 1, when: [{ field: 'tag', key: 'constructor', match: { op: 'exists' } }], action: { kind: 'target', target: { team: 't' } } };
    expect(alloc([row({ tags: {} })], { rules: [rule] }).lines[0].kind).toBe('unallocated');
    const toStr: CostRule = { ...rule, when: [{ field: 'tag', key: 'toString', match: { op: 'exists' } }] };
    expect(alloc([row({ tags: {} })], { rules: [toStr] }).lines[0].kind).toBe('unallocated');
  });

  it('ignores inherited row properties (polluted prototype is not input)', () => {
    const polluted = Object.create({ tenant: TENANT, id: 'x', currency: 'USD', amount: '1.00' }) as AllocatableRow;
    expect(codeOf(() => alloc([polluted], { rules: [] }))).toBe('INVALID_ROW');
  });

  it('refuses accessor-based tags and class-instance tags', () => {
    const t = {};
    Object.defineProperty(t, 'k', { get: () => 'v', enumerable: true });
    expect(codeOf(() => alloc([row({ tags: t as Record<string, string> })], { rules: [] }))).toBe('INVALID_TAGS');
    class T { k = 'v'; }
    expect(codeOf(() => alloc([row({ tags: new T() as unknown as Record<string, string> })], { rules: [] }))).toBe('INVALID_TAGS');
  });

  it('a rule id or target named __proto__ is just text', () => {
    const r: CostRule = { id: 'ok', precedence: 1, when: [{ field: 'all' }], action: { kind: 'target', target: { team: '__proto__' } } };
    const l = alloc([row({ amount: '2.00' })], { rules: [r] });
    expect(l.lines[0].target).toEqual({ team: '__proto__' });
  });
});

describe('currencies and exponents', () => {
  const r: CostRule = { id: 'all', precedence: 1, when: [{ field: 'all' }], action: { kind: 'target', target: { team: 't' } } };

  it('reports per currency and never sums across currencies', () => {
    const l = alloc([row({ amount: '10.00' }), row({ currency: 'JPY', amount: '1000' }), row({ currency: 'KWD', amount: '1.234' })], { rules: [r] });
    expect(l.totals.map((t) => [t.currency, t.ledger])).toEqual([['JPY', '1000'], ['KWD', '1.234'], ['USD', '10.00']]);
  });

  it('JPY has no fractional digits and KWD has three', () => {
    expect(codeOf(() => alloc([row({ currency: 'JPY', amount: '10.5' })], { rules: [r], rounding: 'refuse' }))).toBe('PRECISION_EXCEEDED');
    expect(codeOf(() => alloc([row({ currency: 'KWD', amount: '1.2345' })], { rules: [r], rounding: 'refuse' }))).toBe('PRECISION_EXCEEDED');
    expect(alloc([row({ currency: 'KWD', amount: '0.001' })], { rules: [r] }).totals[0].ledgerMinor).toBe(BigInt(1));
  });

  it('splits a JPY pool in whole yen and a KWD pool in fils', () => {
    const pool = { id: 'pool', policy: { kind: 'even' as const, targets: [{ team: 'a' }, { team: 'b' }, { team: 'c' }] } };
    const toPool: CostRule = { id: 'sp', precedence: 1, when: [{ field: 'all' }], action: { kind: 'pool', poolId: 'pool' } };
    const jpy = alloc([row({ currency: 'JPY', amount: '100' })], { rules: [toPool], pools: [pool] });
    expect(jpy.lines.map((x) => x.amount)).toEqual(['34', '33', '33']);
    const kwd = alloc([row({ currency: 'KWD', amount: '0.100' })], { rules: [toPool], pools: [pool] });
    expect(kwd.lines.map((x) => x.amount)).toEqual(['0.034', '0.033', '0.033']);
  });

  it('keeps pools of different currencies apart', () => {
    const pool = { id: 'pool', policy: { kind: 'proportional' as const, among: 'team' as const } };
    const rules: CostRule[] = [
      tagRule('da', 1, 'o', 'a', 'a'),
      tagRule('db', 2, 'o', 'b', 'b'),
      { id: 'sp', precedence: 3, when: [{ field: 'tag', key: 'o', match: { op: 'equals', value: 'shared' } }], action: { kind: 'pool', poolId: 'pool' } },
    ];
    const l = alloc(
      [
        row({ amount: '100.00', tags: { o: 'a' } }),
        row({ currency: 'EUR', amount: '100.00', tags: { o: 'b' } }),
        row({ amount: '10.00', tags: { o: 'shared' } }),
        row({ currency: 'EUR', amount: '10.00', tags: { o: 'shared' } }),
      ],
      { rules, pools: [pool] },
    );
    const shared = l.lines.filter((x) => x.kind === 'shared');
    expect(shared.map((x) => [x.currency, x.target, x.amount])).toEqual([
      ['EUR', { team: 'b' }, '10.00'],
      ['USD', { team: 'a' }, '10.00'],
    ]);
  });
});

describe('shared pools', () => {
  const toPool = (id: string, prec: number, key: string, value: string, poolId: string): CostRule => ({
    id,
    precedence: prec,
    when: [{ field: 'tag', key, match: { op: 'equals', value } }],
    action: { kind: 'pool', poolId },
  });
  const direct: CostRule[] = [tagRule('da', 1, 'o', 'a', 'a'), tagRule('db', 2, 'o', 'b', 'b'), tagRule('dc', 3, 'o', 'c', 'c')];

  it('proportional to direct spend, exact and deterministic', () => {
    const rules = [...direct, toPool('sh', 10, 'o', 'shared', 'pool')];
    const rows = [
      row({ amount: '50.00', tags: { o: 'a' } }),
      row({ amount: '30.00', tags: { o: 'b' } }),
      row({ amount: '20.00', tags: { o: 'c' } }),
      row({ amount: '100.01', tags: { o: 'shared' } }),
    ];
    const l = alloc(rows, { rules, pools: [{ id: 'pool', policy: { kind: 'proportional', among: 'team' } }] });
    const shared = l.lines.filter((x) => x.kind === 'shared');
    expect(shared.map((x) => [(x.target as { team: string }).team, x.amount])).toEqual([['a', '50.01'], ['b', '30.00'], ['c', '20.00']]);
    expect(shared.every((x) => x.ruleId === 'pool' && x.viaRuleIds[0] === 'sh')).toBe(true);
    expect(l.totals[0]).toMatchObject({ ledger: '200.01', allocated: '200.01', unallocated: '0.00' });
    expect(stable(alloc(rows, { rules, pools: [{ id: 'pool', policy: { kind: 'proportional', among: 'team' } }] }))).toBe(stable(l));
  });

  it('proportional with no positive direct spend becomes an explicit UNALLOCATED line', () => {
    const rules = [...direct, toPool('sh', 10, 'o', 'shared', 'pool')];
    const l = alloc([row({ amount: '9.99', tags: { o: 'shared' } })], { rules, pools: [{ id: 'pool', policy: { kind: 'proportional', among: 'team' } }] });
    expect(l.lines).toHaveLength(1);
    expect(l.lines[0]).toMatchObject({ kind: 'unallocated', reason: 'POOL_NO_WEIGHT', ruleId: 'pool', amount: '9.99' });
    expect(l.totals[0].unallocated).toBe('9.99');
  });

  it('a target with net-negative direct spend gets no share', () => {
    const rules = [...direct, toPool('sh', 10, 'o', 'shared', 'pool')];
    const l = alloc(
      [row({ amount: '-5.00', tags: { o: 'a' } }), row({ amount: '10.00', tags: { o: 'b' } }), row({ amount: '6.00', tags: { o: 'shared' } })],
      { rules, pools: [{ id: 'pool', policy: { kind: 'proportional', among: 'team' } }] },
    );
    const shared = l.lines.filter((x) => x.kind === 'shared');
    expect(shared.map((x) => [x.target, x.amount])).toEqual([[{ team: 'b' }, '6.00']]);
  });

  it('even split distributes the remainder by key order', () => {
    const l = alloc([row({ amount: '0.05', tags: { o: 'shared' } })], {
      rules: [toPool('sh', 1, 'o', 'shared', 'pool')],
      pools: [{ id: 'pool', policy: { kind: 'even', targets: [{ team: 'z' }, { team: 'a' }, { team: 'm' }] } }],
    });
    expect(l.lines.map((x) => [(x.target as { team: string }).team, x.amount])).toEqual([['a', '0.02'], ['m', '0.02'], ['z', '0.01']]);
  });

  it('fixed percent must sum to exactly 100', () => {
    const mk = (a: string, b: string, c: string) => ({
      id: 'pool',
      policy: { kind: 'fixedPercent' as const, shares: [{ target: { team: 'a' }, percent: a }, { target: { team: 'b' }, percent: b }, { target: { team: 'c' }, percent: c }] },
    });
    const rules = [toPool('sh', 1, 'o', 'shared', 'pool')];
    const rows = [row({ amount: '100.00', tags: { o: 'shared' } })];
    expect(codeOf(() => alloc(rows, { rules, pools: [mk('33.3333', '33.3333', '33.3333')] }))).toBe('PERCENT_SUM_INVALID');
    expect(codeOf(() => alloc(rows, { rules, pools: [mk('50', '50', '0.0001')] }))).toBe('PERCENT_SUM_INVALID');
    expect(codeOf(() => alloc(rows, { rules, pools: [mk('50', '40', '9.9999')] }))).toBe('PERCENT_SUM_INVALID');
    expect(codeOf(() => alloc(rows, { rules, pools: [mk('60', '50', '-10')] }))).toBe('NEGATIVE_AMOUNT');
    expect(codeOf(() => alloc(rows, { rules, pools: [mk('1e1', '45', '45')] }))).toBe('INVALID_DECIMAL');
    const l = alloc(rows, { rules, pools: [mk('33.3333', '33.3333', '33.3334')] });
    expect(l.lines.map((x) => x.amount)).toEqual(['33.33', '33.33', '33.34']);
    expect(l.totals[0].allocated).toBe('100.00');
  });

  it('fixed percent with a zero share allocates nothing to it', () => {
    const l = alloc([row({ amount: '10.00', tags: { o: 'shared' } })], {
      rules: [toPool('sh', 1, 'o', 'shared', 'pool')],
      pools: [{ id: 'pool', policy: { kind: 'fixedPercent', shares: [{ target: { team: 'a' }, percent: '100' }, { target: { team: 'b' }, percent: '0' }] } }],
    });
    expect(l.lines).toHaveLength(1);
  });

  it('usage weights split by weight; all-zero weights are refused', () => {
    const rules = [toPool('sh', 1, 'o', 'shared', 'pool')];
    const rows = [row({ amount: '10.00', tags: { o: 'shared' } })];
    const l = alloc(rows, { rules, pools: [{ id: 'pool', policy: { kind: 'usageWeight', weights: [{ target: { team: 'a' }, weight: '1' }, { target: { team: 'b' }, weight: '3.5' }] } }] });
    expect(l.lines.map((x) => x.amount)).toEqual(['2.22', '7.78']);
    expect(codeOf(() => alloc(rows, { rules, pools: [{ id: 'pool', policy: { kind: 'usageWeight', weights: [{ target: { team: 'a' }, weight: '0' }] } }] }))).toBe('ZERO_WEIGHT');
  });

  it('refuses malformed pools: duplicate id, duplicate target, caps, bad kind', () => {
    const rules: CostRule[] = [];
    const evenOf = (n: number) => ({ id: 'p', policy: { kind: 'even' as const, targets: Array.from({ length: n }, (_, i) => ({ team: `t${i}` })) } });
    expect(codeOf(() => alloc([], { rules, pools: [evenOf(1), evenOf(1)] }))).toBe('DUPLICATE_POOL_ID');
    expect(codeOf(() => alloc([], { rules, pools: [{ id: 'p', policy: { kind: 'even', targets: [{ team: 'a' }, { team: 'a' }] } }] }))).toBe('DUPLICATE_KEY');
    expect(codeOf(() => alloc([], { rules, pools: [{ id: 'p', policy: { kind: 'bogus' } as never }] }))).toBe('INVALID_POOL');
    expect(codeOf(() => alloc([], { rules, pools: [{ id: 'p', policy: { kind: 'even', targets: [] } }] }))).toBe('INVALID_POOL');
    expect(() => alloc([], { rules, pools: [evenOf(LIMITS.maxPoolTargets)] })).not.toThrow();
    expect(codeOf(() => alloc([], { rules, pools: [evenOf(LIMITS.maxPoolTargets + 1)] }))).toBe('TOO_MANY_VALUES');
    const many = Array.from({ length: LIMITS.maxPools + 1 }, (_, i) => ({ id: `p${i}`, policy: { kind: 'even' as const, targets: [{ team: 'a' }] } }));
    expect(() => alloc([], { rules, pools: many.slice(0, LIMITS.maxPools) })).not.toThrow();
    expect(codeOf(() => alloc([], { rules, pools: many }))).toBe('TOO_MANY_POOLS');
  });

  it('rule ids and pool ids share one namespace', () => {
    expect(
      codeOf(() => alloc([], { rules: [tagRule('x', 1, 'k', 'v', 't')], pools: [{ id: 'x', policy: { kind: 'even', targets: [{ team: 'a' }] } }] })),
    ).toBe('DUPLICATE_RULE_ID');
  });

  it('a pool with zero net intake emits no lines', () => {
    const l = alloc([row({ amount: '5.00', tags: { o: 'shared' } }), row({ amount: '-5.00', tags: { o: 'shared' } })], {
      rules: [toPool('sh', 1, 'o', 'shared', 'pool')],
      pools: [{ id: 'pool', policy: { kind: 'even', targets: [{ team: 'a' }] } }],
    });
    expect(l.lines).toHaveLength(0);
    expect(l.totals[0]).toMatchObject({ ledger: '0.00', allocated: '0.00' });
  });
});

describe('reconciliation property tests (seeded)', () => {
  const CURRENCIES = ['USD', 'JPY', 'KWD', 'EUR', 'CLF'];
  function randomAmount(rnd: () => number, currency: string): string {
    const exp = { USD: 2, EUR: 2, JPY: 0, KWD: 3, CLF: 4 }[currency as 'USD'];
    const whole = Math.floor(rnd() * 5000);
    const frac = exp === 0 ? '' : '.' + String(Math.floor(rnd() * 10 ** exp)).padStart(exp, '0');
    return `${rnd() < 0.15 ? '-' : ''}${whole}${frac}`;
  }

  it('allocated + unallocated == ledger total, per currency, for 300 random scenarios', () => {
    const rnd = mulberry32(0xc0ffee);
    const teams = ['t1', 't2', 't3', 't4'];
    for (let s = 0; s < 300; s++) {
      resetIds();
      const pools = [
        { id: 'pp', policy: { kind: 'proportional' as const, among: 'team' as const } },
        { id: 'pe', policy: { kind: 'even' as const, targets: teams.slice(0, 1 + Math.floor(rnd() * 4)).map((team) => ({ team })) } },
        { id: 'pf', policy: { kind: 'fixedPercent' as const, shares: [{ target: { team: 't1' }, percent: '12.3457' }, { target: { team: 't2' }, percent: '87.6543' }] } },
        { id: 'pu', policy: { kind: 'usageWeight' as const, weights: [{ target: { team: 't3' }, weight: '0.333333' }, { target: { team: 't4' }, weight: '7.1' }] } },
      ];
      const rules: CostRule[] = [
        ...teams.map((t, i) => tagRule(`d-${t}`, i + 1, 'team', t, t)),
        { id: 's-p', precedence: 10, when: [{ field: 'tag', key: 'pool', match: { op: 'equals', value: 'pp' } }], action: { kind: 'pool', poolId: 'pp' } },
        { id: 's-e', precedence: 11, when: [{ field: 'tag', key: 'pool', match: { op: 'equals', value: 'pe' } }], action: { kind: 'pool', poolId: 'pe' } },
        { id: 's-f', precedence: 12, when: [{ field: 'tag', key: 'pool', match: { op: 'equals', value: 'pf' } }], action: { kind: 'pool', poolId: 'pf' } },
        { id: 's-u', precedence: 13, when: [{ field: 'tag', key: 'pool', match: { op: 'equals', value: 'pu' } }], action: { kind: 'pool', poolId: 'pu' } },
      ];
      const n = Math.floor(rnd() * 60);
      const rows: AllocatableRow[] = [];
      for (let i = 0; i < n; i++) {
        const currency = CURRENCIES[Math.floor(rnd() * CURRENCIES.length)];
        const tags: Record<string, string> = {};
        const r = rnd();
        if (r < 0.4) tags.team = teams[Math.floor(rnd() * teams.length)];
        else if (r < 0.8) tags.pool = ['pp', 'pe', 'pf', 'pu'][Math.floor(rnd() * 4)];
        rows.push(row({ currency, amount: randomAmount(rnd, currency), tags, periodStart: rnd() < 0.5 ? '2026-03-05T00:00:00Z' : '2026-04-05T00:00:00Z' }));
      }
      const ledger = alloc(rows, { rules, pools });
      const expected = new Map<string, bigint>();
      for (const r of rows) {
        const exp = { USD: 2, EUR: 2, JPY: 0, KWD: 3, CLF: 4 }[r.currency as 'USD'];
        const [w, f = ''] = r.amount.replace('-', '').split('.');
        const v = BigInt(w + f.padEnd(exp, '0'));
        expected.set(r.currency, (expected.get(r.currency) ?? BigInt(0)) + (r.amount.startsWith('-') ? -v : v));
      }
      expect(ledger.totals.map((t) => t.currency)).toEqual([...expected.keys()].sort());
      for (const t of ledger.totals) {
        expect(t.ledgerMinor).toBe(expected.get(t.currency));
        expect(t.allocatedMinor + t.unallocatedMinor).toBe(t.ledgerMinor);
        const byLines = ledger.lines.filter((l) => l.currency === t.currency).reduce((a, l) => a + l.minor, BigInt(0));
        expect(byLines).toBe(t.ledgerMinor);
      }
    }
  });

  it('result does not depend on row order', () => {
    const rnd = mulberry32(7);
    resetIds();
    const rules: CostRule[] = [tagRule('d1', 1, 'team', 't1', 't1'), tagRule('d2', 2, 'team', 't2', 't2'), { id: 's', precedence: 3, when: [{ field: 'tag', key: 'pool', match: { op: 'exists' } }], action: { kind: 'pool', poolId: 'pp' } }];
    const pools = [{ id: 'pp', policy: { kind: 'proportional' as const, among: 'team' as const } }];
    const rows = Array.from({ length: 40 }, () => row({ amount: randomAmount(rnd, 'USD'), tags: rnd() < 0.5 ? { team: rnd() < 0.5 ? 't1' : 't2' } : { pool: 'x' } }));
    const a = alloc(rows, { rules, pools });
    const b = alloc([...rows].reverse(), { rules, pools });
    expect(a.totals).toEqual(b.totals);
    const key = (l: (typeof a.lines)[number]) => `${l.kind}|${l.ruleId}|${JSON.stringify(l.target)}|${l.month}|${l.currency}`;
    const sumBy = (ls: typeof a.lines) => {
      const m = new Map<string, bigint>();
      for (const l of ls) if (l.kind !== 'direct') m.set(key(l), (m.get(key(l)) ?? BigInt(0)) + l.minor);
      return [...m.entries()].sort();
    };
    expect(sumBy(a.lines)).toEqual(sumBy(b.lines));
  });

  it('does not mutate its inputs', () => {
    const rows = [row({ tags: { team: 't1' } })];
    const rules = [tagRule('d1', 1, 'team', 't1', 't1')];
    const before = stable({ rows, rules });
    alloc(rows, { rules });
    expect(stable({ rows, rules })).toBe(before);
  });
});

describe('reserved bucket names with invisible characters', () => {
  const mk = (name: string): CostRule => ({ id: 'x', precedence: 1, when: [{ field: 'all' }], action: { kind: 'target', target: { team: name } } });
  it('refuses UNALLOCATED spelled with zero-width, soft-hyphen, BOM or bidi characters', () => {
    for (const c of ['\u200B', '\u200D', '\u00AD', '\uFEFF', '\u2060', '\u061C']) {
      expect(codeOf(() => alloc([], { rules: [mk(`UNALLO${c}CATED`)] }))).toBe('INVALID_TARGET');
    }
  });
  it('refuses any format character in a target name, accepts ordinary names', () => {
    expect(codeOf(() => alloc([], { rules: [mk('team\u200Bx')] }))).toBe('INVALID_TARGET');
    expect(codeOf(() => alloc([], { rules: [mk('team-x')] }))).toBeUndefined();
  });
  it('isReservedBucketName strips format characters on its own', async () => {
    const { isReservedBucketName } = await import('./targets');
    expect(isReservedBucketName('UNALLO\u200BCATED')).toBe(true);
    expect(isReservedBucketName('Unallocated ')).toBe(true);
    expect(isReservedBucketName('allocated')).toBe(false);
  });
});

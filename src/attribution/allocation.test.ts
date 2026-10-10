import { describe, expect, it } from 'vitest';
import { allocateSharedCost, convertWithRate, distributeByWeight, nutanixDualView, type AllocationRow } from './allocation';

const row = (over: Partial<AllocationRow> & { amount: string }): AllocationRow => ({
  rowKey: 'r1',
  currency: 'USD',
  directOrShared: 'shared',
  projectId: null,
  ...over,
});

describe('allocateSharedCost — control-total invariant', () => {
  // direct 60.00 (p-a) + shared 40.00 (targets p-a/p-b) + unidentified 10.005.
  const rows: AllocationRow[] = [
    row({ rowKey: 'd1', directOrShared: 'direct', projectId: 'p-a', amount: '60.00' }),
    row({ rowKey: 's1', amount: '40.00', targets: ['p-a', 'p-b'] }),
    row({ rowKey: 's2', amount: '10.005' }),
  ];

  it('even_split: allocated + unallocated == source total, exactly', () => {
    const res = allocateSharedCost({ currency: 'USD', rows }, 'even_split');
    const allocated = res.allocations.reduce((a, x) => a + Number(x.amount), 0);
    // 40.00 splits 20/20; 10.005 has no identity; 60.00 carries as direct.
    expect(allocated).toBe(40);
    expect(res.unallocated).toBe('10.005');
    // The slice's union scale is 3 ('10.005'), so attributed renders at scale 3.
    expect(res.coverage.attributedAmount).toBe('100.000');
    expect(res.coverage.totalAmount).toBe('110.005');
    expect(res.coverage.attributedPct).toBe(90.9); // floored, never overstated
  });

  it('keyed_tag: untagged shared cost stays unallocated, total preserved', () => {
    const res = allocateSharedCost({ currency: 'USD', rows }, 'keyed_tag');
    expect(res.allocations).toHaveLength(0);
    expect(res.unallocated).toBe('50.005');
    expect(res.coverage.totalAmount).toBe('110.005');
  });

  it('proportional_to_attributed: every shared row follows the direct weights (tags not required)', () => {
    const res = allocateSharedCost({ currency: 'USD', rows }, 'proportional_to_attributed');
    // The slice has one attributed project, so both shared rows go to it whole.
    expect(res.allocations).toEqual([
      { rowKey: 's1', projectId: 'p-a', amount: '40.000', rule: 'proportional_to_attributed' },
      { rowKey: 's2', projectId: 'p-a', amount: '10.005', rule: 'proportional_to_attributed' },
    ]);
    expect(res.unallocated).toBe('0.000');
    expect(res.coverage.attributedAmount).toBe('110.005');
    expect(res.coverage.attributedPct).toBe(100);
  });
});

describe('even_split', () => {
  it('splits evenly and hands remainder units deterministically', () => {
    const res = allocateSharedCost(
      { currency: 'USD', rows: [row({ amount: '100.00', targets: ['p-b', 'p-a', 'p-c'] })] },
      'even_split',
    );
    const byProject = Object.fromEntries(res.allocations.map((a) => [a.projectId, a.amount]));
    // 100.00/3: two targets take 33.34 (largest remainder, stable order), one 33.32? No — 33.33+33.33+33.34.
    expect(byProject).toEqual({ 'p-a': '33.34', 'p-b': '33.33', 'p-c': '33.33' });
    expect(res.unallocated).toBe('0.00');
    expect(res.coverage.attributedPct).toBe(100);
  });

  it('dedupes targets', () => {
    const res = allocateSharedCost({ currency: 'USD', rows: [row({ amount: '10.00', targets: ['p-a', 'p-a'] })] }, 'even_split');
    expect(res.allocations).toHaveLength(1);
    expect(res.allocations[0].amount).toBe('10.00');
  });

  it('reports cost with no sharing targets as unallocated', () => {
    const res = allocateSharedCost({ currency: 'USD', rows: [row({ amount: '5.00' })] }, 'even_split');
    expect(res.allocations).toHaveLength(0);
    expect(res.unallocated).toBe('5.00');
    expect(res.coverage.attributedPct).toBe(0);
  });
});

describe('keyed_tag', () => {
  it('allocates fully to the tagged project', () => {
    const res = allocateSharedCost({ currency: 'USD', rows: [row({ amount: '12.50', projectId: 'p-x' })] }, 'keyed_tag');
    expect(res.allocations).toEqual([{ rowKey: 'r1', projectId: 'p-x', amount: '12.50', rule: 'keyed_tag' }]);
  });

  it('never guesses when the tag is missing', () => {
    const res = allocateSharedCost({ currency: 'USD', rows: [row({ amount: '12.50' })] }, 'keyed_tag');
    expect(res.allocations).toHaveLength(0);
    expect(res.unallocated).toBe('12.50');
  });
});

describe('proportional_to_attributed', () => {
  it('splits shared cost in proportion to attributed direct cost', () => {
    const rows: AllocationRow[] = [
      row({ rowKey: 'd1', directOrShared: 'direct', projectId: 'p-a', amount: '75.00' }),
      row({ rowKey: 'd2', directOrShared: 'direct', projectId: 'p-b', amount: '25.00' }),
      row({ rowKey: 's1', amount: '100.00' }),
    ];
    const res = allocateSharedCost({ currency: 'USD', rows }, 'proportional_to_attributed');
    const byProject = Object.fromEntries(res.allocations.map((a) => [a.projectId, a.amount]));
    expect(byProject['p-a']).toBe('75.00');
    expect(byProject['p-b']).toBe('25.00');
    expect(res.unallocated).toBe('0.00');
  });

  it('zero-denominator guard: no attributed base leaves shared cost unallocated', () => {
    const rows: AllocationRow[] = [
      row({ rowKey: 's1', amount: '30.00' }),
      row({ rowKey: 'u1', directOrShared: null, projectId: 'p-a', amount: '7.00' }),
    ];
    const res = allocateSharedCost({ currency: 'USD', rows }, 'proportional_to_attributed');
    expect(res.allocations).toHaveLength(0);
    expect(res.unallocated).toBe('37.00');
    expect(res.coverage.attributedPct).toBe(0);
  });

  it('weights that cancel to zero are a zero denominator, not a division', () => {
    const rows: AllocationRow[] = [
      row({ rowKey: 'd1', directOrShared: 'direct', projectId: 'p-a', amount: '5.00' }),
      row({ rowKey: 'd2', directOrShared: 'direct', projectId: 'p-b', amount: '-5.00' }),
      row({ rowKey: 's1', amount: '9.00' }),
    ];
    const res = allocateSharedCost({ currency: 'USD', rows }, 'proportional_to_attributed');
    expect(res.allocations).toHaveLength(0);
    expect(res.unallocated).toBe('9.00');
  });
});

describe('coverage', () => {
  it('reports the unattributed share and never overstates coverage', () => {
    const rows: AllocationRow[] = [
      row({ rowKey: 'd1', directOrShared: 'direct', projectId: 'p-a', amount: '94.1' }),
      row({ rowKey: 'u1', directOrShared: null, projectId: null, amount: '5.9' }),
    ];
    const res = allocateSharedCost({ currency: 'USD', rows }, 'keyed_tag');
    expect(res.coverage.attributedAmount).toBe('94.1');
    expect(res.coverage.totalAmount).toBe('100.0');
    expect(res.coverage.attributedPct).toBe(94.1);
  });

  it('is null on a zero-total slice instead of inventing a percentage', () => {
    const res = allocateSharedCost({ currency: 'USD', rows: [] }, 'even_split');
    expect(res.coverage.attributedPct).toBeNull();
    expect(res.coverage.totalAmount).toBe('0');
  });
});

describe('distributeByWeight', () => {
  it('preserves the total including negative totals', () => {
    expect(distributeByWeight(-5n, [1n, 1n, 1n])).toEqual([-2n, -2n, -1n]);
  });

  it('returns zeros on zero weights', () => {
    expect(distributeByWeight(10n, [0n, 0n])).toEqual([0n, 0n]);
  });
});

describe('read-time derivations', () => {
  it('convertWithRate multiplies exactly at the union scale', () => {
    expect(convertWithRate('10.25', '1.0855')).toBe('11.126375');
  });

  it('nutanixDualView returns two labeled views; TCO adds allocated shared to effective', () => {
    const v = nutanixDualView({ billedOpex: '1000.00', effectiveCost: '980.00', allocatedShared: '20.00' });
    expect(v.incrementalOpex).toBe('1000.00');
    expect(v.fullyAllocatedTco).toBe('1000.00');
  });

  it('nutanixDualView keeps the views distinct when the numbers coincide', () => {
    const v = nutanixDualView({ billedOpex: '500.00', effectiveCost: '450.00', allocatedShared: '0' });
    expect(v.incrementalOpex).toBe('500.00');
    expect(v.fullyAllocatedTco).toBe('450.00');
  });
});

describe('input hygiene', () => {
  it('refuses a slice that mixes currencies', () => {
    const rows: AllocationRow[] = [
      row({ amount: '1.00' }),
      row({ rowKey: 'eur', amount: '2.00', currency: 'EUR' }),
    ];
    expect(() => allocateSharedCost({ currency: 'USD', rows }, 'even_split')).toThrow(/mixes currencies/);
  });

  it('is deterministic: same inputs, same allocations', () => {
    const rows: AllocationRow[] = [row({ amount: '100.00', targets: ['p-a', 'p-b'] })];
    const a = allocateSharedCost({ currency: 'USD', rows }, 'even_split');
    const b = allocateSharedCost({ currency: 'USD', rows }, 'even_split');
    expect(a).toEqual(b);
  });
});


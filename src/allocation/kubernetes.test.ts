import { describe, expect, it } from 'vitest';
import { AllocationError } from './errors';
import { LIMITS } from './limits';
import { K8S_IDLE, K8S_SYSTEM_OVERHEAD, apportionKubernetesCost, type K8sRequest, type K8sWorkload } from './kubernetes';
import { mulberry32 } from './testFixtures';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof AllocationError) return e.code;
    throw e;
  }
  return undefined;
}

const wl = (id: string, namespace: string, cpuReq: number, cpuUse: number, memReq: number, memUse: number, extra: Partial<K8sWorkload> = {}): K8sWorkload => ({
  id,
  namespace,
  cpuRequestMillicores: cpuReq,
  cpuUsageMillicores: cpuUse,
  memoryRequestMiB: memReq,
  memoryUsageMiB: memUse,
  ...extra,
});

function req(over: Partial<K8sRequest> = {}): K8sRequest {
  return {
    tenant: 'tenant-a',
    clusterId: 'c1',
    currency: 'USD',
    units: { cpu: 'millicores', memory: 'MiB' },
    nodes: [{ id: 'n1', currency: 'USD', amount: '100.00', cpuCapacityMillicores: 4000, memoryCapacityMiB: 16000 }],
    workloads: [wl('w1', 'team-a', 1000, 500, 4000, 2000), wl('w2', 'team-b', 1000, 1500, 4000, 6000)],
    basis: 'request',
    resourceWeights: { cpu: '50', memory: '50' },
    sharedPolicy: { kind: 'even' },
    ...over,
  };
}
const lineOf = (r: ReturnType<typeof apportionKubernetesCost>, group: string | null, kind = 'workload') =>
  r.nodeLines.find((l) => l.group === group && l.kind === kind)!;

describe('basis: request, usage, max', () => {
  it('splits by request, with idle as an explicit line', () => {
    const r = apportionKubernetesCost(req());
    // pools 50/50. cpu: a=1000,b=1000,idle=2000 -> 12.50,12.50,25.00. mem: 4000,4000,idle 8000 -> same
    expect(lineOf(r, 'team-a').amount).toBe('25.00');
    expect(lineOf(r, 'team-b').amount).toBe('25.00');
    expect(lineOf(r, null, 'idle').amount).toBe('50.00');
    expect(r.idleMinor).toBe(BigInt(5000));
    expect(r.reconciliation).toMatchObject({ nodeCostMinor: BigInt(10000), nodeAllocatedMinor: BigInt(10000), reconciled: true });
  });

  it('splits by usage', () => {
    const r = apportionKubernetesCost(req({ basis: 'usage' }));
    // cpu: a=500,b=1500,idle=2000 ; mem: a=2000,b=6000,idle=8000
    expect(lineOf(r, 'team-a').amount).toBe('12.50');
    expect(lineOf(r, 'team-b').amount).toBe('37.50');
    expect(lineOf(r, null, 'idle').amount).toBe('50.00');
  });

  it('uses the larger of request and usage per workload', () => {
    const r = apportionKubernetesCost(req({ basis: 'max' }));
    // a: max(1000,500)=1000 cpu, 4000 mem ; b: max(1000,1500)=1500, 6000 -> idle cpu 1500, mem 6000
    expect(lineOf(r, 'team-a').cpuMinor + lineOf(r, 'team-a').memoryMinor).toBe(lineOf(r, 'team-a').minor);
    expect(lineOf(r, 'team-a').amount).toBe('25.00'); // 1000/4000 of 50 + 4000/16000 of 50
    expect(lineOf(r, 'team-b').amount).toBe('37.50');
    expect(lineOf(r, null, 'idle').amount).toBe('37.50');
  });

  it('explicit weights decide the cpu/memory split; one side may be zero', () => {
    const r = apportionKubernetesCost(req({ resourceWeights: { cpu: '100', memory: '0' } }));
    expect(lineOf(r, 'team-a').memoryMinor).toBe(BigInt(0));
    expect(lineOf(r, 'team-a').amount).toBe('25.00');
    const r2 = apportionKubernetesCost(req({ resourceWeights: { cpu: '70', memory: '30' }, workloads: [wl('w', 'team-a', 4000, 4000, 0, 0)] }));
    expect(lineOf(r2, 'team-a').amount).toBe('70.00');
    expect(lineOf(r2, null, 'idle').amount).toBe('30.00');
  });

  it('refuses weights that do not sum to exactly 100', () => {
    expect(codeOf(() => apportionKubernetesCost(req({ resourceWeights: { cpu: '60', memory: '39.9999' } })))).toBe('PERCENT_SUM_INVALID');
    expect(codeOf(() => apportionKubernetesCost(req({ resourceWeights: { cpu: '60', memory: '41' } })))).toBe('PERCENT_SUM_INVALID');
    expect(codeOf(() => apportionKubernetesCost(req({ resourceWeights: { cpu: '-10', memory: '110' } })))).toBe('NEGATIVE_AMOUNT');
  });
});

describe('idle, overhead, zero usage and one namespace', () => {
  it('zero usage on the usage basis makes everything idle', () => {
    const r = apportionKubernetesCost(req({ basis: 'usage', workloads: [wl('w1', 'a', 1000, 0, 4000, 0), wl('w2', 'b', 1000, 0, 4000, 0)] }));
    expect(r.idleMinor).toBe(BigInt(10000));
    expect(r.nodeLines.filter((l) => l.kind === 'workload').every((l) => l.minor === BigInt(0))).toBe(true);
  });

  it('no workloads at all: everything is idle', () => {
    const r = apportionKubernetesCost(req({ workloads: [] }));
    expect(r.idleMinor).toBe(BigInt(10000));
    expect(r.groups).toEqual([]);
  });

  it('a single namespace takes all workload cost; idle stays separate', () => {
    const r = apportionKubernetesCost(req({ workloads: [wl('w', 'only', 4000, 4000, 16000, 16000)] }));
    expect(lineOf(r, 'only').amount).toBe('100.00');
    expect(r.idleMinor).toBe(BigInt(0));
  });

  it('reserved capacity and system namespaces are system overhead', () => {
    const r = apportionKubernetesCost(
      req({
        nodes: [{ id: 'n1', currency: 'USD', amount: '100.00', cpuCapacityMillicores: 4000, memoryCapacityMiB: 16000, cpuReservedMillicores: 500, memoryReservedMiB: 2000 }],
        workloads: [wl('w1', 'team-a', 1000, 1000, 4000, 4000), wl('k', 'kube-system', 500, 500, 2000, 2000)],
        systemNamespaces: ['kube-system'],
      }),
    );
    // cpu pool 50: a 1000, system 500+500, idle 2000 -> 12.5, 12.5, 25
    expect(lineOf(r, 'team-a').amount).toBe('25.00');
    expect(lineOf(r, null, 'systemOverhead').amount).toBe('25.00');
    expect(lineOf(r, null, 'idle').amount).toBe('50.00');
    expect(r.systemOverheadMinor).toBe(BigInt(2500));
    expect(r.groups.map((g) => g.group)).toEqual(['team-a']);
  });

  it('overcommit (bases above capacity) leaves no idle and shares in proportion', () => {
    const r = apportionKubernetesCost(req({ workloads: [wl('a', 'a', 3000, 0, 12000, 0), wl('b', 'b', 3000, 0, 12000, 0)] }));
    expect(r.idleMinor).toBe(BigInt(0));
    expect(lineOf(r, 'a').amount).toBe('50.00');
    expect(lineOf(r, 'b').amount).toBe('50.00');
  });

  it('aggregates several workloads and nodes in one group', () => {
    const r = apportionKubernetesCost(
      req({
        nodes: [
          { id: 'n1', currency: 'USD', amount: '60.00', cpuCapacityMillicores: 2000, memoryCapacityMiB: 8000 },
          { id: 'n2', currency: 'USD', amount: '40.00', cpuCapacityMillicores: 2000, memoryCapacityMiB: 8000 },
        ],
        workloads: [wl('w1', 'a', 1000, 0, 2000, 0), wl('w2', 'a', 1000, 0, 2000, 0), wl('w3', 'b', 2000, 0, 12000, 0)],
      }),
    );
    expect(r.nodeCostMinor).toBe(BigInt(10000));
    expect(lineOf(r, 'a').cpuMinor).toBe(BigInt(2500)); // 2000 of 4000 millicores
  });
});

describe('grouping by label', () => {
  it('groups by a label value and puts unlabeled workloads in UNLABELED', () => {
    const r = apportionKubernetesCost(
      req({
        groupBy: { kind: 'label', key: 'app' },
        workloads: [wl('w1', 'ns1', 1000, 0, 4000, 0, { labels: { app: 'shop' } }), wl('w2', 'ns2', 1000, 0, 4000, 0, { labels: { app: 'shop' } }), wl('w3', 'ns3', 1000, 0, 4000, 0)],
      }),
    );
    expect(r.groups.map((g) => g.group)).toEqual(['UNLABELED', 'shop']);
    expect(lineOf(r, 'shop').amount).toBe('50.00');
  });

  it('refuses reserved or malformed label values, and a bad label key', () => {
    const w = (v: string) => req({ groupBy: { kind: 'label', key: 'app' }, workloads: [wl('w', 'n', 1, 1, 1, 1, { labels: { app: v } })] });
    expect(codeOf(() => apportionKubernetesCost(w('IDLE')))).toBe('INVALID_K8S_REQUEST');
    expect(codeOf(() => apportionKubernetesCost(w('bad value')))).toBe('INVALID_K8S_REQUEST');
    expect(codeOf(() => apportionKubernetesCost(req({ groupBy: { kind: 'label', key: 'a b' } })))).toBe('INVALID_K8S_REQUEST');
  });

  it('a label named __proto__ is inert', () => {
    const labels = JSON.parse('{"__proto__":"x","app":"shop"}') as Record<string, string>;
    const r = apportionKubernetesCost(req({ groupBy: { kind: 'label', key: 'app' }, workloads: [wl('w', 'n', 1000, 0, 4000, 0, { labels })] }));
    expect(r.groups[0].group).toBe('shop');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('shared cluster costs', () => {
  const shared = (amount: string, category: 'controlPlane' | 'loadBalancer' | 'other' = 'controlPlane', id = 's1') => ({ id, currency: 'USD', category, amount });

  it('even policy splits over groups with exact remainder', () => {
    const r = apportionKubernetesCost(
      req({ sharedCosts: [shared('10.00')], workloads: [wl('a', 'a', 1, 1, 1, 1), wl('b', 'b', 1, 1, 1, 1), wl('c', 'c', 1, 1, 1, 1)] }),
    );
    expect(r.sharedLines.map((l) => [l.group, l.amount])).toEqual([['a', '3.34'], ['b', '3.33'], ['c', '3.33']]);
    expect(r.sharedCostMinor).toBe(BigInt(1000));
  });

  it('proportional policy follows each group node cost', () => {
    const r = apportionKubernetesCost(req({ sharedCosts: [shared('10.00')], sharedPolicy: { kind: 'proportional' }, basis: 'usage' }));
    expect(r.sharedLines.map((l) => [l.group, l.amount])).toEqual([['team-a', '2.50'], ['team-b', '7.50']]);
    expect(r.groups.find((g) => g.group === 'team-b')).toMatchObject({ nodeMinor: BigInt(3750), sharedMinor: BigInt(750), totalMinor: BigInt(4500) });
  });

  it('fixed percent policy needs 100 exactly and existing groups', () => {
    const ok = apportionKubernetesCost(req({ sharedCosts: [shared('10.00')], sharedPolicy: { kind: 'fixedPercent', shares: [{ group: 'team-a', percent: '33.3333' }, { group: 'team-b', percent: '66.6667' }] } }));
    expect(ok.sharedLines.map((l) => l.amount)).toEqual(['3.33', '6.67']);
    expect(codeOf(() => apportionKubernetesCost(req({ sharedPolicy: { kind: 'fixedPercent', shares: [{ group: 'team-a', percent: '50' }, { group: 'team-b', percent: '49.9999' }] } })))).toBe('PERCENT_SUM_INVALID');
    expect(codeOf(() => apportionKubernetesCost(req({ sharedCosts: [shared('1.00')], sharedPolicy: { kind: 'fixedPercent', shares: [{ group: 'nope', percent: '100' }] } })))).toBe('UNKNOWN_GROUP');
    expect(codeOf(() => apportionKubernetesCost(req({ sharedPolicy: { kind: 'fixedPercent', shares: [{ group: 'a', percent: '50' }, { group: 'a', percent: '50' }] } })))).toBe('DUPLICATE_KEY');
  });

  it('usage weight policy and per-category override', () => {
    const r = apportionKubernetesCost(
      req({
        sharedCosts: [shared('10.00', 'controlPlane', 's1'), shared('9.00', 'loadBalancer', 's2'), shared('1.00', 'controlPlane', 's3')],
        sharedPolicy: { kind: 'even' },
        sharedPolicyByCategory: { loadBalancer: { kind: 'usageWeight', weights: [{ group: 'team-a', weight: '1' }, { group: 'team-b', weight: '2' }] } },
      }),
    );
    const lb = r.sharedLines.filter((l) => l.category === 'loadBalancer').map((l) => [l.group, l.amount]);
    expect(lb).toEqual([['team-a', '3.00'], ['team-b', '6.00']]);
    expect(r.sharedLines.filter((l) => l.category === 'controlPlane').map((l) => l.amount)).toEqual(['5.50', '5.50']);
    expect(r.sharedCostMinor).toBe(BigInt(2000));
  });

  it('shared cost with nothing to follow becomes an explicit unapportioned line', () => {
    const r = apportionKubernetesCost(req({ sharedCosts: [shared('8.00')], workloads: [] }));
    expect(r.sharedLines).toEqual([expect.objectContaining({ kind: 'unapportioned', group: null, amount: '8.00' })]);
    expect(r.unapportionedMinor).toBe(BigInt(800));
    expect(r.reconciliation.sharedAllocatedMinor).toBe(BigInt(800));
    const prop = apportionKubernetesCost(req({ sharedCosts: [shared('8.00')], sharedPolicy: { kind: 'proportional' }, basis: 'request', workloads: [wl('a', 'a', 1, 0, 1, 0)] }));
    expect(prop.unapportionedMinor).toBe(BigInt(0)); // group a holds all workload cost
    const zero = apportionKubernetesCost(req({ sharedCosts: [shared('8.00')], sharedPolicy: { kind: 'proportional' }, basis: 'usage', workloads: [wl('a', 'a', 1, 0, 1, 0)] }));
    expect(zero.unapportionedMinor).toBe(BigInt(800)); // group a has no usage, so no weight to follow
  });

  it('a zero shared total creates no lines', () => {
    expect(apportionKubernetesCost(req({ sharedCosts: [shared('0.00')] })).sharedLines).toEqual([]);
  });
});

describe('defined refusals', () => {
  it('refuses zero and negative node totals and negative lines', () => {
    const n = (amount: string) => [{ id: 'n', currency: 'USD', amount, cpuCapacityMillicores: 1000, memoryCapacityMiB: 1000 }];
    expect(codeOf(() => apportionKubernetesCost(req({ nodes: n('0.00') })))).toBe('NON_POSITIVE_TOTAL');
    expect(codeOf(() => apportionKubernetesCost(req({ nodes: n('-5.00') })))).toBe('NEGATIVE_AMOUNT');
    expect(codeOf(() => apportionKubernetesCost(req({ nodes: [] })))).toBe('NON_POSITIVE_TOTAL');
    expect(codeOf(() => apportionKubernetesCost(req({ sharedCosts: [{ id: 's', currency: 'USD', category: 'other', amount: '-1.00' }] })))).toBe('NEGATIVE_AMOUNT');
  });

  it('refuses zero capacity and reserved above capacity', () => {
    expect(codeOf(() => apportionKubernetesCost(req({ nodes: [{ id: 'n', currency: 'USD', amount: '1.00', cpuCapacityMillicores: 0, memoryCapacityMiB: 1000 }] })))).toBe('ZERO_CAPACITY');
    expect(codeOf(() => apportionKubernetesCost(req({ nodes: [{ id: 'n', currency: 'USD', amount: '1.00', cpuCapacityMillicores: 1000, memoryCapacityMiB: 0 }] })))).toBe('ZERO_CAPACITY');
    expect(codeOf(() => apportionKubernetesCost(req({ nodes: [{ id: 'n', currency: 'USD', amount: '1.00', cpuCapacityMillicores: 1000, memoryCapacityMiB: 1000, cpuReservedMillicores: 1001 }] })))).toBe('CAPACITY_EXCEEDED');
  });

  it('refuses mixed currencies and unknown currency', () => {
    expect(codeOf(() => apportionKubernetesCost(req({ nodes: [{ id: 'n', currency: 'EUR', amount: '1.00', cpuCapacityMillicores: 1, memoryCapacityMiB: 1 }] })))).toBe('MIXED_CURRENCY');
    expect(codeOf(() => apportionKubernetesCost(req({ sharedCosts: [{ id: 's', currency: 'JPY', category: 'other', amount: '1' }] })))).toBe('MIXED_CURRENCY');
    expect(codeOf(() => apportionKubernetesCost(req({ currency: 'ZZZ' })))).toBe('UNKNOWN_CURRENCY');
  });

  it('refuses mixed or suffixed units', () => {
    expect(codeOf(() => apportionKubernetesCost(req({ units: { cpu: 'cores', memory: 'MiB' } as never })))).toBe('MIXED_UNITS');
    expect(codeOf(() => apportionKubernetesCost(req({ units: { cpu: 'millicores', memory: 'GiB' } as never })))).toBe('MIXED_UNITS');
    expect(codeOf(() => apportionKubernetesCost(req({ workloads: [wl('w', 'a', 1, 1, 1, 1, { units: { cpu: 'cores', memory: 'MiB' } })] })))).toBe('MIXED_UNITS');
    expect(codeOf(() => apportionKubernetesCost(req({ workloads: [wl('w', 'a', '500m' as never, 1, 1, 1)] })))).toBe('MIXED_UNITS');
    expect(codeOf(() => apportionKubernetesCost(req({ workloads: [wl('w', 'a', 1, 1, '2Gi' as never, 1)] })))).toBe('MIXED_UNITS');
    expect(codeOf(() => apportionKubernetesCost(req({ workloads: [wl('w', 'a', 1.5, 1, 1, 1)] })))).toBe('INVALID_K8S_REQUEST');
    expect(codeOf(() => apportionKubernetesCost(req({ workloads: [wl('w', 'a', -1, 1, 1, 1)] })))).toBe('INVALID_K8S_REQUEST');
  });

  it('refuses malformed requests', () => {
    const run = (o: Record<string, unknown>) => codeOf(() => apportionKubernetesCost({ ...req(), ...o } as K8sRequest));
    expect(codeOf(() => apportionKubernetesCost(null as never))).toBe('INVALID_K8S_REQUEST');
    expect(run({ basis: 'peak' })).toBe('INVALID_K8S_REQUEST');
    expect(run({ tenant: '' })).toBe('INVALID_TENANT');
    expect(run({ workloads: [wl('w', 'Bad_NS', 1, 1, 1, 1)] })).toBe('INVALID_K8S_REQUEST');
    expect(run({ workloads: [wl('w', 'a', 1, 1, 1, 1), wl('w', 'b', 1, 1, 1, 1)] })).toBe('INVALID_K8S_REQUEST');
    expect(run({ sharedPolicy: { kind: 'bogus' } })).toBe('INVALID_K8S_REQUEST');
    expect(run({ nodes: [{ id: 'n', currency: 'USD', amount: '1e2', cpuCapacityMillicores: 1, memoryCapacityMiB: 1 }] })).toBe('INVALID_DECIMAL');
    expect(run({ nodes: [{ id: 'n', currency: 'USD', amount: '1.005', cpuCapacityMillicores: 1, memoryCapacityMiB: 1 }] })).toBe('PRECISION_EXCEEDED');
  });

  it('caps nodes, workloads and shared costs: at the cap works, one past is refused', () => {
    const nodes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, currency: 'USD', amount: '0.01', cpuCapacityMillicores: 1, memoryCapacityMiB: 1 }));
    expect(codeOf(() => apportionKubernetesCost(req({ nodes: nodes(LIMITS.maxK8sNodes) })))).toBeUndefined();
    expect(codeOf(() => apportionKubernetesCost(req({ nodes: nodes(LIMITS.maxK8sNodes + 1) })))).toBe('TOO_MANY_ITEMS');
    const shared = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, currency: 'USD', category: 'other' as const, amount: '0.01' }));
    expect(codeOf(() => apportionKubernetesCost(req({ sharedCosts: shared(LIMITS.maxK8sSharedCosts) })))).toBeUndefined();
    expect(codeOf(() => apportionKubernetesCost(req({ sharedCosts: shared(LIMITS.maxK8sSharedCosts + 1) })))).toBe('TOO_MANY_ITEMS');
    const wls = (n: number) => Array.from({ length: n }, (_, i) => wl(`w${i}`, 'a', 1, 1, 1, 1));
    expect(codeOf(() => apportionKubernetesCost(req({ workloads: wls(LIMITS.maxK8sWorkloads) })))).toBeUndefined();
    expect(codeOf(() => apportionKubernetesCost(req({ workloads: wls(LIMITS.maxK8sWorkloads + 1) })))).toBe('TOO_MANY_ITEMS');
  });
});

describe('currency exponents', () => {
  it('apportions JPY in whole yen and KWD in fils, reconciling exactly', () => {
    const jpy = apportionKubernetesCost(
      req({ currency: 'JPY', nodes: [{ id: 'n', currency: 'JPY', amount: '1001', cpuCapacityMillicores: 3000, memoryCapacityMiB: 3000 }], workloads: [wl('a', 'a', 1000, 0, 1000, 0), wl('b', 'b', 1000, 0, 1000, 0), wl('c', 'c', 1000, 0, 1000, 0)] }),
    );
    expect(jpy.nodeLines.map((l) => l.amount).every((a) => /^\d+$/.test(a))).toBe(true);
    expect(jpy.reconciliation.nodeAllocatedMinor).toBe(BigInt(1001));
    const kwd = apportionKubernetesCost(
      req({ currency: 'KWD', nodes: [{ id: 'n', currency: 'KWD', amount: '1.001', cpuCapacityMillicores: 3000, memoryCapacityMiB: 3000 }], workloads: [wl('a', 'a', 1000, 0, 1000, 0), wl('b', 'b', 1000, 0, 1000, 0), wl('c', 'c', 1000, 0, 1000, 0)] }),
    );
    expect(kwd.nodeLines.map((l) => l.amount).every((a) => /^\d\.\d{3}$/.test(a))).toBe(true);
    expect(kwd.reconciliation.nodeAllocatedMinor).toBe(BigInt(1001));
  });
});

describe('reconciliation properties (seeded)', () => {
  it('node and shared cost reconcile exactly across 300 random clusters', () => {
    const rnd = mulberry32(31337);
    const cur = ['USD', 'JPY', 'KWD'];
    const exp: Record<string, number> = { USD: 2, JPY: 0, KWD: 3 };
    const dec = (c: string, minor: number): string => (exp[c] === 0 ? String(minor) : `${Math.floor(minor / 10 ** exp[c])}.${String(minor % 10 ** exp[c]).padStart(exp[c], '0')}`);
    for (let s = 0; s < 300; s++) {
      const currency = cur[Math.floor(rnd() * 3)];
      const nodes = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, i) => ({
        id: `n${i}`,
        currency,
        amount: dec(currency, 1 + Math.floor(rnd() * 500000)),
        cpuCapacityMillicores: 1000 + Math.floor(rnd() * 64000),
        memoryCapacityMiB: 1000 + Math.floor(rnd() * 256000),
        cpuReservedMillicores: Math.floor(rnd() * 500),
        memoryReservedMiB: Math.floor(rnd() * 500),
      }));
      const nsList = ['a', 'b', 'c', 'kube-system', 'd'];
      const workloads = Array.from({ length: Math.floor(rnd() * 25) }, (_, i) =>
        wl(`w${i}`, nsList[Math.floor(rnd() * nsList.length)], Math.floor(rnd() * 3000), Math.floor(rnd() * 3000), Math.floor(rnd() * 9000), Math.floor(rnd() * 9000)),
      );
      const cpuW = Math.floor(rnd() * 101);
      const result = apportionKubernetesCost({
        tenant: 't',
        clusterId: 'c',
        currency,
        units: { cpu: 'millicores', memory: 'MiB' },
        nodes,
        sharedCosts: [{ id: 'cp', currency, category: 'controlPlane', amount: dec(currency, Math.floor(rnd() * 100000)) }, { id: 'lb', currency, category: 'loadBalancer', amount: dec(currency, Math.floor(rnd() * 100000)) }],
        workloads,
        basis: (['request', 'usage', 'max'] as const)[Math.floor(rnd() * 3)],
        resourceWeights: { cpu: String(cpuW), memory: String(100 - cpuW) },
        systemNamespaces: ['kube-system'],
        sharedPolicy: rnd() < 0.5 ? { kind: 'even' } : { kind: 'proportional' },
      });
      const nodeSum = nodes.reduce((a, n) => a + BigInt(n.amount.replace('.', '')), BigInt(0));
      expect(result.nodeCostMinor).toBe(nodeSum);
      expect(result.nodeLines.reduce((a, l) => a + l.minor, BigInt(0))).toBe(nodeSum);
      expect(result.nodeLines.every((l) => l.minor >= BigInt(0) && l.cpuMinor + l.memoryMinor === l.minor)).toBe(true);
      expect(result.sharedLines.reduce((a, l) => a + l.minor, BigInt(0))).toBe(result.sharedCostMinor);
      const groupSum = result.groups.reduce((a, g) => a + g.totalMinor, BigInt(0));
      expect(groupSum + result.idleMinor + result.systemOverheadMinor + result.unapportionedMinor).toBe(result.nodeCostMinor + result.sharedCostMinor);
    }
  });

  it('is deterministic', () => {
    const a = apportionKubernetesCost(req({ sharedCosts: [{ id: 's', currency: 'USD', category: 'other', amount: '10.01' }] }));
    const b = apportionKubernetesCost(req({ sharedCosts: [{ id: 's', currency: 'USD', category: 'other', amount: '10.01' }] }));
    expect(JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    expect(K8S_IDLE).toBe('IDLE');
    expect(K8S_SYSTEM_OVERHEAD).toBe('SYSTEM_OVERHEAD');
  });
});

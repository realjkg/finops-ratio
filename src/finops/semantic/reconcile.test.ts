import { describe, expect, it } from 'vitest';
import { RECONCILE_CODES as C, reconcileAllocation, reconcileSourceTotals, type ReconciliationResult } from './reconcile';
import { BU_A_SCOPE, CONFIG_SHA, TENANT_SCOPE, allocationInput, sampleFacts, syntheticSlices } from './fixtures/syntheticAllocation';
import { BATCH, SRC, SRC_B, g } from '../../reports/fixtures/sampleFacts';
// Test-only: the real M0c policy and M0b bridge (worker-only tree; tests are not bundled).
import { evaluateSourcePolicy, type DedupPolicy, type PolicySource } from '../../connectors/managed/policy/overlap';
import { buildBridge } from '../../connectors/managed/evidence/bridge';

const BILLED = '18.00663861840';
const EFFECTIVE = '13.00000000000';
const pick = (rs: ReconciliationResult[], currency: string | null, basis: string | null) => {
  const r = rs.find((x) => x.key.currency === currency && x.key.basis === basis);
  if (!r) throw new Error(`no result for ${currency} ${basis}`);
  return r;
};
const codes = (r: ReconciliationResult) => r.reasons.map((x) => x.code);
const na = (r: { status: string }) => expect(r.status).toBe('not_available');

describe('I1 allocation conservation (SYNTHETIC split of the public FOCUS 1.0 sample, AWS 2024-09)', () => {
  it('input fixture: the sample facts carry billed 18.00663861840, effective 13.00000000000, 942 rows', () => {
    const t = sampleFacts().totals;
    expect(t.status === 'available' && t.value.map((c) => [c.currency, c.billedCost, c.effectiveCost, c.rowCount])).toEqual([['USD', BILLED, { status: 'available', value: EFFECTIVE }, '942']]);
  });

  it('7.0 + 4.5 + 3.2 + unallocated 3.30663861840 = billed, and 6.0 + 4.0 + 2.5 + 0.5 = effective: reconciled, residual exactly 0', () => {
    const rs = reconcileAllocation(allocationInput());
    expect(rs).toHaveLength(2);
    const b = pick(rs, 'USD', 'billed');
    expect(b).toMatchObject({ id: 'I1', status: 'reconciled', key: { period: '2024-09', currency: 'USD', basis: 'billed', scope: 'tenant' } });
    expect(b.left.amount).toEqual({ status: 'available', value: BILLED });
    expect(b.right.amount).toEqual({ status: 'available', value: BILLED });
    expect(b.residual).toEqual({ status: 'available', value: '0.00000000000' });
    expect(b.bridge).toEqual([
      { line: 'business_unit:BU-A', amount: '7.00000000000' },
      { line: 'business_unit:BU-B', amount: '4.50000000000' },
      { line: 'business_unit:BU-C', amount: '3.20000000000' },
      { line: 'unallocated', amount: '3.30663861840' },
    ]);
    expect(b.inputs).toEqual({ batchIds: [BATCH], configSha256: CONFIG_SHA, asOf: '2026-10-31T12:00:00.000Z' });
    const e = pick(rs, 'USD', 'effective');
    expect(e.status).toBe('reconciled');
    expect(e.left.amount).toEqual({ status: 'available', value: EFFECTIVE });
    expect(e.residual).toEqual({ status: 'available', value: '0.00000000000' });
    expect(e.bridge.at(-1)).toEqual({ line: 'unallocated', amount: '0.50000000000' });
    // Cross-check: the same lines close the M0b bridge exactly.
    const br = buildBridge({ key: { scope: 'tenant', period: '2024-09', costBasis: 'billed' }, source: [{ measure: 'allocatedBilled', currency: 'USD', amount: b.left.amount.status === 'available' ? b.left.amount.value : 'x' }], normalized: [{ measure: 'allocatedBilled', currency: 'USD', amount: BILLED }], deltas: [] });
    expect(br.closed).toBe(true);
  });

  it('a 0.00000000001 perturbation gives unreconciled with residual exactly -0.00000000001 (right - left, no rounding)', () => {
    const slices = syntheticSlices();
    slices[0].lines[1].amount = '4.50000000001';
    const rs = reconcileAllocation(allocationInput({ allocation: { configSha256: CONFIG_SHA, slices } }));
    const b = pick(rs, 'USD', 'billed');
    expect(b.status).toBe('unreconciled');
    expect(b.residual).toEqual({ status: 'available', value: '-0.00000000001' });
    expect(b.left.amount).toEqual({ status: 'available', value: '18.00663861841' });
    expect(codes(b)).toEqual([C.unexplainedResidual]);
    expect(pick(rs, 'USD', 'effective').status).toBe('reconciled');
  });

  it('a named delta closes the bridge; a delta without a reason or matching nothing is rejected', () => {
    const slices = syntheticSlices();
    slices[0].lines[1].amount = '4.50000000001';
    const alloc = { configSha256: CONFIG_SHA, slices };
    const rs = reconcileAllocation(allocationInput({ allocation: alloc, deltas: [{ currency: 'USD', basis: 'billed', amount: '-0.00000000001', reason: 'RESTATEMENT' }] }));
    const b = pick(rs, 'USD', 'billed');
    expect(b.status).toBe('reconciled');
    expect(b.bridge.at(-1)).toEqual({ line: 'delta:RESTATEMENT', amount: '-0.00000000001' });
    expect(() => reconcileAllocation(allocationInput({ allocation: alloc, deltas: [{ currency: 'USD', basis: 'billed', amount: '-0.00000000001', reason: '' }] }))).toThrow('reconcile: a delta needs a named reason');
    expect(() => reconcileAllocation(allocationInput({ deltas: [{ currency: 'EUR', basis: 'billed', amount: '1', reason: 'RESTATEMENT' }] }))).toThrow('reconcile: a delta matches no published currency and basis');
  });

  it('missing allocation is not_reconcilable with a reason, never 0', () => {
    const rs = reconcileAllocation(allocationInput({ allocation: null }));
    expect(rs).toHaveLength(2);
    for (const r of rs) {
      expect(r.status).toBe('not_reconcilable');
      expect(codes(r)).toEqual([C.allocationMissing]);
      na(r.left.amount);
      na(r.residual);
      expect(r.right.amount.status).toBe('available');
      expect(JSON.stringify(r)).not.toMatch(/"0(\.0+)?"/);
    }
    expect(rs[0].reasons[0].detail).toMatch(/R6/);
    const noEff = reconcileAllocation(allocationInput({ allocation: { configSha256: CONFIG_SHA, slices: syntheticSlices().slice(0, 1) } }));
    expect(pick(noEff, 'USD', 'billed').status).toBe('reconciled');
    expect(codes(pick(noEff, 'USD', 'effective'))).toEqual([C.allocationMissing]);
  });

  it('a missing unallocated line is not_reconcilable (never treated as 0)', () => {
    const slices = syntheticSlices();
    slices[0].unallocated = null;
    const b = pick(reconcileAllocation(allocationInput({ allocation: { configSha256: CONFIG_SHA, slices } })), 'USD', 'billed');
    expect(b.status).toBe('not_reconcilable');
    expect(codes(b)).toEqual([C.unallocatedMissing]);
    na(b.left.amount);
    na(b.residual);
  });

  it('effective partial is not_reconcilable and the effective side is never filled from billed', () => {
    const facts = sampleFacts({ groups: [g({ effectiveMissingRows: '3' })] });
    const rs = reconcileAllocation(allocationInput({ published: facts }));
    const e = pick(rs, 'USD', 'effective');
    expect(e.status).toBe('not_reconcilable');
    expect(codes(e)).toEqual([C.effectivePartial]);
    na(e.right.amount);
    expect(JSON.stringify(e)).not.toContain(BILLED);
    expect(pick(rs, 'USD', 'billed').status).toBe('reconciled');
  });

  it('two currencies reconcile independently and are never summed', () => {
    const facts = sampleFacts({ groups: [g({}), g({ currency: 'EUR', rowCount: '10', billedCost: '5.00', effectiveCost: '4.00' })] });
    const slices = [...syntheticSlices(), { currency: 'EUR', basis: 'billed' as const, lines: [{ businessUnit: 'BU-A', amount: '2.00' }], unallocated: '3.01' }, { currency: 'GBP', basis: 'billed' as const, lines: [], unallocated: '1.00' }];
    const rs = reconcileAllocation(allocationInput({ published: facts, allocation: { configSha256: CONFIG_SHA, slices } }));
    expect(pick(rs, 'USD', 'billed').status).toBe('reconciled');
    const eur = pick(rs, 'EUR', 'billed');
    expect(eur.status).toBe('unreconciled');
    expect(eur.residual).toEqual({ status: 'available', value: '-0.01' });
    expect(codes(pick(rs, 'EUR', 'effective'))).toEqual([C.allocationMissing]);
    expect(codes(pick(rs, 'GBP', 'billed'))).toEqual([C.currencyNotPublished]);
    na(pick(rs, 'GBP', 'billed').right.amount);
    expect(JSON.stringify(rs)).not.toMatch(/23\.0066386184|23\.01/);
  });

  it('no business-unit dimension: every amount is unallocated and the reason is named', () => {
    const slices = [{ currency: 'USD', basis: 'billed' as const, lines: [], unallocated: BILLED }];
    const b = pick(reconcileAllocation(allocationInput({ allocation: { configSha256: CONFIG_SHA, slices } })), 'USD', 'billed');
    expect(b.status).toBe('reconciled');
    expect(codes(b)).toEqual([C.noBusinessUnitDimension]);
  });

  it('empty period is not_applicable with a reason; multi-source is not_reconcilable; BU scope sees no tenant totals', () => {
    const [empty] = reconcileAllocation(allocationInput({ published: sampleFacts({ groups: [], batches: [], artifacts: [] }) }));
    expect(empty).toMatchObject({ status: 'not_applicable', key: { currency: null, basis: null } });
    expect(codes(empty)).toEqual([C.noPublishedFacts]);
    na(empty.residual);
    const [multi] = reconcileAllocation(allocationInput({ published: sampleFacts({ groups: [g({}), g({ sourceId: SRC_B })] }) }));
    expect(multi.status).toBe('not_reconcilable');
    expect(codes(multi)).toEqual([C.multiSourceNotCombined]);
    const bu = reconcileAllocation(allocationInput({ scope: BU_A_SCOPE }));
    expect(bu).toHaveLength(1);
    expect(bu[0]).toMatchObject({ status: 'not_applicable', key: { scope: 'business_unit', currency: null } });
    expect(codes(bu[0])).toEqual([C.tenantScopeOnly]);
    expect(JSON.stringify(bu)).not.toMatch(/18\.0066|13\.0000|BU-B|BU-C/);
  });

  it('refuses malformed amounts and duplicate slices with fixed messages that do not echo input', () => {
    const slices = syntheticSlices();
    slices[0].lines[0].amount = '7.0e0 ZZ_PROBE';
    expect(() => reconcileAllocation(allocationInput({ allocation: { configSha256: CONFIG_SHA, slices } }))).toThrow(/^amount is not a plain decimal string$/);
    expect(() => reconcileAllocation(allocationInput({ allocation: { configSha256: CONFIG_SHA, slices: [...syntheticSlices(), syntheticSlices()[0]] } }))).toThrow('reconcile: an allocation slice is listed twice');
  });
});

describe('I2 source to headline via the M0c policy (evaluateSourcePolicy)', () => {
  const ps = (id: string, o: Partial<PolicySource> = {}): PolicySource => ({ id, role: 'authoritative', costBasis: 'focus-native', providers: ['AWS'], accounts: ['000000000001'], period: { start: '2024-09-01T00:00:00Z', end: '2024-10-01T00:00:00Z' }, alsoPresentInOtherSource: 'no', relatedSource: 'none', ...o });
  const two = () => sampleFacts({ groups: [g({}), g({ sourceId: SRC_B, rowCount: '5', billedCost: '1.00000000000', effectiveCost: '0.90000000000' })] });
  const keys2 = { [SRC]: 'aws-a', [SRC_B]: 'aws-b' };
  const prefer = (p: string): DedupPolicy[] => [{ kind: 'prefer', sources: ['aws-a', 'aws-b'], prefer: p }];

  it('without source keys (reader cannot see them until R4): not_reconcilable NEEDS_R4_TRUST_VIEWS', () => {
    const rs = reconcileSourceTotals({ scope: TENANT_SCOPE, published: sampleFacts(), policy: evaluateSourcePolicy([ps('aws-focus-sample')]), sourceKeys: null });
    expect(rs).toHaveLength(2);
    for (const r of rs) {
      expect(r).toMatchObject({ id: 'I2', status: 'not_reconcilable' });
      expect(codes(r)).toEqual([C.needsR4TrustViews]);
      na(r.left.amount);
      na(r.residual);
    }
  });

  it('a single eligible source reconciles to the headline on both bases', () => {
    const rs = reconcileSourceTotals({ scope: TENANT_SCOPE, published: sampleFacts(), policy: evaluateSourcePolicy([ps('aws-focus-sample')]), sourceKeys: { [SRC]: 'aws-focus-sample' } });
    expect(pick(rs, 'USD', 'billed')).toMatchObject({ status: 'reconciled', residual: { status: 'available', value: '0.00000000000' }, bridge: [{ line: 'source:aws-focus-sample', amount: BILLED }] });
    expect(pick(rs, 'USD', 'effective')).toMatchObject({ status: 'reconciled', left: { amount: { status: 'available', value: EFFECTIVE } } });
  });

  it('a source M0c excludes cannot back a headline: not_reconcilable with the exclusion reason', () => {
    const rs = reconcileSourceTotals({ scope: TENANT_SCOPE, published: sampleFacts(), policy: evaluateSourcePolicy([ps('aws-focus-sample', { role: 'unknown' })]), sourceKeys: { [SRC]: 'aws-focus-sample' } });
    const b = pick(rs, 'USD', 'billed');
    expect(b.status).toBe('not_reconcilable');
    expect(codes(b)).toEqual([C.noEligibleSource, C.sourceExcluded]);
    expect(b.reasons[1].detail).toMatch(/aws-focus-sample/);
  });

  it('overlapping sources without a dedup policy: OVERLAP_UNRESOLVED (never combined)', () => {
    const rs = reconcileSourceTotals({ scope: TENANT_SCOPE, published: two(), policy: evaluateSourcePolicy([ps('aws-a'), ps('aws-b')]), sourceKeys: keys2 });
    for (const r of rs) {
      expect(r.status).toBe('not_reconcilable');
      expect(codes(r)).toContain('OVERLAP_UNRESOLVED');
      na(r.left.amount);
    }
    expect(JSON.stringify(rs)).not.toContain('19.00663861840');
  });

  it('superseded source (prefer policy): headline of the winner reconciles; a double-counted headline is unreconciled by exactly the loser', () => {
    const policy = evaluateSourcePolicy([ps('aws-a'), ps('aws-b')], prefer('aws-b'));
    expect(policy.ok).toBe(true);
    const ok = reconcileSourceTotals({ scope: TENANT_SCOPE, published: two(), policy, sourceKeys: keys2, headline: [{ currency: 'USD', basis: 'billed', amount: '1.00000000000' }, { currency: 'USD', basis: 'effective', amount: '0.90000000000' }] });
    const b = pick(ok, 'USD', 'billed');
    expect(b.status).toBe('reconciled');
    expect(b.bridge).toEqual([{ line: 'source:aws-b', amount: '1.00000000000' }]);
    expect(codes(b)).toEqual([C.sourceExcluded]);
    const dbl = reconcileSourceTotals({ scope: TENANT_SCOPE, published: two(), policy, sourceKeys: keys2, headline: [{ currency: 'USD', basis: 'billed', amount: '19.00663861840' }] });
    expect(pick(dbl, 'USD', 'billed')).toMatchObject({ status: 'unreconciled', residual: { status: 'available', value: BILLED } });
    // No headline supplied: the reader does not combine two sources, so the right side is N/A.
    const none = pick(reconcileSourceTotals({ scope: TENANT_SCOPE, published: two(), policy, sourceKeys: keys2 }), 'USD', 'billed');
    expect(none.status).toBe('not_reconcilable');
    expect(codes(none)).toContain(C.multiSourceNotCombined);
    na(none.right.amount);
    expect(none.left.amount).toEqual({ status: 'available', value: '1.00000000000' });
  });

  it('M0c warnings travel with the result; an eligible source with no published facts is not_reconcilable', () => {
    const policy = evaluateSourcePolicy([ps('aws-a', { accounts: 'unknown' }), ps('aws-b')], prefer('aws-b'));
    expect(policy.warnings.map((w) => w.code)).toEqual(['PREFER_MAY_UNDERCOUNT']);
    const b = pick(reconcileSourceTotals({ scope: TENANT_SCOPE, published: two(), policy, sourceKeys: keys2, headline: [{ currency: 'USD', basis: 'billed', amount: '1.00000000000' }] }), 'USD', 'billed');
    expect(b.status).toBe('reconciled');
    expect(codes(b)).toContain('PREFER_MAY_UNDERCOUNT');
    const missing = pick(reconcileSourceTotals({ scope: TENANT_SCOPE, published: sampleFacts(), policy: evaluateSourcePolicy([ps('aws-a')]), sourceKeys: { [SRC]: 'other' } }), 'USD', 'billed');
    expect(missing.status).toBe('not_reconcilable');
    expect(codes(missing)).toContain(C.sourceNotPublished);
  });

  it('per currency, never across currencies; BU scope is not_applicable', () => {
    const facts = sampleFacts({ groups: [g({}), g({ currency: 'EUR', rowCount: '10', billedCost: '5.00', effectiveCost: '4.00' })] });
    const rs = reconcileSourceTotals({ scope: TENANT_SCOPE, published: facts, policy: evaluateSourcePolicy([ps('aws-focus-sample')]), sourceKeys: { [SRC]: 'aws-focus-sample' } });
    expect(rs.map((r) => `${r.key.currency}/${r.key.basis}/${r.status}`)).toEqual(['EUR/billed/reconciled', 'EUR/effective/reconciled', 'USD/billed/reconciled', 'USD/effective/reconciled']);
    expect(JSON.stringify(rs)).not.toContain('23.00663861840');
    const bu = reconcileSourceTotals({ scope: BU_A_SCOPE, published: facts, policy: evaluateSourcePolicy([ps('aws-focus-sample')]), sourceKeys: { [SRC]: 'aws-focus-sample' } });
    expect(bu.map((r) => [r.status, codes(r)])).toEqual([['not_applicable', [C.tenantScopeOnly]]]);
  });
});

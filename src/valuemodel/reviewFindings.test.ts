// Regression tests for the independent review of the value model: each fails without its fix.
import { describe, expect, it } from 'vitest';
import { evaluateKpi, EvaluationError, KpiResultLedger, ResultLedgerError, type Observation } from './evaluate';
import { approver, costPerInvoiceKpi, expectedCase, finance, invoiceKpi, sponsor, TENANT } from './fixtures/syntheticValueModel';
import { KpiDefinitionRegistry } from './lifecycle';
import { ValueCaseError, ValueCaseRegistry, type ValueCaseTerm, type ValueCaseVersion } from './valueCase';

const AT = '2026-11-16T12:00:00Z';
const obs = (key: string, quantity: string, unit: string, extra: Partial<Observation> = {}): Observation => ({
  key, quantity, unit, sourceKind: 'connector', basis: 'observed', periodStart: '2026-10-01', periodEnd: '2026-10-31', scopeRef: 'bu-a', sourceRefs: ['batch-1'], verificationRef: 'verify-1', ...extra,
});

function published(def = invoiceKpi()) {
  const reg = new KpiDefinitionRegistry(TENANT);
  reg.createDraft(def, sponsor, AT);
  reg.validate('invoice-review-time', 1, sponsor, AT);
  reg.approve('invoice-review-time', 1, approver, 'kpi_approver', reg.get('invoice-review-time', 1).digest, AT);
  reg.publish('invoice-review-time', 1, approver, AT);
  return reg;
}
const run = (reg: KpiDefinitionRegistry, observations: Observation[], resultId = 'r1') => evaluateKpi({
  record: reg.published('invoice-review-time')!, observations, periodStart: '2026-10-01', periodEnd: '2026-10-31', scopeRef: 'bu-a', resultId, calculatedAt: AT, calculatedBy: 'svc',
});
const verified = () => [obs('acceptedInvoices', '40', 'invoice'), obs('reviewTime', '2', 'hour')];

describe('finance approval follows the definition', () => {
  it('an edit that adds money to a draft also requires the finance approval', () => {
    const reg = new KpiDefinitionRegistry(TENANT);
    expect(reg.createDraft(invoiceKpi(), sponsor, AT).requiresFinanceApproval).toBe(false);
    const edited = reg.editDraft({ ...costPerInvoiceKpi(), definitionId: 'invoice-review-time' }, sponsor, AT);
    expect(edited.requiresFinanceApproval).toBe(true);
    reg.validate('invoice-review-time', 1, sponsor, AT);
    const d = reg.get('invoice-review-time', 1).digest;
    expect(reg.approve('invoice-review-time', 1, approver, 'kpi_approver', d, AT).status).toBe('validated');
    expect(() => reg.publish('invoice-review-time', 1, approver, AT)).toThrow();
    expect(reg.approve('invoice-review-time', 1, finance, 'finance_approver', d, AT).status).toBe('approved');
  });
});

describe('evidence status is never typed in', () => {
  it('a kpi_result input counts as assumed until it is resolved against the result ledger, whatever status it claims', () => {
    const def = invoiceKpi();
    def.inputs = def.inputs.map((i) => (i.key === 'reviewTime' ? { ...i, sourceKinds: [...i.sourceKinds, 'kpi_result'] } : i));
    const reg = published(def);
    const claimed = obs('reviewTime', '2', 'hour', { sourceKind: 'kpi_result', kpiResult: { resultId: 'nonexistent', evidenceStatus: 'measured' } });
    const r = run(reg, [obs('acceptedInvoices', '40', 'invoice'), claimed]);
    expect(r.inputs.find((i) => i.key === 'reviewTime')!.evidenceStatus).toBe('assumed');
    expect(r.evidenceStatus).toBe('assumed');
  });

  it('a kpi_result term in a value case is assumed, whatever status it claims', () => {
    const reg = new ValueCaseRegistry(TENANT);
    const terms: ValueCaseTerm[] = expectedCase().terms.map((t) => ({ ...t, sourceKind: 'connector', basis: 'forecast', sourceRefs: ['m'] }));
    terms[0] = { ...terms[0], sourceKind: 'kpi_result', kpiResult: { resultId: 'nonexistent', evidenceStatus: 'measured' } };
    const cv: ValueCaseVersion = { ...expectedCase(), terms };
    const d = reg.saveDraft(cv, sponsor).digest;
    reg.approve(cv.caseId, 1, finance, d, AT);
    expect(reg.publish(cv.caseId, 1, finance, 's1', AT).evidenceStatus).toBe('assumed');
  });

  it('no value case snapshot is measured until a counterfactual method and independent verification exist', () => {
    for (const phase of ['expected', 'observed'] as const) {
      const reg = new ValueCaseRegistry(TENANT);
      const terms: ValueCaseTerm[] = expectedCase().terms.map((t) => ({ ...t, sourceKind: 'manual_observation', basis: 'observed', sourceRefs: ['ref'], verificationRef: 'verify-1' }));
      const cv: ValueCaseVersion = { ...expectedCase(), phase, terms };
      const d = reg.saveDraft(cv, sponsor).digest;
      reg.approve(cv.caseId, 1, finance, d, AT);
      expect(reg.publish(cv.caseId, 1, finance, 's1', AT).evidenceStatus, phase).toBe('projected');
    }
  });
});

describe('the original business case cannot be bypassed', () => {
  it('a revised forecast cannot be published before the original', () => {
    const reg = new ValueCaseRegistry(TENANT);
    reg.approve('case-service-automation', 1, finance, reg.saveDraft(expectedCase(), sponsor).digest, AT);
    const v2: ValueCaseVersion = { ...expectedCase(), version: 2, basedOnVersion: 1, rationale: 'Lower forecast.' };
    reg.approve('case-service-automation', 2, finance, reg.saveDraft(v2, sponsor).digest, AT);
    expect(() => reg.publish('case-service-automation', 2, finance, 's2', AT)).toThrow(ValueCaseError);
    expect(() => reg.publish('case-service-automation', 2, finance, 's2', AT)).toThrow(/original business case before a revised forecast/);
    reg.publish('case-service-automation', 1, finance, 's1', AT);
    expect(reg.publish('case-service-automation', 2, finance, 's2', AT).isOriginalBusinessCase).toBe(false);
    expect(reg.expectedVsObserved('case-service-automation', '2026-11-01', '2026-11-30').original?.snapshotId).toBe('s1');
  });
});

describe('the result ledger and evaluation check what they are given', () => {
  it('a second first result for the same KPI, period and scope is refused; a stated recalculation is the only way', () => {
    const reg = published();
    const ledger = new KpiResultLedger(TENANT);
    ledger.append(run(reg, verified(), 'r1'));
    expect(() => ledger.append(run(reg, [obs('acceptedInvoices', '48', 'invoice'), obs('reviewTime', '2', 'hour')], 'r2'))).toThrow(/already in force/);
    try { ledger.append(run(reg, verified(), 'r3')); } catch (e) { expect((e as ResultLedgerError).code).toBe('ALREADY_RECORDED'); }
  });

  it('a result changed after it was calculated is refused', () => {
    const reg = published();
    const tampered = { ...run(reg, verified()), quantity: '1.00' };
    expect(() => new KpiResultLedger(TENANT).append(tampered)).toThrow(/does not match its digest/);
  });

  it('a record whose definition no longer matches its digest is refused', () => {
    const reg = published();
    const rec = reg.published('invoice-review-time')!;
    const swapped = { ...rec, definition: { ...rec.definition, calculation: { ...rec.definition.calculation, expression: `(${rec.definition.calculation.expression}) * 2` } } };
    expect(() => evaluateKpi({ record: swapped, observations: verified(), periodStart: '2026-10-01', periodEnd: '2026-10-31', scopeRef: 'bu-a', resultId: 'x', calculatedAt: AT, calculatedBy: 'svc' }))
      .toThrow(EvaluationError);
  });
});

describe('Copilot review on #202', () => {
  it('a target is checked against the exact result, not the rounded one (3.004 misses a lower-is-better 3)', () => {
    const r = run(published(), [obs('acceptedInvoices', '40', 'invoice'), obs('reviewTime', '120.16', 'minute')]);
    expect(r.quantity).toBe('3.00');
    expect(r.target?.met).toBe(false);
    expect(run(published(), verified()).target?.met).toBe(true);
  });

  it('an issued result cannot be changed through nested data, by the caller or by a reader', () => {
    const ledger = new KpiResultLedger(TENANT);
    const mine = run(published(), verified());
    const issued = ledger.append(mine);
    const before = JSON.stringify(issued);
    expect(() => (issued.inputs[0].sourceRefs as string[]).push('x')).toThrow(TypeError);
    expect(() => { (issued.target as { met: boolean }).met = false; }).toThrow(TypeError);
    expect(() => (ledger.issued(mine.resultId).reasons as string[]).push('x')).toThrow(TypeError);
    expect(JSON.stringify(ledger.issued(mine.resultId))).toBe(before);
  });

  it('a ratio that overflows the supported precision is unavailable with a reason, never a thrown error', () => {
    const reg = new ValueCaseRegistry(TENANT);
    // Benefit and cost each fit the 120-digit limit; their ratio does not.
    const big: Record<string, string> = { baselineResolutions: '999999999999999999', costBefore: '999999999999999999', costAfter: '0', attribution: '100000000000000000', aiCost: '0.0000000001' };
    const terms = expectedCase().terms.map((t) => ({ ...t, quantity: big[t.key] }));
    const cv: ValueCaseVersion = { ...expectedCase(), terms, benefit: { ...expectedCase().benefit, expression: 'baselineResolutions * (costBefore - costAfter) * attribution * attribution * attribution * attribution * attribution' } };
    const d = reg.saveDraft(cv, sponsor).digest;
    reg.approve(cv.caseId, 1, finance, d, AT);
    const s = reg.publish(cv.caseId, 1, finance, 's1', AT);
    expect(s.value).not.toBeNull();
    expect(s.cost).toBe('0.00'); // 10^-10 USD, shown at 2 decimals
    expect(s.valueToCost).toBeNull();
    expect(s.roiPercent).toBeNull();
    expect(s.reasons.join(' ')).toMatch(/precision/);
  });

  it('variance against the original is computed from exact ratios, so rounding cannot hide a shortfall', () => {
    const reg = new ValueCaseRegistry(TENANT);
    const withCost = (c: ValueCaseVersion, cost: string): ValueCaseVersion => ({ ...c, terms: c.terms.map((t) => (t.key === 'aiCost' ? { ...t, quantity: cost } : t)) });
    // Original: 24000 / 11976 = 2.004…; observed: 24000 / 12024 = 1.996…; both display 2.00.
    const original = withCost(expectedCase(), '11976');
    reg.approve(original.caseId, 1, finance, reg.saveDraft(original, sponsor).digest, AT);
    reg.publish(original.caseId, 1, finance, 'e1', AT);
    const observedTerms = expectedCase().terms.map((t) => ({ ...t, basis: t.sourceKind === 'assumption' ? 'assumption' as const : 'observed' as const, verificationRef: t.sourceKind === 'assumption' ? undefined : 'verify-9' }));
    const observed = withCost({ ...expectedCase(), version: 2, phase: 'observed', terms: observedTerms }, '12024');
    reg.approve(observed.caseId, 2, finance, reg.saveDraft(observed, sponsor).digest, AT);
    reg.publish(observed.caseId, 2, finance, 'o2', AT);
    const cmp = reg.expectedVsObserved(observed.caseId, '2026-11-01', '2026-11-30');
    expect([cmp.original?.valueToCost, cmp.observed?.valueToCost]).toEqual(['2.00', '2.00']);
    expect(cmp.varianceVsOriginal).toBe('-0.01');
  });
});

describe('Copilot second review on #202', () => {
  it('a ledger belongs to one tenant: another tenant cannot record into it or supersede its results', () => {
    const ledger = new KpiResultLedger(TENANT);
    const mine = ledger.append(run(published(), verified(), 'r1'));
    const other = { ...invoiceKpi(), tenantId: 'tenant-other' };
    const regOther = new KpiDefinitionRegistry('tenant-other');
    regOther.createDraft(other, { ...sponsor }, AT);
    regOther.validate('invoice-review-time', 1, sponsor, AT);
    regOther.approve('invoice-review-time', 1, approver, 'kpi_approver', regOther.get('invoice-review-time', 1).digest, AT);
    regOther.publish('invoice-review-time', 1, approver, AT);
    const theirs = evaluateKpi({ record: regOther.published('invoice-review-time')!, observations: verified(), periodStart: '2026-10-01', periodEnd: '2026-10-31', scopeRef: 'bu-a', resultId: 'x1', calculatedAt: AT, calculatedBy: 'svc', supersedes: mine.resultId, supersedeReason: 'takeover' });
    expect(() => ledger.append(theirs)).toThrow(/another tenant/);
    expect(ledger.current('invoice-review-time', '2026-10-01', '2026-10-31', 'bu-a')?.resultId).toBe('r1');
    // Their own ledger accepts their first result: tenants never collide.
    expect(new KpiResultLedger('tenant-other').append(evaluateKpi({ record: regOther.published('invoice-review-time')!, observations: verified(), periodStart: '2026-10-01', periodEnd: '2026-10-31', scopeRef: 'bu-a', resultId: 'x2', calculatedAt: AT, calculatedBy: 'svc' })).resultId).toBe('x2');
  });

  it('a revision saved before the earlier version was approved still needs its rationale and lineage at approval', () => {
    const reg = new ValueCaseRegistry(TENANT);
    const d1 = reg.saveDraft(expectedCase(), sponsor).digest;
    const d2 = reg.saveDraft({ ...expectedCase(), version: 2 }, sponsor).digest;
    reg.approve('case-service-automation', 1, finance, d1, AT);
    expect(() => reg.approve('case-service-automation', 2, finance, d2, AT)).toThrow(/rationale and basedOnVersion/);
    expect(() => reg.saveDraft({ ...expectedCase(), version: 2, rationale: 'Revised.', basedOnVersion: 7 }, sponsor)).toThrow(/names an approved version/);
    const d2c = reg.saveDraft({ ...expectedCase(), version: 2, rationale: 'Revised.', basedOnVersion: 1 }, sponsor).digest;
    expect(reg.approve('case-service-automation', 2, finance, d2c, AT).status).toBe('approved');
  });
});

describe('confirmation review on #202', () => {
  it('versions of one phase and period are approved in order, so a later forecast never becomes the original', () => {
    const reg = new ValueCaseRegistry(TENANT);
    const d1 = reg.saveDraft(expectedCase(), sponsor).digest;
    const d2 = reg.saveDraft({ ...expectedCase(), version: 2, terms: expectedCase().terms.map((x) => (x.key === 'attribution' ? { ...x, quantity: '50' } : x)) }, sponsor).digest;
    reg.approve('case-service-automation', 2, finance, d2, AT);
    expect(() => reg.approve('case-service-automation', 1, finance, d1, AT)).toThrow(/approve versions in order/);
  });

  it('the ledger checks and stores one owned copy: getters, extra fields and non-data are refused', () => {
    const honest = run(published(), verified());
    let reads = 0;
    const sneaky = { ...honest } as Record<string, unknown>;
    Object.defineProperty(sneaky, 'quantity', { enumerable: true, get: () => (reads++ === 0 ? honest.quantity : '0.01') });
    const ledger = new KpiResultLedger(TENANT);
    const stored = ledger.append(sneaky as unknown as typeof honest);
    expect(stored.quantity).toBe(honest.quantity);
    expect(Object.getOwnPropertyDescriptor(stored, 'quantity')?.get).toBeUndefined();
    expect(() => new KpiResultLedger(TENANT).append({ ...honest, injected: 1 } as unknown as typeof honest)).toThrow(/never produces/);
    expect(() => new KpiResultLedger(TENANT).append({ ...honest, resultDigest: honest.resultDigest, quantity: honest.quantity, reasons: [() => 1] } as unknown as typeof honest)).toThrow(/plain data|digest/);
  });

  it('an unfrozen result is stored as a frozen copy the caller cannot change', () => {
    const honest = run(published(), verified());
    const unfrozen = JSON.parse(JSON.stringify(honest)) as typeof honest;
    const stored = new KpiResultLedger(TENANT).append(unfrozen);
    (unfrozen.inputs[0].sourceRefs as string[]).push('later');
    expect(stored.inputs[0].sourceRefs).toEqual(honest.inputs[0].sourceRefs);
    expect(Object.isFrozen(stored.inputs[0].sourceRefs)).toBe(true);
  });

  it('a definition cannot move to another project between edits', () => {
    const reg = new KpiDefinitionRegistry(TENANT);
    reg.createDraft(invoiceKpi(), sponsor, AT);
    expect(() => reg.editDraft({ ...invoiceKpi(), projectId: 'project-other' }, sponsor, AT)).toThrow(/stays in its project/);
  });
});

describe('Copilot third review on #202', () => {
  it('a missing term makes the calculation unavailable even when it sits in an if branch that is not taken', () => {
    const reg = new ValueCaseRegistry(TENANT);
    const terms = expectedCase().terms.map((x) => (x.key === 'costAfter' ? { ...x, quantity: null } : x.key === 'attribution' ? { ...x, quantity: '0' } : x));
    const cv: ValueCaseVersion = { ...expectedCase(), terms, benefit: { ...expectedCase().benefit, expression: 'if(attribution > 0, baselineResolutions * (costBefore - costAfter) * attribution, baselineResolutions * costBefore)' } };
    reg.approve(cv.caseId, 1, finance, reg.saveDraft(cv, sponsor).digest, AT);
    const s = reg.publish(cv.caseId, 1, finance, 's1', AT);
    expect(s.reasons).toContain('no value for costAfter');
    expect(s.value).toBeNull();
    expect(s.valueToCost).toBeNull();
    expect(s.roiPercent).toBeNull();
  });
});

describe('Copilot fourth review on #202', () => {
  it('a KPI input with no source reference is never measured, even with a verification reference', () => {
    const r = run(published(), [obs('acceptedInvoices', '40', 'invoice', { sourceRefs: [] }), obs('reviewTime', '2', 'hour')]);
    expect(r.inputs.find((i) => i.key === 'acceptedInvoices')!.evidenceStatus).toBe('assumed');
    expect(r.evidenceStatus).toBe('assumed');
    expect(run(published(), verified()).evidenceStatus).toBe('measured');
  });

  it('a value-case term with no source reference is assumed, not projected', () => {
    const reg = new ValueCaseRegistry(TENANT);
    const terms = expectedCase().terms.map((x) => ({ ...x, sourceKind: 'manual_observation' as const, basis: 'observed' as const, sourceRefs: x.key === 'aiCost' ? [] : ['ref'], verificationRef: 'verify-1' }));
    const cv: ValueCaseVersion = { ...expectedCase(), phase: 'observed', terms };
    reg.approve(cv.caseId, 1, finance, reg.saveDraft(cv, sponsor).digest, AT);
    expect(reg.publish(cv.caseId, 1, finance, 's1', AT).evidenceStatus).toBe('assumed');
  });

  it('every version of a value case stays in its project', () => {
    const reg = new ValueCaseRegistry(TENANT);
    reg.approve('case-service-automation', 1, finance, reg.saveDraft(expectedCase(), sponsor).digest, AT);
    expect(() => reg.saveDraft({ ...expectedCase(), version: 2, basedOnVersion: 1, rationale: 'Moved.', projectId: 'project-other' }, sponsor)).toThrow(/stays in its project/);
  });
});

describe('Copilot fifth review on #202', () => {
  it('a forecast with no source reference is assumed, not projected', () => {
    const def = invoiceKpi();
    const reg = published(def);
    const r = evaluateKpi({ record: reg.published('invoice-review-time')!, observations: [obs('acceptedInvoices', '40', 'invoice', { basis: 'forecast', sourceRefs: [] }), obs('reviewTime', '2', 'hour', { basis: 'forecast' })], periodStart: '2026-10-01', periodEnd: '2026-10-31', scopeRef: 'bu-a', resultId: 'f1', calculatedAt: AT, calculatedBy: 'svc' });
    expect(r.inputs.map((i) => i.evidenceStatus)).toEqual(['assumed', 'projected']);
    const vc = new ValueCaseRegistry(TENANT);
    const terms = expectedCase().terms.map((x) => ({ ...x, sourceKind: 'connector' as const, basis: 'forecast' as const, sourceRefs: x.key === 'aiCost' ? [] : ['m'] }));
    const cv: ValueCaseVersion = { ...expectedCase(), terms };
    vc.approve(cv.caseId, 1, finance, vc.saveDraft(cv, sponsor).digest, AT);
    expect(vc.publish(cv.caseId, 1, finance, 's1', AT).evidenceStatus).toBe('assumed');
  });
});

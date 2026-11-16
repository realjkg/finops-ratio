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
    const ledger = new KpiResultLedger();
    ledger.append(run(reg, verified(), 'r1'));
    expect(() => ledger.append(run(reg, [obs('acceptedInvoices', '48', 'invoice'), obs('reviewTime', '2', 'hour')], 'r2'))).toThrow(/already in force/);
    try { ledger.append(run(reg, verified(), 'r3')); } catch (e) { expect((e as ResultLedgerError).code).toBe('ALREADY_RECORDED'); }
  });

  it('a result changed after it was calculated is refused', () => {
    const reg = published();
    const tampered = { ...run(reg, verified()), quantity: '1.00' };
    expect(() => new KpiResultLedger().append(tampered)).toThrow(/does not match its digest/);
  });

  it('a record whose definition no longer matches its digest is refused', () => {
    const reg = published();
    const rec = reg.published('invoice-review-time')!;
    const swapped = { ...rec, definition: { ...rec.definition, calculation: { ...rec.definition.calculation, expression: `(${rec.definition.calculation.expression}) * 2` } } };
    expect(() => evaluateKpi({ record: swapped, observations: verified(), periodStart: '2026-10-01', periodEnd: '2026-10-31', scopeRef: 'bu-a', resultId: 'x', calculatedAt: AT, calculatedBy: 'svc' }))
      .toThrow(EvaluationError);
  });
});

// Versioning and history: definitions, results and value cases can be customized and revised without changing any
// number that was already published.
import { describe, expect, it } from 'vitest';
import { evaluateKpi, EvaluationError, KpiResultLedger, recalculate, type Observation } from './evaluate';
import { approver, costPerInvoiceKpi, expectedCase, finance, invoiceKpi, sponsor, TENANT } from './fixtures/syntheticValueModel';
import { KpiDefinitionRegistry, LifecycleError } from './lifecycle';
import { ValueCaseError, ValueCaseRegistry, type ValueCaseVersion } from './valueCase';

const AT = '2026-11-16T12:00:00Z';

function publishedInvoiceKpi() {
  const reg = new KpiDefinitionRegistry(TENANT);
  reg.createDraft(invoiceKpi(), sponsor, AT);
  reg.validate('invoice-review-time', 1, sponsor, AT);
  const v = reg.get('invoice-review-time', 1);
  reg.approve('invoice-review-time', 1, approver, 'kpi_approver', v.digest, AT);
  reg.publish('invoice-review-time', 1, approver, AT);
  return reg;
}

const obs = (key: string, quantity: string | null, unit: string, extra: Partial<Observation> = {}): Observation => ({
  key, quantity, unit, sourceKind: 'connector', basis: 'observed', periodStart: '2026-10-01', periodEnd: '2026-10-31', scopeRef: 'bu-a', sourceRefs: ['batch-1'], verificationRef: 'verify-1', ...extra,
});
const args = (reg: KpiDefinitionRegistry, observations: Observation[], resultId = 'r1') => ({
  record: reg.published('invoice-review-time')!, observations, periodStart: '2026-10-01', periodEnd: '2026-10-31', scopeRef: 'bu-a', resultId, calculatedAt: AT, calculatedBy: 'svc-valuation',
});

describe('KPI definition lifecycle', () => {
  it('Draft → Validated → Approved → Published, with separation of duties', () => {
    const reg = new KpiDefinitionRegistry(TENANT);
    reg.createDraft(invoiceKpi(), sponsor, AT);
    expect(reg.validate('invoice-review-time', 1, sponsor, AT).status).toBe('validated');
    const d = reg.get('invoice-review-time', 1).digest;
    expect(() => reg.approve('invoice-review-time', 1, { id: sponsor.id, roles: ['kpi_approver'] }, 'kpi_approver', d, AT)).toThrow(/cannot approve their own/);
    expect(() => reg.approve('invoice-review-time', 1, approver, 'kpi_approver', 'sha256:stale', AT)).toThrow(/changed since it was reviewed/);
    expect(reg.approve('invoice-review-time', 1, approver, 'kpi_approver', d, AT).status).toBe('approved');
    expect(reg.publish('invoice-review-time', 1, approver, AT).status).toBe('published');
  });

  it('a definition that involves money also needs a separate finance approval', () => {
    const reg = new KpiDefinitionRegistry(TENANT);
    reg.createDraft(costPerInvoiceKpi(), sponsor, AT);
    reg.validate('invoice-review-cost', 1, sponsor, AT);
    const d = reg.get('invoice-review-cost', 1).digest;
    expect(reg.approve('invoice-review-cost', 1, approver, 'kpi_approver', d, AT).status).toBe('validated');
    expect(() => reg.approve('invoice-review-cost', 1, { id: approver.id, roles: ['finance_approver'] }, 'finance_approver', d, AT)).toThrow(/at most one/);
    expect(reg.approve('invoice-review-cost', 1, finance, 'finance_approver', d, AT).status).toBe('approved');
  });

  it('a failed validation keeps the draft and lists the problems', () => {
    const reg = new KpiDefinitionRegistry(TENANT);
    const bad = invoiceKpi();
    bad.calculation.resultUnit = 'USD';
    reg.createDraft(bad, sponsor, AT);
    const r = reg.validate('invoice-review-time', 1, sponsor, AT);
    expect(r.status).toBe('draft');
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it('a published version never changes; edits go to a new version and the old one stays readable', () => {
    const reg = publishedInvoiceKpi();
    const v1 = reg.get('invoice-review-time', 1);
    expect(() => reg.editDraft({ ...invoiceKpi(), name: 'Changed' }, sponsor, AT)).toThrow(LifecycleError);
    expect(() => { (v1.definition as { name: string }).name = 'Mutated'; }).toThrow(TypeError);
    const v2 = reg.newVersion('invoice-review-time', sponsor, AT);
    expect(v2.definition.version).toBe(2);
    expect(v2.basedOnVersion).toBe(1);
    const edited = { ...invoiceKpi(), version: 2 };
    edited.inputs = [...edited.inputs, { key: 'exceptions', label: 'Exceptions', kind: 'count', unit: 'invoice', aggregation: 'sum', sourceKinds: ['connector'] }];
    edited.calculation = { ...edited.calculation, expression: 'reviewTime / (acceptedInvoices + exceptions)' };
    reg.editDraft(edited, sponsor, AT);
    reg.validate('invoice-review-time', 2, sponsor, AT);
    reg.approve('invoice-review-time', 2, approver, 'kpi_approver', reg.get('invoice-review-time', 2).digest, AT);
    reg.publish('invoice-review-time', 2, approver, AT);
    expect(reg.get('invoice-review-time', 1).status).toBe('superseded');
    expect(reg.get('invoice-review-time', 1).definition).toEqual(invoiceKpi());
    expect(reg.get('invoice-review-time', 1).digest).toBe(v1.digest);
  });

  it('an edit after validation returns to Draft and clears approvals', () => {
    const reg = new KpiDefinitionRegistry(TENANT);
    reg.createDraft(costPerInvoiceKpi(), sponsor, AT);
    reg.validate('invoice-review-cost', 1, sponsor, AT);
    reg.approve('invoice-review-cost', 1, approver, 'kpi_approver', reg.get('invoice-review-cost', 1).digest, AT);
    const r = reg.editDraft({ ...costPerInvoiceKpi(), purpose: 'Reworded.' }, sponsor, AT);
    expect(r.status).toBe('draft');
    expect(r.approvals).toEqual([]);
  });

  it('only authors create definitions, and only for their own tenant', () => {
    const reg = new KpiDefinitionRegistry(TENANT);
    expect(() => reg.createDraft(invoiceKpi(), approver, AT)).toThrow(/project_sponsor or kpi_author/);
    expect(() => reg.createDraft({ ...invoiceKpi(), tenantId: 'other-tenant' }, sponsor, AT)).toThrow(/another tenant/);
  });
});

describe('KPI results', () => {
  it('computes in exact units with provenance (2 h over 40 invoices = 3.00 minutes per invoice)', () => {
    const r = evaluateKpi(args(publishedInvoiceKpi(), [obs('acceptedInvoices', '40', 'invoice'), obs('reviewTime', '2', 'hour')]));
    expect(r).toMatchObject({ availability: 'available', quantity: '3.00', unit: 'minute/invoice', evidenceStatus: 'measured', definitionVersion: 1, engineVersion: 'ratio-formula/1', target: { met: true } });
    expect(r.definitionDigest).toMatch(/^sha256:/);
    expect(r.resultDigest).toMatch(/^sha256:/);
  });

  it('evidence status is computed: an assumption or an unverified observation is assumed, a forecast projected', () => {
    const reg = publishedInvoiceKpi();
    expect(evaluateKpi(args(reg, [obs('acceptedInvoices', '40', 'invoice'), obs('reviewTime', '2', 'hour', { sourceKind: 'assumption', basis: 'assumption', verificationRef: undefined })])).evidenceStatus).toBe('assumed');
    expect(evaluateKpi(args(reg, [obs('acceptedInvoices', '40', 'invoice', { verificationRef: undefined }), obs('reviewTime', '2', 'hour')])).evidenceStatus).toBe('assumed');
  });

  it('missing values and zero denominators are unavailable with a reason, never 0', () => {
    const reg = publishedInvoiceKpi();
    expect(evaluateKpi(args(reg, [obs('acceptedInvoices', '0', 'invoice'), obs('reviewTime', '2', 'hour')]))).toMatchObject({ availability: 'unavailable', quantity: null, reasons: ['unavailable: a denominator is zero'] });
    expect(evaluateKpi(args(reg, [obs('reviewTime', '2', 'hour')]))).toMatchObject({ availability: 'unavailable', reasons: ['missing observation for acceptedInvoices'] });
  });

  it('refuses mismatched periods, scopes, units, sources and out-of-bounds values', () => {
    const reg = publishedInvoiceKpi();
    expect(() => evaluateKpi(args(reg, [obs('acceptedInvoices', '40', 'invoice', { periodEnd: '2026-10-30' }), obs('reviewTime', '2', 'hour')]))).toThrow(EvaluationError);
    expect(() => evaluateKpi(args(reg, [obs('acceptedInvoices', '40', 'invoice'), obs('reviewTime', '2', 'USD')]))).toThrow(/not convertible/);
    expect(() => evaluateKpi(args(reg, [obs('acceptedInvoices', '40', 'invoice', { sourceKind: 'assumption', basis: 'assumption' }), obs('reviewTime', '2', 'hour')]))).toThrow(/sourceKind/);
    expect(() => evaluateKpi(args(reg, [obs('acceptedInvoices', '-1', 'invoice'), obs('reviewTime', '2', 'hour')]))).toThrow(/outside its declared bounds/);
  });

  it('a draft can be previewed only as a scenario, which is never measured and never recorded', () => {
    const reg = new KpiDefinitionRegistry(TENANT);
    const draft = reg.createDraft(invoiceKpi(), sponsor, AT);
    const base = { observations: [obs('acceptedInvoices', '40', 'invoice'), obs('reviewTime', '2', 'hour')], periodStart: '2026-10-01', periodEnd: '2026-10-31', scopeRef: 'bu-a', resultId: 's1', calculatedAt: AT, calculatedBy: sponsor.id };
    expect(() => evaluateKpi({ ...base, record: draft })).toThrow(/published definition/);
    const s = evaluateKpi({ ...base, record: draft, mode: 'scenario' });
    expect(s.evidenceStatus).toBe('projected');
    expect(() => new KpiResultLedger(TENANT).append(s)).toThrow(/never recorded as official/);
  });

  it('a recalculation supersedes; the issued result stays exactly as issued', () => {
    const reg = publishedInvoiceKpi();
    const ledger = new KpiResultLedger(TENANT);
    const first = ledger.append(evaluateKpi(args(reg, [obs('acceptedInvoices', '40', 'invoice'), obs('reviewTime', '2', 'hour')])));
    const snapshot = JSON.stringify(first);
    const corrected = recalculate(first, args(reg, [obs('acceptedInvoices', '48', 'invoice'), obs('reviewTime', '2', 'hour')], 'r2'), 'late-arriving invoices from the October batch');
    ledger.append(corrected);
    expect(ledger.current('invoice-review-time', '2026-10-01', '2026-10-31', 'bu-a')?.quantity).toBe('2.50');
    expect(JSON.stringify(ledger.issued('r1'))).toBe(snapshot);
    expect(() => ledger.append(recalculate(first, args(reg, [obs('acceptedInvoices', '50', 'invoice'), obs('reviewTime', '2', 'hour')], 'r3'), 'again'))).toThrow(/already superseded/);
    expect(() => { (first as { quantity: string }).quantity = '1.00'; }).toThrow(TypeError);
  });
});

describe('sponsor cost-to-value case, before and after', () => {
  const observedCase = (v: number, patch: Partial<ValueCaseVersion> = {}): ValueCaseVersion => ({
    ...expectedCase(), version: v, phase: 'observed',
    terms: expectedCase().terms.map((t) => ({ ...t, basis: t.sourceKind === 'assumption' ? 'assumption' : 'observed', verificationRef: t.sourceKind === 'assumption' ? undefined : 'verify-9' })),
    ...patch,
  });
  const approved = (reg: ValueCaseRegistry, cv: ValueCaseVersion) => {
    const r = reg.saveDraft(cv, sponsor);
    return reg.approve(cv.caseId, cv.version, finance, r.digest, AT);
  };

  it('computes Value / cost, net benefit and ROI from the sponsor inputs (worked example: 2.00×, 100%)', () => {
    const reg = new ValueCaseRegistry(TENANT);
    approved(reg, expectedCase());
    const s = reg.publish('case-service-automation', 1, finance, 'snap-1', AT);
    expect(s).toMatchObject({ value: '24000.00', cost: '12000.00', netBenefit: '12000.00', valueToCost: '2.00', roiPercent: '100.0', evidenceStatus: 'assumed', isOriginalBusinessCase: true });
  });

  it('nobody types a ratio, net benefit or evidence status', () => {
    const reg = new ValueCaseRegistry(TENANT);
    expect(() => reg.saveDraft({ ...expectedCase(), valueToCost: '5' } as unknown as ValueCaseVersion, sponsor)).toThrow(/computed, never entered/);
  });

  it('only the sponsor edits inputs, and the sponsor never approves their own case', () => {
    const reg = new ValueCaseRegistry(TENANT);
    expect(() => reg.saveDraft(expectedCase(), finance)).toThrow(/project_sponsor/);
    const r = reg.saveDraft(expectedCase(), sponsor);
    expect(() => reg.approve('case-service-automation', 1, { id: sponsor.id, roles: ['finance_approver'] }, r.digest, AT)).toThrow(/cannot approve their own/);
  });

  it('the original business case is locked; a revised forecast is a new version beside it, never a rewrite', () => {
    const reg = new ValueCaseRegistry(TENANT);
    approved(reg, expectedCase());
    const original = reg.publish('case-service-automation', 1, finance, 'snap-1', AT);
    const issued = JSON.stringify(original);
    expect(() => reg.saveDraft({ ...expectedCase(), terms: expectedCase().terms.map((t) => (t.key === 'aiCost' ? { ...t, quantity: '6000' } : t)) }, sponsor)).toThrow(/never changes/);
    expect(() => reg.saveDraft({ ...expectedCase(), version: 2 }, sponsor)).toThrow(/rationale and basedOnVersion/);
    approved(reg, { ...expectedCase(), version: 2, basedOnVersion: 1, rationale: 'Vendor quote lowered integration cost.', terms: expectedCase().terms.map((t) => (t.key === 'aiCost' ? { ...t, quantity: '8000' } : t)) });
    const revised = reg.publish('case-service-automation', 2, finance, 'snap-2', AT);
    expect(revised.valueToCost).toBe('3.00');
    expect(revised.isOriginalBusinessCase).toBe(false);
    expect(JSON.stringify(reg.issued('snap-1'))).toBe(issued);
    expect(() => reg.publish('case-service-automation', 2, finance, 'snap-3', AT, { supersedes: 'snap-1', reason: 'replace original' })).toThrow(/never superseded/);
  });

  it('observed results compare against the original, so a revised forecast cannot hide a shortfall', () => {
    const reg = new ValueCaseRegistry(TENANT);
    approved(reg, expectedCase());
    reg.publish('case-service-automation', 1, finance, 'snap-1', AT);
    approved(reg, { ...expectedCase(), version: 2, basedOnVersion: 1, rationale: 'Lower forecast after pilot.', terms: expectedCase().terms.map((t) => (t.key === 'attribution' ? { ...t, quantity: '50' } : t)) });
    reg.publish('case-service-automation', 2, finance, 'snap-2', AT);
    approved(reg, observedCase(3, { terms: observedCase(3).terms.map((t) => (t.key === 'costAfter' ? { ...t, quantity: '6' } : t)) }));
    reg.publish('case-service-automation', 3, finance, 'snap-3', AT);
    const cmp = reg.expectedVsObserved('case-service-automation', '2026-11-01', '2026-11-30');
    expect(cmp.original?.valueToCost).toBe('2.00');
    expect(cmp.latestForecast?.valueToCost).toBe('1.25');
    expect(cmp.observed?.valueToCost).toBe('1.33');
    expect(cmp.varianceVsOriginal).toBe('-0.67');
  });

  it('a restatement of an observed result supersedes it from a newer approved version; the issued snapshot is unchanged', () => {
    const reg = new ValueCaseRegistry(TENANT);
    approved(reg, observedCase(1));
    const first = reg.publish('case-service-automation', 1, finance, 'obs-1', AT);
    const issued = JSON.stringify(first);
    expect(() => reg.publish('case-service-automation', 1, finance, 'obs-dup', AT)).toThrow(ValueCaseError);
    approved(reg, observedCase(2, { basedOnVersion: 1, rationale: 'Late invoice for October integration work.', terms: observedCase(2).terms.map((t) => (t.key === 'aiCost' ? { ...t, quantity: '13000' } : t)) }));
    const restated = reg.publish('case-service-automation', 2, finance, 'obs-2', AT, { supersedes: 'obs-1', reason: 'Late invoice' });
    expect(restated.cost).toBe('13000.00');
    expect(JSON.stringify(reg.issued('obs-1'))).toBe(issued);
    expect(reg.expectedVsObserved('case-service-automation', '2026-11-01', '2026-11-30').observed?.snapshotId).toBe('obs-2');
  });

  it('zero cost or a missing input makes the ratio unavailable, never infinite or 0', () => {
    const reg = new ValueCaseRegistry(TENANT);
    approved(reg, { ...expectedCase(), terms: expectedCase().terms.map((t) => (t.key === 'aiCost' ? { ...t, quantity: '0' } : t)) });
    expect(reg.publish('case-service-automation', 1, finance, 's', AT)).toMatchObject({ valueToCost: null, roiPercent: null });
    const reg2 = new ValueCaseRegistry(TENANT);
    approved(reg2, { ...expectedCase(), terms: expectedCase().terms.map((t) => (t.key === 'costAfter' ? { ...t, quantity: null } : t)) });
    expect(reg2.publish('case-service-automation', 1, finance, 's', AT)).toMatchObject({ value: null, valueToCost: null, reasons: ['no value for costAfter'] });
  });

  it('refuses mixed currencies and formulas that do not produce the case currency', () => {
    const reg = new ValueCaseRegistry(TENANT);
    expect(() => reg.saveDraft({ ...expectedCase(), terms: expectedCase().terms.map((t) => (t.key === 'aiCost' ? { ...t, unit: 'EUR' } : t)) }, sponsor)).toThrow(/must produce USD/);
  });
});

describe('evidence ordering', () => {
  it('an assumption labeled as a forecast is still assumed, and a sourced forecast is projected', () => {
    const reg = new ValueCaseRegistry(TENANT);
    const sourced = { ...expectedCase(), terms: expectedCase().terms.map((t) => ({ ...t, sourceKind: 'connector' as const, sourceRefs: ['forecast-model-2'] })) };
    const r = reg.saveDraft(sourced, sponsor);
    reg.approve(sourced.caseId, 1, finance, r.digest, AT);
    expect(reg.publish(sourced.caseId, 1, finance, 'p', AT).evidenceStatus).toBe('projected');
  });
});

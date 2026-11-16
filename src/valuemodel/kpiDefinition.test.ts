import { describe, expect, it } from 'vitest';
import { costPerInvoiceKpi, invoiceKpi } from './fixtures/syntheticValueModel';
import { checkKpiDefinition, comparability, type KpiDefinition } from './kpiDefinition';

const problems = (def: unknown) => {
  const r = checkKpiDefinition(def);
  return r.ok ? [] : r.problems;
};

describe('user-defined KPI and outcome definitions', () => {
  it('accepts custom inputs, outcome conditions, project variables, a bounded formula and a target', () => {
    expect(problems(invoiceKpi())).toEqual([]);
    expect(problems(costPerInvoiceKpi())).toEqual([]);
  });

  it('accepts any number of custom inputs up to the limit, each with its own unit and source kinds', () => {
    const def = invoiceKpi();
    def.inputs.push({ key: 'exceptionCount', label: 'Exceptions routed to a person', kind: 'count', unit: 'invoice', aggregation: 'sum', sourceKinds: ['connector'] });
    def.calculation.expression = '(reviewTime / acceptedInvoices) * (1 + exceptionCount / acceptedInvoices)';
    expect(problems(def)).toEqual([]);
  });

  it('refuses a formula whose unit differs from the declared result unit', () => {
    const def = invoiceKpi();
    def.calculation.resultUnit = 'USD/invoice';
    expect(problems(def).join()).toMatch(/calculation\.resultUnit: the formula produces/);
  });

  it('refuses declared inputs the formula never reads, and undeclared names it does read', () => {
    const def = invoiceKpi();
    def.calculation.expression = 'reviewTime / acceptedInvoices + reviewTime / otherCount';
    expect(problems(def).join()).toMatch(/not a declared input/);
    const def2 = invoiceKpi();
    def2.inputs.push({ key: 'unused', label: 'Unused', kind: 'count', unit: 'invoice', aggregation: 'sum', sourceKinds: ['connector'] });
    expect(problems(def2).join()).toMatch(/unused is declared but never used/);
  });

  it('a rate comes only from the finance register, and the register supplies only rates', () => {
    const def = costPerInvoiceKpi();
    def.inputs[2].sourceKinds = ['assumption'];
    expect(problems(def).join()).toMatch(/a rate comes only from finance_register/);
    const def2 = invoiceKpi();
    def2.inputs[0].sourceKinds = ['finance_register'];
    expect(problems(def2).join()).toMatch(/finance_register supplies rates only/);
  });

  it('kind and unit must agree (a score is not money; a count is a count)', () => {
    const def = invoiceKpi();
    def.inputs[0].unit = 'USD';
    expect(problems(def).join()).toMatch(/does not fit kind count/);
  });

  it('an outcome needs at least one quality condition', () => {
    const def = invoiceKpi();
    def.outcome.requirements = [];
    expect(problems(def).join()).toMatch(/requirements/);
  });

  it('zero denominators are always unavailable, never 0', () => {
    const def = invoiceKpi() as unknown as Record<string, Record<string, unknown>>;
    def.calculation.onZeroDenominator = 'zero';
    expect(problems(def).join()).toMatch(/onZeroDenominator/);
  });

  it('a target names who set it; it is never invented', () => {
    const def = invoiceKpi() as unknown as { target: { setBy: unknown } };
    def.target.setBy = { kind: 'person', name: 'Somebody' };
    expect(problems(def).join()).toMatch(/target\.setBy/);
  });

  it('is strict: unknown fields, reserved keys and prototype keys are refused without echoing values', () => {
    const def = { ...invoiceKpi(), valueToCost: '9.9' } as unknown;
    expect(problems(def)).toContain('$.valueToCost: unknown field');
    const def2 = invoiceKpi();
    def2.inputs[0].key = '__proto__';
    expect(problems(def2).join()).toMatch(/inputs\[0\]\.key/);
    const def3 = { ...invoiceKpi(), ['bad key!']: 'secret-value' } as unknown;
    expect(problems(def3).join()).not.toContain('secret-value');
  });

  it('refuses floats, exponents and bounds out of order', () => {
    const def = invoiceKpi() as unknown as { inputs: Record<string, unknown>[] };
    def.inputs[1].minimum = 0.5;
    expect(problems(def).join()).toMatch(/minimum: plain decimal string/);
    const def2 = invoiceKpi();
    def2.inputs[1].minimum = '10';
    def2.inputs[1].maximum = '2';
    expect(problems(def2).join()).toMatch(/maximum: must not be less than the lower bound/);
  });
});

describe('comparability between versions', () => {
  const v2 = (patch: (d: KpiDefinition) => void) => {
    const d = { ...invoiceKpi(), version: 2 };
    patch(d);
    return d;
  };
  it('renaming or retargeting keeps before and after comparable', () => {
    expect(comparability(invoiceKpi(), v2((d) => { d.name = 'Reviewer minutes per invoice'; d.target = { value: '2', unit: 'minute/invoice', setBy: { kind: 'demo_configuration' } }; }))).toEqual({ comparable: true, basis: 'measurement_unchanged' });
  });
  it('changing the formula, outcome conditions or inputs breaks comparability unless a reviewed mapping exists', () => {
    const changed = v2((d) => { d.outcome.requirements.pop(); d.calculation.expression = '(reviewTime / acceptedInvoices) * 1'; });
    expect(comparability(invoiceKpi(), changed)).toEqual({ comparable: false, changed: ['outcome', 'calculation'] });
    expect(comparability(invoiceKpi(), changed, 'mapping-review-17')).toEqual({ comparable: true, basis: 'reviewed_mapping', mappingRef: 'mapping-review-17' });
  });
});

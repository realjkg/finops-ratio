import { describe, expect, it } from 'vitest';
import { FORMULA_LIMITS, FormulaError, evaluate, inferUnit, parseFormula } from './formula';
import { cmp, div, parseDecimal, toDecimal, type Rational } from './rational';
import { UnitError, convert, describeDims, parseUnit, sameDimension } from './units';

const d = (s: string) => parseDecimal(s) as Rational;

describe('exact rational arithmetic', () => {
  it('parses only plain decimal strings', () => {
    for (const bad of ['1e3', 'NaN', '', ' 1', '1.', '.5', '0x10', 1.5, null, '1234567890123456789']) expect(parseDecimal(bad)).toBeNull();
    expect(toDecimal(d('-12.340'), 3)).toBe('-12.340');
  });
  it('divides exactly and rounds once, half to even', () => {
    expect(toDecimal(div(d('1'), d('3')) as Rational, 4)).toBe('0.3333');
    expect(toDecimal(d('0.125'), 2)).toBe('0.12');
    expect(toDecimal(d('0.135'), 2)).toBe('0.14');
    expect(toDecimal(d('-0.005'), 2)).toBe('0.00');
    expect(div(d('1'), d('0'))).toBeNull();
  });
  it('0.1 + 0.2 is exactly 0.3', () => {
    const r = evaluate(parseFormula('0.1 + 0.2'), () => null);
    expect(r.ok && cmp(r.value, d('0.3'))).toBe(0);
  });
});

describe('units', () => {
  it('converts compatible units exactly and keeps currencies apart', () => {
    expect(toDecimal(convert(d('2'), parseUnit('hour'), parseUnit('minute')) as Rational, 0)).toBe('120');
    expect(sameDimension(parseUnit('USD'), parseUnit('EUR'))).toBe(false);
    expect(describeDims(parseUnit('USD/invoice'))).toBe('count:invoice^-1·currency:USD');
    expect(sameDimension(parseUnit('percent'), parseUnit('1'))).toBe(true);
  });
  it('refuses malformed units without echoing them', () => {
    for (const bad of ['', 'USD per hour', 'a/b/c', 'Usd', '*x', 'x'.repeat(100)]) {
      try {
        parseUnit(bad);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(UnitError);
        if (bad.length > 3) expect((e as Error).message).not.toContain(bad);
      }
    }
  });
});

describe('bounded formula language', () => {
  const units: Record<string, ReturnType<typeof parseUnit>> = {
    minutes: parseUnit('minute'), hours: parseUnit('hour'), invoices: parseUnit('invoice'), usd: parseUnit('USD'), eur: parseUnit('EUR'), csat: parseUnit('score_csat'), rate: parseUnit('USD/hour'),
  };
  const unitOf = (k: string) => units[k];

  it('infers units: minutes ÷ invoices, hours × currency/hour', () => {
    expect(describeDims(inferUnit(parseFormula('minutes / invoices'), unitOf))).toBe('count:invoice^-1·time');
    expect(describeDims(inferUnit(parseFormula('hours * rate'), unitOf))).toBe('currency:USD');
    expect(describeDims(inferUnit(parseFormula('usd / usd'), unitOf))).toBe('dimensionless');
    expect(describeDims(inferUnit(parseFormula('minutes + hours'), unitOf))).toBe('time');
  });

  it('refuses adding or comparing different dimensions', () => {
    for (const f of ['csat + usd', 'usd + eur', 'minutes + 1', 'if(usd > minutes, usd, usd)', 'if(usd > usd, usd, minutes)', 'min(usd, eur)']) {
      expect(() => inferUnit(parseFormula(f), unitOf), f).toThrow(FormulaError);
    }
  });

  it('is not code: no property access, strings, assignment, unknown calls or undeclared names', () => {
    for (const f of ['constructor.constructor("x")()', 'a = 1', '"x"', 'Math.max(1,2)', 'eval(1)', 'process', '1 ;2', 'a[0]', '`x`']) {
      expect(() => inferUnit(parseFormula(f), unitOf), f).toThrow(FormulaError);
    }
  });

  it('enforces length, node and depth limits', () => {
    expect(() => parseFormula('1+'.repeat(600) + '1')).toThrow(/longer than/);
    expect(() => parseFormula(Array.from({ length: 200 }, () => '1').join('+'))).toThrow(/more than/);
    expect(() => parseFormula('('.repeat(40) + '1' + ')'.repeat(40))).toThrow(/deeper/);
    expect(FORMULA_LIMITS.maxNodes).toBeGreaterThan(0);
  });

  it('a zero denominator or missing input is unavailable, never 0 or infinity', () => {
    expect(evaluate(parseFormula('minutes / invoices'), (k) => (k === 'minutes' ? d('10') : d('0')))).toMatchObject({ ok: false, reason: 'zero_denominator' });
    expect(evaluate(parseFormula('minutes / invoices'), (k) => (k === 'minutes' ? d('10') : null))).toMatchObject({ ok: false, reason: 'missing_input' });
  });

  it('evaluates if, min and max exactly', () => {
    const r = evaluate(parseFormula('if(usd >= 100, max(usd, 150), min(usd, 0 - 5))'), () => d('120'));
    expect(r.ok && toDecimal(r.value, 0)).toBe('150');
    const r2 = evaluate(parseFormula('-usd'), () => d('2.5'));
    expect(r2.ok && toDecimal(r2.value, 1)).toBe('-2.5');
  });
});

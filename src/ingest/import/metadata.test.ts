// R3 part 3: the per-source implementation-metadata record (`--metadata`),
// its guard, the declared-scope check, and the accuracy of the public sample's
// record (fixtures/focus-1.0-sample/metadata.json). Pure.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { parse as parseCsv } from 'csv-parse/sync';
import { parseImportMetadata, sameDecimal, scopeWindow } from './metadata';
import { stageFile } from './stageFile';
import { metadataControl } from './importFile';

const DIR = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'focus-1.0-sample');
const META_BYTES = fs.readFileSync(path.join(DIR, 'metadata.json'));
const META = JSON.parse(META_BYTES.toString('utf8'));
const SAMPLE = fs.readFileSync(path.join(DIR, 'focus_sample.csv'));
const CONTROLS = JSON.parse(fs.readFileSync(path.join(DIR, 'control-totals.json'), 'utf8'))['1k'];
const LOC = { bucket: 'ratio-src', prefix: 'p', exportName: 'focus-main' };

const parse = (doc: unknown) => parseImportMetadata(Buffer.from(JSON.stringify(doc)));
function errorOf(doc: unknown): { code: string; message: string } {
  try {
    parse(doc);
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error('expected a refusal');
}
const withField = (p: string[], value: unknown) => {
  const doc = structuredClone(META);
  let o = doc;
  for (const k of p.slice(0, -1)) o = o[k];
  if (value === undefined) delete o[p[p.length - 1]];
  else o[p[p.length - 1]] = value;
  return doc;
};

describe('R3 metadata guard', () => {
  it('accepts the sample record verbatim and returns the sha256 of its bytes', () => {
    const r = parseImportMetadata(META_BYTES);
    expect(r.metadata).toEqual(META);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects unknown keys by KEY name, top-level and nested, never echoing values', () => {
    const e1 = errorOf({ ...META, 'secret-like-key': 'VALUE-123' });
    expect(e1).toMatchObject({ code: 'METADATA_INVALID' });
    expect(e1.message).toContain('secret-like-key');
    expect(e1.message).not.toContain('VALUE-123');
    const e2 = errorOf(withField(['financial', 'extra_total'], 'VALUE-456'));
    expect(e2.message).toContain('financial.extra_total');
    expect(e2.message).not.toContain('VALUE-456');
  });

  it('rejects a missing field, a blank value and an out-of-enum value by key', () => {
    expect(errorOf(withField(['scope', 'timezone'], undefined)).message).toContain('scope.timezone');
    expect(errorOf(withField(['sanitization'], '  ')).message).toContain('sanitization');
    const e = errorOf(withField(['financial', 'tax_coverage'], 'PARTIAL-XYZ'));
    expect(e.message).toContain('financial.tax_coverage');
    expect(e.message).not.toContain('PARTIAL-XYZ');
    for (const [p, v] of [
      [['cost_basis'], 'list'],
      [['scope', 'period_start'], '2024-13-01'],
      [['scope', 'timezone'], 'Mars/Base'],
      [['financial', 'billed_cost_total'], { usd: '1' }],
      [['financial', 'billed_cost_total'], { USD: '1e3' }],
      [['financial', 'currencies'], []],
      [['overlap', 'related_source'], 'Not A Key'],
    ] as Array<[string[], unknown]>) {
      expect(errorOf(withField(p, v)).message).toContain(p.join('.'));
    }
  });

  it("accepts 'unknown' and 'not_available' as explicit values, never a default", () => {
    expect(() => parse(withField(['financial', 'billed_cost_total'], 'unknown'))).not.toThrow();
    expect(() => parse(withField(['financial', 'effective_cost_total'], 'not_available'))).not.toThrow();
    expect(() => parse(withField(['scope', 'accounts'], 'unknown'))).not.toThrow();
    expect(() => parse(withField(['cost_basis'], 'unknown'))).not.toThrow();
    expect(errorOf(withField(['financial', 'billed_cost_total'], null)).message).toContain('financial.billed_cost_total');
  });

  it('overlap yes needs a related source key; no/unknown take null', () => {
    expect(errorOf(withField(['overlap', 'also_present_in_other_source'], 'yes')).message).toContain('overlap.related_source');
    const ok = withField(['overlap', 'also_present_in_other_source'], 'yes');
    ok.overlap.related_source = 'focus-other';
    expect(() => parse(ok)).not.toThrow();
  });

  it('rejects a non-object or invalid JSON without echoing it', () => {
    expect(() => parseImportMetadata(Buffer.from('{"provider": SECRET'))).toThrow(expect.objectContaining({ code: 'METADATA_INVALID', message: expect.not.stringContaining('SECRET') }));
    expect(() => parseImportMetadata(Buffer.from('[1]'))).toThrow(expect.objectContaining({ code: 'METADATA_INVALID' }));
  });
});

describe('R3 sameDecimal', () => {
  it('compares plain decimals exactly, independent of trailing zeros', () => {
    expect(sameDecimal('18.0066386184', '18.00663861840')).toBe(true);
    expect(sameDecimal('-0.10', '-0.1')).toBe(true);
    expect(sameDecimal('18.0066386184', '18.0066386185')).toBe(false);
    expect(sameDecimal('1', '-1')).toBe(false);
    expect(sameDecimal('1e3', '1000')).toBe(false);
  });
});

describe('R3 the sample record is accurate to the exact file (nothing invented)', () => {
  it('control totals and scope equal the independently computed controls for this file', () => {
    const aws = CONTROLS.totals.find((t: { billingPeriod: string }) => t.billingPeriod === '2024-09-01');
    expect(CONTROLS.totals).toHaveLength(1);
    expect(META.financial.billed_cost_total).toEqual({ [aws.billingCurrency]: aws.billedCost });
    expect(META.financial.effective_cost_total).toEqual({ [aws.billingCurrency]: aws.effectiveCost });
    expect(META.financial.currencies).toEqual([aws.billingCurrency]);
    expect(META.provenance).toBe('official-example');
    expect(META.scope.completeness).toBe('explicit-subset');
  });

  it('accounts and credit presence are read from the AWS rows of the file', () => {
    const rows = parseCsv(SAMPLE, { columns: true }) as Array<Record<string, string>>;
    const aws = rows.filter((x) => x.ProviderName === 'AWS');
    const at = (x: Record<string, string>, c: string) => x[c];
    expect(aws).toHaveLength(942);
    expect([...new Set(aws.map((l) => at(l, 'BillingAccountId')))]).toEqual(META.scope.accounts);
    expect(aws.filter((l) => at(l, 'ChargeCategory') === 'Credit')).toHaveLength(1);
    expect(META.financial.credits_coverage).toMatch(/^included/);
    expect(aws.some((l) => at(l, 'ChargeCategory') === 'Tax')).toBe(false);
    expect(META.financial.tax_coverage).toBe('unknown');
  });
});

describe('R3 declared scope: charge periods must fall inside period_start..period_end', () => {
  const scope = (over: Record<string, string>) => scopeWindow({ ...META.scope, ...over });

  it('the sample fits its declared scope (exclusive end, and the same window as an inclusive end one day earlier)', () => {
    expect(() => stageFile(SAMPLE, { location: LOC, scope: scope({}) })).not.toThrow();
    expect(scope({ period_end: '2024-09-30', period_end_semantics: 'inclusive' })).toEqual(scope({}));
  });

  it('refuses rows outside the window with an operator message and no cell values', () => {
    let err: { code: string; message: string } | undefined;
    try {
      stageFile(SAMPLE, { location: LOC, scope: scope({ period_end: '2024-09-29', period_end_semantics: 'inclusive' }) });
    } catch (e) {
      err = e as { code: string; message: string };
    }
    expect(err?.code).toBe('IMPORT_SCOPE_VIOLATION');
    expect(err?.message).toMatch(/^\d+ row\(s\) have a charge period outside the declared scope/);
    expect(err?.message).not.toContain('2024-09-30 ');
  });

  it('honors the declared timezone: midnight in New York starts four hours after midnight UTC', () => {
    expect(scope({ timezone: 'America/New_York' }).startMs - scope({}).startMs).toBe(4 * 3600_000);
    expect(() => stageFile(SAMPLE, { location: LOC, scope: scope({ timezone: 'America/New_York' }) })).toThrow(expect.objectContaining({ code: 'IMPORT_SCOPE_VIOLATION' }));
  });
});

// Review round 1 (PR #145): the record's billed total is a control for exactly one billing month of ONE provider.
describe('R3 metadataControl', () => {
  const scope = (s: Record<string, unknown>) => ({ ...META, scope: { ...META.scope, ...s } });
  it('applies to one month, allowing a zone offset of up to 14 hours past the month end', () => {
    // Inclusive 2024-09-30 in UTC-12 ends 2024-10-01T12:00Z: still one billing month.
    const west = metadataControl(scope({ period_end: '2024-09-30', period_end_semantics: 'inclusive', timezone: 'Etc/GMT+12' }), ['AWS'], undefined);
    expect(west).toMatchObject({ period: '2024-09-01', control: { billedTotal: META.financial.billed_cost_total.USD, currency: 'USD' } });
    // One more day is a second month: no control, a reason.
    const longer = metadataControl(scope({ period_end: '2024-10-01', period_end_semantics: 'inclusive' }), ['AWS'], undefined);
    expect(longer.control).toBeUndefined();
    expect(longer.note).toMatch(/more than one billing month/);
  });

  it('never applies when the source declares more than one provider (the total covers the record provider only)', () => {
    const r = metadataControl(META, ['AWS', 'Microsoft'], undefined);
    expect(r.control).toBeUndefined();
    expect(r.note).toMatch(/several currencies or providers/);
    expect(metadataControl(META, ['AWS'], undefined).control).toBeDefined();
  });
});

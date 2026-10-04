// P2 (Slice 2b): the independent control-total calculator, run from `npm test`.
//
// The calculator is Python on purpose (DESIGN §4): another language and another
// code path than the worker (TypeScript + csv-parse), the staging converter
// (JavaScript) and Postgres. This file:
//   1. runs its Python unit tests (P1); exit 0 required;
//   2. runs it on the committed 1k sample file and requires its output to
//      equal the pinned fixtures/focus-1.0-sample/control-totals.json.
// python3 missing ⇒ these tests FAIL (never skip), like every other required
// tool in this repo's suites.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CALC = path.join(ROOT, 'scripts', 'acceptance', 'focus_control_totals.py');
const DATASET = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'focus-1.0-sample', 'dataset.json'), 'utf8'));
const PINNED = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'focus-1.0-sample', 'control-totals.json'), 'utf8'));

function python(args) {
  const r = spawnSync('python3', args, { cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  if (r.error) throw new Error(`python3 could not be run (required by the acceptance tooling): ${r.error.message}`);
  return r;
}

describe('P2 independent control totals (Python)', () => {
  it('P1: the calculator’s own unit tests pass', () => {
    const r = python(['-m', 'unittest', 'discover', '-s', 'scripts/acceptance', '-p', 'test_*.py']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/\nOK\b/);
  }, 120_000);

  it('reproduces the pinned control totals of the committed 1k file exactly', () => {
    const pin = DATASET.files['1k'];
    const r = python([CALC, '--expect-sha256', pin.sha256, path.join(ROOT, pin.localPath)]);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.type).toBe('ratio.focus-control-totals');
    expect(doc.input).toEqual(PINNED['1k'].input);
    expect(doc.input).toEqual({ sha256: pin.sha256, bytes: pin.bytes, dataRows: pin.dataRows });
    expect(doc.totals).toEqual(PINNED['1k'].totals);
    expect(doc.columns).toEqual(PINNED['1k'].columns);
    expect(doc).not.toHaveProperty('rows');
    // The unquoted SQL-null token, per column, as profiled in DESIGN §1.
    expect(doc.nullTokens.ChargeClass).toBe(1000);
    expect(doc.nullTokens.ContractedCost).toBe(7);
    expect(doc.nullTokens.ConsumedQuantity).toBe(1);
    expect(doc.nullTokens.BilledCost).toBeUndefined();
    expect(doc.nullTokens.EffectiveCost).toBeUndefined();
  }, 120_000);

  it('--rows: one expected API row per upstream record, keyed by Id; the first one checked by hand against the upstream line', () => {
    const pin = DATASET.files['1k'];
    const r = python([CALC, '--rows', '--expect-sha256', pin.sha256, path.join(ROOT, pin.localPath)]);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect({ input: doc.input, columns: doc.columns, totals: doc.totals }).toEqual(PINNED['1k']);
    expect(doc.rows).toHaveLength(1000);
    expect(new Set(doc.rows.map((x) => x.extraColumns.Id)).size).toBe(1000);
    for (const row of doc.rows) for (const k of Object.keys(row.extraColumns)) expect(doc.columns.extra).toContain(k);
    // Upstream data line 1, mapped by hand (NULL ⇒ null or omitted; numbers in numeric::text form; timestamps as the API formats them).
    expect(doc.rows[0]).toEqual({
      billingPeriod: '2024-09-01',
      chargePeriodStart: '2024-09-18T22:00:00.000000Z',
      chargePeriodEnd: '2024-09-18T23:00:00.000000Z',
      billedCost: '0.00000080000',
      effectiveCost: '0.00000000000',
      listCost: '0.00000080000',
      contractedCost: '0.00000000000',
      billingCurrency: 'USD',
      providerName: 'AWS',
      serviceName: 'Amazon Simple Queue Service',
      serviceCategory: 'Integration',
      chargeCategory: 'Usage',
      resourceId: 'arn:ats:sqs:us-test-2:347410479675:mibelllmel-i-032l64f2065481b12',
      subAccountId: '51738928782',
      billingAccountId: '1234567890123',
      usageQuantity: '2.000000000000000',
      usageUnit: 'Requests',
      pricingQuantity: '2.00000000000',
      pricingUnit: 'Requests',
      focusVersion: '1.0',
      extraColumns: {
        BillingAccountName: 'SunBird',
        BillingPeriodEnd: '2024-10-01 00:00:00',
        ChargeDescription: '$0.40 per million Amazon SQS standard requests in Tier1 in US West (Oregon)',
        ChargeFrequency: 'Usage-Based',
        ContractedUnitPrice: '0.00000000000',
        InvoiceIssuerName: 'Amazon Web Services, Inc.',
        ListUnitPrice: '0.0000004',
        PricingCategory: 'Standard',
        PublisherName: 'Amazon Web Services, Inc.',
        RegionId: 'us-west-2',
        RegionName: 'US West (Oregon)',
        Id: '11472',
        SkuId: 'G95FST5FTYV3JSRX',
        SkuPriceId: 'G95FST5FTYV3JSRX.JRTCKXETXF.VXGXCWQKTY',
        SubAccountName: 'Atlas Nimbus',
      },
    });
  }, 120_000);

  it('refuses a file whose SHA-256 is not the pinned one (exit 2, no output)', () => {
    const pin = DATASET.files['1k'];
    const r = python([CALC, '--expect-sha256', '0'.repeat(64), path.join(ROOT, pin.localPath)]);
    // Exit 2 alone is not enough: python3 also exits 2 when the script is missing.
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/SHA-256 mismatch/);
  }, 120_000);
});

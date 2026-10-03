// #4 timezone independence: FOCUS date parsing must not depend on the server's
// local zone. This file runs in its own worker with TZ=America/Los_Angeles.

process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it, vi } from 'vitest';
import { monthsInWindow, rowsFromRecords, validateFocusRecords } from './focusExport';
import { expandWindow } from './httpFocusTransport';
import { createGcpBigQueryTransport } from './gcpBigQueryTransport';

function start(v: unknown): string {
  return validateFocusRecords([{ BilledCost: '1', BillingCurrency: 'USD', ChargePeriodStart: v }], 'feed')[0]
    .ChargePeriodStart;
}

describe('FOCUS dates under TZ=America/Los_Angeles', () => {
  it('the process really is in a non-UTC zone', () => {
    expect(new Date('2026-06-01T00:00:00').getTimezoneOffset()).toBe(420);
  });

  it('an offset-less timestamp is read as UTC, not server-local', () => {
    expect(start('2026-06-01T10:00:00')).toBe('2026-06-01T10:00:00.000Z');
    expect(start('2026-06-01 10:00:00')).toBe('2026-06-01T10:00:00.000Z');
  });

  it('a date-only value is midnight UTC', () => {
    expect(start('2026-06-01')).toBe('2026-06-01T00:00:00.000Z');
  });

  it('explicit offsets are honoured', () => {
    expect(start('2026-06-01T10:00:00-07:00')).toBe('2026-06-01T17:00:00.000Z');
    expect(start('2026-06-01T10:00:00Z')).toBe('2026-06-01T10:00:00.000Z');
  });
});

// M1 (re-review): windows are parsed with the same strict UTC parser, so an
// offset-less window bound is UTC under any server zone — for row filtering,
// month selection, {start}/{end} expansion and BigQuery parameters.
describe('windows under TZ=America/Los_Angeles', () => {
  const W = { start: '2026-06-01T00:00:00', end: '2026-07-01T00:00:00' };

  it('row filtering treats offset-less bounds as UTC', () => {
    const rows = rowsFromRecords(
      [
        { BilledCost: '1', BillingCurrency: 'USD', ChargePeriodStart: '2026-06-01T00:00:00Z' },
        { BilledCost: '2', BillingCurrency: 'USD', ChargePeriodStart: '2026-07-01T03:00:00Z' },
      ],
      W,
      'feed',
    );
    expect(rows.map((r) => r.BilledCost)).toEqual([1]);
  });

  it('month selection uses the UTC month of the bounds', () => {
    // Under local parsing 2026-07-01T00:00:00 PDT is 07:00Z, pulling July in.
    expect(monthsInWindow(W)).toEqual(['2026-06']);
  });

  it('{start}/{end} expansion emits the UTC instant', () => {
    expect(expandWindow('{start}|{end}', W)).toBe(
      `${encodeURIComponent('2026-06-01T00:00:00.000Z')}|${encodeURIComponent('2026-07-01T00:00:00.000Z')}`,
    );
  });

  it('BigQuery timestamp parameters are the UTC instants', async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    let bin = '';
    pkcs8.forEach((b) => {
      bin += String.fromCharCode(b);
    });
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----\n`;
    let params: Array<{ parameterValue: { value: string } }> = [];
    const fetch = vi.fn(async (u: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(u).includes('oauth2')) return Response.json({ access_token: 't', expires_in: 3600 });
      params = JSON.parse(String(init.body)).queryParameters;
      return Response.json({ jobComplete: true, schema: { fields: [] }, rows: [] });
    }) as unknown as typeof globalThis.fetch;
    const t = createGcpBigQueryTransport({
      dataset: 'b.f',
      projectId: 'p',
      credentials: JSON.stringify({ client_email: 'x@y', private_key: pem }),
      fetch,
    });
    await t.fetchExportRows(W);
    expect(params.map((p) => p.parameterValue.value)).toEqual(['2026-06-01 00:00:00.000+00', '2026-07-01 00:00:00.000+00']);
  });
});

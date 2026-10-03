// Challenger review round — connector data correctness + redaction.
//   #2  single-month window with no export for that month throws
//   #3  invalid / inverted windows are rejected
//   #4  strict ISO-8601 dates (offset-less = UTC), epoch only on the BigQuery
//       path and in range, strict decimal numbers
//   #5  ISO-4217-shaped currencies; mixed currencies are kept
//   #7  redactor patterns
//   #11 boundary pins (window edges, dedupe, BigQuery jobComplete:false)
//   #14 month tokens matched on directory / partition segments only
//   #15 AWS / Azure exports read only manifest-listed files

import { describe, expect, it, vi } from 'vitest';
import {
  fetchChecked,
  rowsFromExportText,
  rowsFromRecords,
  selectExportObjects,
  validateFocusRecords,
} from './focusExport';
import { redactUpstreamText } from './redact';
import { createAzureBlobTransport } from './azureBlobTransport';
import { createAwsS3Transport } from './awsS3Transport';
import { createGcpBigQueryTransport } from './gcpBigQueryTransport';

const JUNE = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };
const obj = (key: string, lastModified = '2026-07-01T00:00:00Z', size = 10) => ({ key, lastModified, size });

type FakeRoute = (url: string, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(route: FakeRoute) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => route(String(input), init));
}

function rec(patch: Record<string, unknown>): Record<string, unknown> {
  return { BilledCost: '1', BillingCurrency: 'USD', ChargePeriodStart: '2026-06-02T00:00:00Z', ...patch };
}

// ---------------------------------------------------------------------------
describe('#2 single-month window with no export for that month', () => {
  it('throws naming the month when the listing dates other months only', () => {
    expect(() =>
      selectExportObjects([obj('focus/20260501-20260531/run1/part_0.csv')], JUNE),
    ).toThrow(/no FOCUS export found for billing month 2026-06/);
  });

  it('still falls back to the latest run when NO file names any month', () => {
    const picked = selectExportObjects(
      [obj('focus/runA/part_0.csv', '2026-06-01T00:00:00Z'), obj('focus/runB/part_0.csv', '2026-06-05T00:00:00Z')],
      JUNE,
    );
    expect(picked.map((o) => o.key)).toEqual(['focus/runB/part_0.csv']);
  });
});

// ---------------------------------------------------------------------------
describe('#3 invalid / inverted windows', () => {
  const bad = [
    { start: 'banana', end: '2026-07-01T00:00:00Z' },
    { start: '2026-06-01T00:00:00Z', end: 'banana' },
    { start: '2026-07-01T00:00:00Z', end: '2026-06-01T00:00:00Z' },
    { start: '2026-06-01T00:00:00Z', end: '2026-06-01T00:00:00Z' },
  ];
  it.each(bad)('selectExportObjects rejects %j', (w) => {
    expect(() => selectExportObjects([obj('focus/20260601-20260630/run1/part_0.csv')], w)).toThrow(/window/i);
  });
  it.each(bad)('rowsFromRecords rejects %j', (w) => {
    expect(() => rowsFromRecords([rec({})], w, 'feed')).toThrow(/window/i);
  });
});

// ---------------------------------------------------------------------------
describe('#4 strict dates and numbers', () => {
  const one = (patch: Record<string, unknown>, opts?: { allowEpochSeconds?: boolean }) =>
    validateFocusRecords([rec(patch)], 'feed', opts)[0];

  it('accepts ISO-8601 forms and normalizes to UTC with milliseconds', () => {
    expect(one({ ChargePeriodStart: '2026-06-01' }).ChargePeriodStart).toBe('2026-06-01T00:00:00.000Z');
    expect(one({ ChargePeriodStart: '2026-06-01T10:00:00Z' }).ChargePeriodStart).toBe('2026-06-01T10:00:00.000Z');
    expect(one({ ChargePeriodStart: '2026-06-01T10:00:00+02:00' }).ChargePeriodStart).toBe('2026-06-01T08:00:00.000Z');
    expect(one({ ChargePeriodStart: '2026-06-01 00:00:00 UTC' }).ChargePeriodStart).toBe('2026-06-01T00:00:00.000Z');
    // No offset → UTC, never server-local.
    expect(one({ ChargePeriodStart: '2026-06-01T10:00:00' }).ChargePeriodStart).toBe('2026-06-01T10:00:00.000Z');
  });

  it.each(['20260601', '06/01/2026', '2026-13-01', '2026-02-30', 'June 1 2026', '2026-06-01T25:00:00Z'])(
    'rejects non-ISO / impossible date %s',
    (d) => {
      expect(() => one({ ChargePeriodStart: d })).toThrow(/ChargePeriodStart/);
    },
  );

  it('accepts epoch seconds only on the BigQuery path and only within 2000..2100', () => {
    expect(() => one({ ChargePeriodStart: '1780790400' })).toThrow(/ChargePeriodStart/);
    expect(() => one({ ChargePeriodStart: 1780790400 })).toThrow(/ChargePeriodStart/);
    expect(one({ ChargePeriodStart: '1.7807904E9' }, { allowEpochSeconds: true }).ChargePeriodStart).toBe(
      new Date(1780790400 * 1000).toISOString(),
    );
    expect(() => one({ ChargePeriodStart: '1' }, { allowEpochSeconds: true })).toThrow(/ChargePeriodStart/);
    expect(() => one({ ChargePeriodStart: '9999999999' }, { allowEpochSeconds: true })).toThrow(/ChargePeriodStart/);
  });

  it('accepts strict decimals', () => {
    expect(one({ BilledCost: '1e3' }).BilledCost).toBe(1000);
    expect(one({ BilledCost: '-2.5' }).BilledCost).toBe(-2.5);
    expect(one({ BilledCost: 7 }).BilledCost).toBe(7);
  });

  it.each(['0x10', 'Infinity', '-Infinity', 'NaN', '1,000', '+5', '.5', '1.', '12abc'])('rejects number %s', (n) => {
    expect(() => one({ BilledCost: n })).toThrow(/BilledCost/);
  });

  it('rejects non-finite numeric values and empty required cost', () => {
    expect(() => one({ BilledCost: Infinity })).toThrow(/BilledCost/);
    expect(() => one({ BilledCost: '' })).toThrow(/BilledCost/);
  });
});

// ---------------------------------------------------------------------------
describe('#5 currencies', () => {
  it.each(['usd', 'US', 'USDT', 'U$D', '$'])('rejects BillingCurrency %s', (c) => {
    expect(() => validateFocusRecords([rec({ BillingCurrency: c })], 'feed')).toThrow(/BillingCurrency/);
  });

  it('validates PricingCurrency when present', () => {
    expect(() => validateFocusRecords([rec({ PricingCurrency: 'eur' })], 'feed')).toThrow(/PricingCurrency/);
    expect(validateFocusRecords([rec({ PricingCurrency: 'EUR' })], 'feed')[0].PricingCurrency).toBe('EUR');
    expect(validateFocusRecords([rec({ PricingCurrency: '' })], 'feed')).toHaveLength(1);
  });

  it('keeps mixed currencies (each row carries its own)', () => {
    const rows = rowsFromRecords([rec({ BillingCurrency: 'USD' }), rec({ BillingCurrency: 'EUR', BilledCost: '2' })], JUNE, 'feed');
    expect(rows.map((r) => [r.BillingCurrency, r.BilledCost])).toEqual([
      ['USD', 1],
      ['EUR', 2],
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('#7 redactor patterns', () => {
  const cases: Array<[string, string, string]> = [
    ['AccountKey=', 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=c2VjcmV0S2V5PT0=;EndpointSuffix=core', 'c2VjcmV0S2V5PT0'],
    ['SharedAccessSignature=', 'BlobEndpoint=https://a;SharedAccessSignature=sv=2024&ss=b&sig=XyZsig123', 'XyZsig123'],
    ['X-Amz-Signature=', 'X-Amz-Signature=abcdef0123456789 more', 'abcdef0123456789'],
    ['X-Amz-Credential:', 'X-Amz-Credential: AKIDEXAMPLE/20260601/us-east-1/s3/aws4_request', 'AKIDEXAMPLE/2026'],
    ['X-Amz-Security-Token=', 'X-Amz-Security-Token=FwoGZXIvYXdzEJr', 'FwoGZXIvYXdzEJr'],
    ['JSON access_token', '{"access_token":"at-SECRET-1","x":1}', 'at-SECRET-1'],
    ['JSON refresh_token', '{"refresh_token": "rt-SECRET-2"}', 'rt-SECRET-2'],
    ['JSON id_token', '{"id_token":"idt-SECRET-3"}', 'idt-SECRET-3'],
    ['JSON client_secret', '{"client_secret":"cs-SECRET-4"}', 'cs-SECRET-4'],
    ['JSON api_key', '{"api_key":"ak-SECRET-5"}', 'ak-SECRET-5'],
    ['JSON api-key', '{"api-key":"ak-SECRET-6"}', 'ak-SECRET-6'],
    ['JSON apikey', '{"apikey":"ak-SECRET-7"}', 'ak-SECRET-7'],
    ['JSON password', '{"password":"pw-SECRET-8"}', 'pw-SECRET-8'],
    ['JSON secret', '{"secret":"s-SECRET-9"}', 's-SECRET-9'],
    ['k=v access_token', 'grant ok access_token=at-SECRET-10&scope=x', 'at-SECRET-10'],
    ['k=v client_secret', 'client_secret=cs-SECRET-11 rejected', 'cs-SECRET-11'],
    ['k=v password', 'password=pw-SECRET-12;', 'pw-SECRET-12'],
    ['k=v api_key', 'api_key=ak-SECRET-13', 'ak-SECRET-13'],
    ['JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl here', 'eyJzdWIiOiIxIn0'],
    ['Basic auth', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
    ['URL userinfo', 'connect https://admin:hunter2@db.internal:5432/x failed', 'hunter2'],
    ['PEM block', 'key -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY----- end', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'],
    ['quoted Bearer', 'Authorization: Bearer "qb-SECRET-14"', 'qb-SECRET-14'],
  ];
  it.each(cases)('%s', (_name, input, secret) => {
    const out = redactUpstreamText(input, 10_000);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED');
  });

  it('end-to-end: an Azure AccountKey in an upstream error body never reaches the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = '<Error>AuthenticationFailed DefaultEndpointsProtocol=https;AccountName=a;AccountKey=TOPSECRETKEY==;</Error>';
    const f = vi.fn(async () => new Response(body, { status: 403 })) as unknown as typeof fetch;
    await expect(fetchChecked(f, 'https://a.blob.core.windows.net/c', {}, 'Azure')).rejects.toThrow(/403/);
    const logged = String(warn.mock.calls[0][0]);
    expect(logged).toContain('AuthenticationFailed');
    expect(logged).not.toContain('TOPSECRETKEY');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
describe('#11 boundary pins', () => {
  it('a row at window.start is included and a row at window.end is excluded', () => {
    const csv = [
      'BilledCost,BillingCurrency,ChargePeriodStart',
      '1,USD,2026-06-01T00:00:00Z',
      '2,USD,2026-07-01T00:00:00Z',
      '3,USD,2026-06-30T23:59:59.999Z',
      '4,USD,2026-05-31T23:59:59.999Z',
    ].join('\n');
    expect(rowsFromExportText(csv, JUNE, 'feed').map((r) => r.BilledCost)).toEqual([1, 3]);
  });

  it('a key naming two months is selected once for a window spanning both', () => {
    const picked = selectExportObjects(
      [obj('x/BILLING_PERIOD=2026-05/20260601-20260630/part.csv')],
      { start: '2026-05-01T00:00:00Z', end: '2026-07-01T00:00:00Z' },
    );
    expect(picked.map((o) => o.key)).toEqual(['x/BILLING_PERIOD=2026-05/20260601-20260630/part.csv']);
  });
});

async function serviceAccountJson(): Promise<string> {
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
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({ client_email: 'ratio@proj.iam.gserviceaccount.com', private_key: pem });
}

describe('#11 BigQuery jobComplete:false pins', () => {
  const schema = { fields: [{ name: 'BilledCost' }, { name: 'BillingCurrency' }, { name: 'ChargePeriodStart' }] };
  const row = (cost: string) => ({ f: [{ v: cost }, { v: 'USD' }, { v: '1780790400' }] });

  it('ignores rows on a jobComplete:false response and keeps polling until complete', async () => {
    const sa = await serviceAccountJson();
    let polls = 0;
    const fetch = fakeFetch((url) => {
      if (url.includes('oauth2')) return Response.json({ access_token: 't', expires_in: 3600 });
      if (url.endsWith('/queries')) {
        return Response.json({ jobComplete: false, jobReference: { jobId: 'j1' }, schema, rows: [row('999')] });
      }
      polls += 1;
      if (polls === 1) return Response.json({ jobComplete: false, jobReference: { jobId: 'j1' }, rows: [row('888')] });
      return Response.json({ jobComplete: true, jobReference: { jobId: 'j1' }, schema, rows: [row('5')] });
    });
    const t = createGcpBigQueryTransport({ dataset: 'b.f', projectId: 'p', credentials: sa, fetch });
    const rows = await t.fetchExportRows(JUNE);
    expect(rows.map((r) => r.BilledCost)).toEqual([5]);
    expect(polls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('#14 month tokens match directory / partition segments only', () => {
  it('a filename carrying another month’s date does not select it for that month', () => {
    const objects = [obj('focus/20260601-20260630/run1/costs_2026-05-31.csv')];
    expect(() => selectExportObjects(objects, { start: '2026-05-01T00:00:00Z', end: '2026-06-01T00:00:00Z' })).toThrow(
      /2026-05/,
    );
    expect(selectExportObjects(objects, JUNE).map((o) => o.key)).toEqual(objects.map((o) => o.key));
  });

  it('matches BILLING_PERIOD=YYYY-MM and YYYYMMDD-YYYYMMDD segments', () => {
    expect(selectExportObjects([obj('d/BILLING_PERIOD=2026-06/part-0.csv.gz')], JUNE)).toHaveLength(1);
    expect(selectExportObjects([obj('d/20260601-20260630/r/part-0.csv.gz')], JUNE)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
const CSV = 'BilledCost,BillingCurrency,ChargePeriodStart\n1,USD,2026-06-02T00:00:00Z\n';

function azureListXml(names: string[]): string {
  return `<?xml version="1.0"?><EnumerationResults><Blobs>${names
    .map(
      (n) =>
        `<Blob><Name>${n}</Name><Properties><Last-Modified>Sat, 20 Jun 2026 00:00:00 GMT</Last-Modified><Content-Length>10</Content-Length></Properties></Blob>`,
    )
    .join('')}</Blobs><NextMarker></NextMarker></EnumerationResults>`;
}

function s3ListXml(keys: string[]): string {
  return `<ListBucketResult>${keys
    .map((k) => `<Contents><Key>${k}</Key><LastModified>2026-06-20T00:00:00Z</LastModified><Size>10</Size></Contents>`)
    .join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`;
}

describe('#15 Azure: only manifest-listed blobs are read', () => {
  const RUN = 'focus/20260601-20260630/run1';
  function azure(listing: string[], manifest: unknown | null) {
    const reads: string[] = [];
    const fetch = fakeFetch((url) => {
      if (url.includes('comp=list')) return new Response(azureListXml(listing));
      const name = decodeURIComponent(new URL(url).pathname.replace(/^\/exports\//, ''));
      reads.push(name);
      if (name.endsWith('manifest.json')) return new Response(JSON.stringify(manifest));
      return new Response(CSV);
    });
    const t = createAzureBlobTransport({ exportUrl: 'https://a.blob.core.windows.net/exports/focus', sasToken: 'sig=x', fetch });
    return { t, reads };
  }

  it('fails when the run has no manifest', async () => {
    const { t } = azure([`${RUN}/part_0.csv`], null);
    await expect(t.fetchExportRows(JUNE)).rejects.toThrow(/export run incomplete: manifest missing/);
  });

  it('fails when a manifest-listed blob is missing from the listing', async () => {
    const { t } = azure([`${RUN}/manifest.json`, `${RUN}/part_0.csv`], {
      blobs: [{ blobName: `${RUN}/part_0.csv` }, { blobName: `${RUN}/part_1.csv` }],
    });
    await expect(t.fetchExportRows(JUNE)).rejects.toThrow(/export run incomplete/);
  });

  it('reads only the blobs the manifest lists', async () => {
    const { t, reads } = azure([`${RUN}/manifest.json`, `${RUN}/part_0.csv`, `${RUN}/stray.csv`], {
      blobs: [{ blobName: `${RUN}/part_0.csv` }],
    });
    const rows = await t.fetchExportRows(JUNE);
    expect(rows).toHaveLength(1);
    expect(reads.filter((r) => r.endsWith('.csv'))).toEqual([`${RUN}/part_0.csv`]);
  });
});

describe('#15 AWS: only manifest-listed files are read', () => {
  const DATA = 'focus/ratio/data/BILLING_PERIOD=2026-06';
  const META = 'focus/ratio/metadata/BILLING_PERIOD=2026-06/ratio-Manifest.json';
  function s3(listing: string[], manifest: unknown | null) {
    const reads: string[] = [];
    const fetch = fakeFetch((url) => {
      if (url.includes('list-type=2')) return new Response(s3ListXml(listing));
      const key = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
      reads.push(key);
      if (key.endsWith('Manifest.json')) return new Response(JSON.stringify(manifest));
      return new Response(CSV);
    });
    const t = createAwsS3Transport({ bucket: 'exports', region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 'b', fetch });
    return { t, reads };
  }

  it('fails when the billing period has no manifest', async () => {
    const { t } = s3([`${DATA}/ratio-00001.csv.gz`], null);
    await expect(t.fetchExportRows(JUNE)).rejects.toThrow(/export run incomplete: manifest missing/);
  });

  it('fails when a manifest-listed file is missing from the listing', async () => {
    const { t } = s3([META, `${DATA}/ratio-00001.csv`], {
      dataFiles: [`s3://exports/${DATA}/ratio-00001.csv`, `s3://exports/${DATA}/ratio-00002.csv`],
    });
    await expect(t.fetchExportRows(JUNE)).rejects.toThrow(/export run incomplete/);
  });

  it('reads only the files the manifest lists', async () => {
    const { t, reads } = s3([META, `${DATA}/ratio-00001.csv`, `${DATA}/old-run.csv`], {
      dataFiles: [`s3://exports/${DATA}/ratio-00001.csv`],
    });
    const rows = await t.fetchExportRows(JUNE);
    expect(rows).toHaveLength(1);
    expect(reads.filter((r) => r.endsWith('.csv'))).toEqual([`${DATA}/ratio-00001.csv`]);
  });
});

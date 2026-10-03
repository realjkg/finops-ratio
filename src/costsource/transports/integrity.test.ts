// Data-integrity regressions for the live connector transports (PR #41 review
// findings H4–H8 + silent row drops). A cost connector must either return the
// COMPLETE data for the window or throw — never a silent subset.

import { describe, it, expect, vi } from 'vitest';
import { coerceFocusRecord, rowsFromExportText, selectExportObjects, MAX_EXPORT_FILES } from './focusExport';
import { createHttpFocusTransport } from './httpFocusTransport';
import { createAzureBlobTransport } from './azureBlobTransport';
import { createAwsS3Transport } from './awsS3Transport';
import { createGcpBigQueryTransport } from './gcpBigQueryTransport';

const WINDOW = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };

const GOOD_CSV = [
  'BilledCost,EffectiveCost,BillingCurrency,ChargePeriodStart,ServiceName',
  '10,9,USD,2026-06-02T00:00:00Z,Compute',
].join('\n');

type FakeRoute = (url: string, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(route: FakeRoute) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => route(String(input), init));
}

// --- S3 / Azure listing fixtures ------------------------------------------------

function s3ListXml(keys: string[], token = ''): string {
  return `<ListBucketResult>${keys
    .map((k) => `<Contents><Key>${k}</Key><LastModified>2026-06-20T00:00:00Z</LastModified><Size>10</Size></Contents>`)
    .join('')}<IsTruncated>${token ? 'true' : 'false'}</IsTruncated>${
    token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ''
  }</ListBucketResult>`;
}

function azureListXml(names: string[], next = ''): string {
  return `<?xml version="1.0"?><EnumerationResults><Blobs>${names
    .map(
      (n) =>
        `<Blob><Name>${n}</Name><Properties><Last-Modified>Sat, 20 Jun 2026 00:00:00 GMT</Last-Modified><Content-Length>10</Content-Length></Properties></Blob>`,
    )
    .join('')}</Blobs><NextMarker>${next}</NextMarker></EnumerationResults>`;
}

function shards(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}/part_${String(i).padStart(3, '0')}.csv`);
}

function s3(fetch: ReturnType<typeof fakeFetch>) {
  return createAwsS3Transport({ bucket: 'exports', region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 'b', fetch });
}

function azure(fetch: ReturnType<typeof fakeFetch>) {
  return createAzureBlobTransport({ exportUrl: 'https://a.blob.core.windows.net/exports/focus', sasToken: 'sig=x', fetch });
}

describe('H4 — S3 never silently drops export shards or listing pages', () => {
  it('throws when the selected run has more files than MAX_EXPORT_FILES', async () => {
    const keys = shards('focus/data/BILLING_PERIOD=2026-06/run1', MAX_EXPORT_FILES + 1);
    const fetch = fakeFetch((url) => (url.includes('list-type=2') ? new Response(s3ListXml(keys)) : new Response(GOOD_CSV)));
    await expect(s3(fetch).fetchExportRows(WINDOW)).rejects.toThrow(
      new RegExp(`${MAX_EXPORT_FILES + 1} files.*cap of ${MAX_EXPORT_FILES}`),
    );
  });

  it('throws when the listing still has pages after the page cap', async () => {
    let n = 0;
    const fetch = fakeFetch((url) => {
      if (!url.includes('list-type=2')) return new Response(GOOD_CSV);
      n += 1;
      return new Response(s3ListXml([`focus/data/BILLING_PERIOD=2026-06/run1/part_${n}.csv`], `tok${n}`));
    });
    await expect(s3(fetch).fetchExportRows(WINDOW)).rejects.toThrow(/listing.*page/i);
  });

  it('ping still lists a single page and succeeds on a truncated listing', async () => {
    const fetch = fakeFetch(() => new Response(s3ListXml(['focus/x.csv'], 'more')));
    await expect(s3(fetch).ping()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('H5 — Azure never silently drops export shards or listing pages', () => {
  it('throws when the selected run has more files than MAX_EXPORT_FILES', async () => {
    const names = shards('focus/20260601-20260630/run1', MAX_EXPORT_FILES + 1);
    const fetch = fakeFetch((url) => (url.includes('comp=list') ? new Response(azureListXml(names)) : new Response(GOOD_CSV)));
    await expect(azure(fetch).fetchExportRows(WINDOW)).rejects.toThrow(
      new RegExp(`${MAX_EXPORT_FILES + 1} files.*cap of ${MAX_EXPORT_FILES}`),
    );
  });

  it('throws when the listing still has pages after the page cap', async () => {
    let n = 0;
    const fetch = fakeFetch((url) => {
      if (!url.includes('comp=list')) return new Response(GOOD_CSV);
      n += 1;
      return new Response(azureListXml([`focus/20260601-20260630/run1/part_${n}.csv`], `m${n}`));
    });
    await expect(azure(fetch).fetchExportRows(WINDOW)).rejects.toThrow(/listing.*page/i);
  });

  it('ping still lists a single page and succeeds on a truncated listing', async () => {
    const fetch = fakeFetch(() => new Response(azureListXml(['focus/x.csv'], 'more')));
    await expect(azure(fetch).ping()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('H6 — EffectiveCost and BillingCurrency are never invented', () => {
  it('keeps a legitimate EffectiveCost of 0 (fully discounted / credited usage)', () => {
    const row = coerceFocusRecord({ BilledCost: '12', EffectiveCost: '0', BillingCurrency: 'USD', ChargePeriodStart: '2026-06-02' });
    expect(row?.EffectiveCost).toBe(0);
    const numeric = coerceFocusRecord({ BilledCost: 12, EffectiveCost: 0, BillingCurrency: 'USD', ChargePeriodStart: '2026-06-02' });
    expect(numeric?.EffectiveCost).toBe(0);
  });

  it('defaults EffectiveCost to BilledCost only when absent, null, or empty', () => {
    for (const eff of [undefined, null, '']) {
      const rec: Record<string, unknown> = { BilledCost: '7', BillingCurrency: 'EUR', ChargePeriodStart: '2026-06-02' };
      if (eff !== undefined) rec.EffectiveCost = eff;
      expect(coerceFocusRecord(rec)?.EffectiveCost).toBe(7);
    }
  });

  it('does not assume USD: a row with no BillingCurrency is rejected', () => {
    const csv = 'BilledCost,ChargePeriodStart\n5,2026-06-02T00:00:00Z\n';
    expect(() => rowsFromExportText(csv, WINDOW, 'export.csv')).toThrow(/export\.csv.*row 1.*BillingCurrency/);
    const empty = 'BilledCost,BillingCurrency,ChargePeriodStart\n5,,2026-06-02T00:00:00Z\n';
    expect(() => rowsFromExportText(empty, WINDOW, 'export.csv')).toThrow(/BillingCurrency/);
  });
});

describe('H7 — multi-month windows read every intersecting month', () => {
  const objects = [
    { key: 'focus/20260501-20260531/run1/part_0.csv', lastModified: '2026-06-01T00:00:00Z', size: 10 },
    { key: 'focus/20260501-20260531/run2/part_0.csv', lastModified: '2026-06-02T00:00:00Z', size: 10 },
    { key: 'focus/20260601-20260630/run1/part_0.csv', lastModified: '2026-07-01T00:00:00Z', size: 10 },
    { key: 'focus/20260601-20260630/run1/part_1.csv', lastModified: '2026-07-01T00:00:00Z', size: 10 },
  ];

  it('selects the latest run of each month and unions them', () => {
    const picked = selectExportObjects(objects, { start: '2026-05-15T00:00:00.000Z', end: '2026-06-10T00:00:00.000Z' });
    expect(picked.map((o) => o.key)).toEqual([
      'focus/20260501-20260531/run2/part_0.csv',
      'focus/20260601-20260630/run1/part_0.csv',
      'focus/20260601-20260630/run1/part_1.csv',
    ]);
  });

  it('treats the window as half-open: an end on a month boundary does not pull the next month', () => {
    const picked = selectExportObjects(objects, { start: '2026-05-01T00:00:00.000Z', end: '2026-06-01T00:00:00.000Z' });
    expect(picked.map((o) => o.key)).toEqual(['focus/20260501-20260531/run2/part_0.csv']);
  });

  it('throws naming the month when an intersecting month has no export', () => {
    expect(() =>
      selectExportObjects(objects, { start: '2026-05-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z' }),
    ).toThrow(/2026-07/);
  });
});

// --- BigQuery ---------------------------------------------------------------------

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

const BQ_SCHEMA = { fields: [{ name: 'BilledCost' }, { name: 'BillingCurrency' }, { name: 'ChargePeriodStart' }] };

describe('H8 — BigQuery never returns a subset when the page cap is exhausted', () => {
  it('throws when results still have pages after the cap', async () => {
    const sa = await serviceAccountJson();
    let page = 0;
    const fetch = fakeFetch((url) => {
      if (url.includes('oauth2')) return Response.json({ access_token: 't', expires_in: 3600 });
      page += 1;
      return Response.json({
        jobComplete: true,
        jobReference: { jobId: 'job1' },
        schema: BQ_SCHEMA,
        rows: [{ f: [{ v: '1' }, { v: 'USD' }, { v: '1780790400' }] }],
        pageToken: `p${page}`,
      });
    });
    const t = createGcpBigQueryTransport({ dataset: 'billing.focus', projectId: 'p', credentials: sa, fetch });
    await expect(t.fetchExportRows(WINDOW)).rejects.toThrow(/page/i);
  });

  it('processes the final page when the result completes exactly at the cap', async () => {
    const sa = await serviceAccountJson();
    let page = 0;
    const CAP = 50;
    const fetch = fakeFetch((url) => {
      if (url.includes('oauth2')) return Response.json({ access_token: 't', expires_in: 3600 });
      page += 1;
      return Response.json({
        jobComplete: true,
        jobReference: { jobId: 'job1' },
        schema: BQ_SCHEMA,
        rows: [{ f: [{ v: '1' }, { v: 'USD' }, { v: '1780790400' }] }],
        ...(page < CAP ? { pageToken: `p${page}` } : {}),
      });
    });
    const t = createGcpBigQueryTransport({ dataset: 'billing.focus', projectId: 'p', credentials: sa, fetch });
    expect(await t.fetchExportRows(WINDOW)).toHaveLength(CAP);
  });

  it('throws on an invalid row instead of dropping it', async () => {
    const sa = await serviceAccountJson();
    const fetch = fakeFetch((url) =>
      url.includes('oauth2')
        ? Response.json({ access_token: 't', expires_in: 3600 })
        : Response.json({
            jobComplete: true,
            schema: BQ_SCHEMA,
            rows: [
              { f: [{ v: '1' }, { v: 'USD' }, { v: '1780790400' }] },
              { f: [{ v: null }, { v: 'USD' }, { v: '1780790400' }] },
            ],
          }),
    );
    const t = createGcpBigQueryTransport({ dataset: 'billing.focus', projectId: 'p', credentials: sa, fetch });
    await expect(t.fetchExportRows(WINDOW)).rejects.toThrow(/row 2.*BilledCost/);
  });
});

describe('Invalid rows are never dropped silently', () => {
  it('throws naming the artifact and row for a missing BilledCost', () => {
    const csv = [
      'BilledCost,BillingCurrency,ChargePeriodStart',
      '4,USD,2026-06-02T00:00:00Z',
      ',USD,2026-06-03T00:00:00Z',
    ].join('\n');
    expect(() => rowsFromExportText(csv, WINDOW, 'run1/part_0.csv')).toThrow(/run1\/part_0\.csv.*row 2.*BilledCost/);
  });

  it('throws naming the artifact and row for a missing ChargePeriodStart', () => {
    const csv = 'BilledCost,BillingCurrency,ChargePeriodStart\n4,USD,\n';
    expect(() => rowsFromExportText(csv, WINDOW, 'feed')).toThrow(/feed.*row 1.*ChargePeriodStart/);
  });

  it('throws for an unparseable number instead of coercing it to 0', () => {
    const csv = 'BilledCost,BillingCurrency,ChargePeriodStart\nabc,USD,2026-06-02T00:00:00Z\n';
    expect(() => rowsFromExportText(csv, WINDOW, 'feed')).toThrow(/feed.*row 1.*BilledCost/);
    const qty = 'BilledCost,BillingCurrency,ChargePeriodStart,UsageQuantity\n1,USD,2026-06-02T00:00:00Z,n/a\n';
    expect(() => rowsFromExportText(qty, WINDOW, 'feed')).toThrow(/feed.*row 1.*UsageQuantity/);
  });

  it('still filters rows outside the window (selection, not loss)', () => {
    const csv = 'BilledCost,BillingCurrency,ChargePeriodStart\n4,USD,2026-06-02T00:00:00Z\n9,USD,2026-05-02T00:00:00Z\n';
    expect(rowsFromExportText(csv, WINDOW, 'feed').map((r) => r.BilledCost)).toEqual([4]);
  });

  it('a transport surfaces the invalid row instead of returning fewer rows', async () => {
    const csv = 'BilledCost,BillingCurrency,ChargePeriodStart\n4,USD,2026-06-02T00:00:00Z\n5,USD,\n';
    const t = createHttpFocusTransport({
      endpoint: 'https://ncm.example/api/cost',
      label: 'Nutanix',
      fetch: fakeFetch(() => new Response(csv)),
    });
    await expect(t.fetchExportRows(WINDOW)).rejects.toThrow(/Nutanix.*row 2.*ChargePeriodStart/);
  });
});

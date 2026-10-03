// Live connector transports — exercised against fake provider responses.
//
// Each transport gets an injected `fetch` that answers like the real API
// (Azure List Blobs XML, S3 ListObjectsV2 XML, Google OAuth + BigQuery JSON, a
// plain FOCUS endpoint), so every request shape, auth header, pagination step,
// and decode path is checked with no network.

import { describe, it, expect, vi } from 'vitest';
import {
  coerceFocusRecord,
  decodeExportBytes,
  parseCsv,
  parseExportText,
  rowsFromExportText,
  selectExportObjects,
} from './focusExport';
import { createHttpFocusTransport, expandWindow } from './httpFocusTransport';
import { createAzureBlobTransport, parseAzureExportUrl } from './azureBlobTransport';
import { createAwsS3Transport, resolveS3Location } from './awsS3Transport';
import { createGcpBigQueryTransport, parseTableRef } from './gcpBigQueryTransport';

const WINDOW = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };

const CSV = [
  'BilledCost,EffectiveCost,BillingCurrency,ChargePeriodStart,ChargePeriodEnd,ServiceName,ChargeDescription,ResourceId,x_Vendor',
  '10.5,9.5,USD,2026-06-02T00:00:00Z,2026-06-03T00:00:00Z,Compute,"VM, east ""prod""",arn:ratio:workload/wl-001,abc',
  '3,3,USD,2026-05-02T00:00:00Z,2026-05-03T00:00:00Z,Storage,old,r2,def',
].join('\r\n');

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

type FakeRoute = (url: string, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(route: FakeRoute) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => route(String(input), init));
}

// ---------------------------------------------------------------------------
// Shared parsing
// ---------------------------------------------------------------------------

describe('FOCUS export parsing', () => {
  it('parses RFC 4180 CSV with quoted commas, escaped quotes, and CRLF', () => {
    const rows = parseCsv(CSV);
    expect(rows).toHaveLength(2);
    expect(rows[0].ChargeDescription).toBe('VM, east "prod"');
    expect(rows[1].ServiceName).toBe('Storage');
  });

  it('accepts JSON arrays, common envelopes, and NDJSON', () => {
    expect(parseExportText('[{"BilledCost":1}]')).toHaveLength(1);
    expect(parseExportText('{"rows":[{"BilledCost":1},{"BilledCost":2}]}')).toHaveLength(2);
    expect(parseExportText('{"value":[{"BilledCost":1}]}')).toHaveLength(1);
    expect(parseExportText('{"BilledCost":1}\n{"BilledCost":2}\n')).toHaveLength(2);
  });

  it('coerces types, keeps only FOCUS columns, and fills the v1.0 core', () => {
    const row = coerceFocusRecord({
      BilledCost: '12.5',
      BillingCurrency: 'EUR',
      ChargePeriodStart: '2026-06-01 00:00:00 UTC',
      CommitmentDiscountStatus: '',
      x_Vendor: 'dropped',
    });
    expect(row).not.toBeNull();
    expect(row?.BilledCost).toBe(12.5);
    expect(row?.EffectiveCost).toBe(12.5); // defaults to BilledCost
    expect(row?.ChargePeriodStart).toBe('2026-06-01T00:00:00.000Z');
    expect(row?.CommitmentDiscountStatus).toBeNull();
    expect(row?.BillingCurrency).toBe('EUR'); // carried through, never assumed
    expect(row?.ResourceId).toBe('');
    expect(row).not.toHaveProperty('x_Vendor');
  });

  it('converts BigQuery epoch-second timestamps', () => {
    const row = coerceFocusRecord({ BilledCost: 1, BillingCurrency: 'USD', ChargePeriodStart: '1.7807616E9' });
    expect(row?.ChargePeriodStart).toBe(new Date(1.7807616e9 * 1000).toISOString());
  });

  it('rejects rows without a cost, charge period, or currency rather than inventing or dropping them', () => {
    expect(() => coerceFocusRecord({ ChargePeriodStart: '2026-06-01', BillingCurrency: 'USD' })).toThrow(/BilledCost/);
    expect(() => coerceFocusRecord({ BilledCost: 1, BillingCurrency: 'USD' })).toThrow(/ChargePeriodStart/);
    expect(() => coerceFocusRecord({ BilledCost: 1, ChargePeriodStart: '2026-06-01' })).toThrow(/BillingCurrency/);
  });

  it('filters rows to the requested window', () => {
    const rows = rowsFromExportText(CSV, WINDOW, 'export.csv');
    expect(rows).toHaveLength(1);
    expect(rows[0].BilledCost).toBe(10.5);
  });

  it('transparently gunzips and rejects Parquet with an actionable message', async () => {
    expect(await decodeExportBytes(await gzip('hello'), 'x.csv.gz')).toBe('hello');
    const parquet = new TextEncoder().encode('PAR1....');
    await expect(decodeExportBytes(parquet, 'part-0.parquet')).rejects.toThrow(/configure the export as CSV/);
  });

  it('selects the latest run directory for the window month and skips manifests', () => {
    const picked = selectExportObjects(
      [
        { key: 'focus/20260501-20260531/run1/part_0.csv.gz', lastModified: '2026-06-01T00:00:00Z', size: 10 },
        { key: 'focus/20260601-20260630/run1/part_0.csv.gz', lastModified: '2026-06-10T00:00:00Z', size: 10 },
        { key: 'focus/20260601-20260630/run2/part_0.csv.gz', lastModified: '2026-06-20T00:00:00Z', size: 10 },
        { key: 'focus/20260601-20260630/run2/part_1.csv.gz', lastModified: '2026-06-20T00:00:01Z', size: 10 },
        { key: 'focus/20260601-20260630/run2/manifest.json', lastModified: '2026-06-20T00:00:02Z', size: 10 },
        { key: 'focus/20260601-20260630/run2/empty.csv', lastModified: '2026-06-20T00:00:03Z', size: 0 },
      ],
      WINDOW,
    );
    expect(picked.map((o) => o.key)).toEqual([
      'focus/20260601-20260630/run2/part_0.csv.gz',
      'focus/20260601-20260630/run2/part_1.csv.gz',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Generic HTTPS endpoint (Kubernetes / Nutanix / any FOCUS endpoint)
// ---------------------------------------------------------------------------

describe('HTTP FOCUS transport', () => {
  it('substitutes window placeholders', () => {
    expect(expandWindow('https://x/focus?s={start}&e={end}', WINDOW)).toBe(
      `https://x/focus?s=${encodeURIComponent(WINDOW.start)}&e=${encodeURIComponent(WINDOW.end)}`,
    );
  });

  it('sends a custom auth header verbatim (Nutanix X-ntnx-api-key)', async () => {
    const fetch = fakeFetch(() => new Response(CSV));
    const t = createHttpFocusTransport({
      endpoint: 'https://ncm.example/api/cost',
      token: 'ntnx-key',
      authHeader: 'X-ntnx-api-key',
      label: 'Nutanix',
      fetch,
    });
    const rows = await t.fetchExportRows(WINDOW);
    expect(rows).toHaveLength(1);
    const headers = fetch.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['X-ntnx-api-key']).toBe('ntnx-key');
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('reads gzip-compressed JSON bodies', async () => {
    const body = await gzip(JSON.stringify({ data: [{ BilledCost: 4, BillingCurrency: 'USD', ChargePeriodStart: '2026-06-05' }] }));
    const t = createHttpFocusTransport({
      endpoint: 'https://opencost/focus',
      label: 'K8s',
      fetch: fakeFetch(() => new Response(body as BodyInit)),
    });
    expect((await t.fetchExportRows(WINDOW))[0].BilledCost).toBe(4);
  });

  it('ping surfaces auth failures with the status code', async () => {
    const t = createHttpFocusTransport({
      endpoint: 'https://opencost/focus',
      token: 'bad',
      label: 'K8s',
      fetch: fakeFetch(() => new Response('nope', { status: 401 })),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Status + fixed reason only; the upstream body is logged server-side, never thrown.
    await expect(t.ping()).rejects.toThrow(/^K8s returned 401 \(unauthorized\)$/);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Azure Blob
// ---------------------------------------------------------------------------

function azureListXml(blobs: Array<{ name: string; modified: string; size: number }>, next = ''): string {
  return `<?xml version="1.0"?><EnumerationResults><Blobs>${blobs
    .map(
      (b) =>
        `<Blob><Name>${b.name}</Name><Properties><Last-Modified>${b.modified}</Last-Modified><Content-Length>${b.size}</Content-Length></Properties></Blob>`,
    )
    .join('')}</Blobs><NextMarker>${next}</NextMarker></EnumerationResults>`;
}

describe('Azure Blob transport', () => {
  it('parses container, prefix, and direct-blob URLs', () => {
    expect(parseAzureExportUrl('https://a.blob.core.windows.net/exports/focus/daily')).toEqual({
      origin: 'https://a.blob.core.windows.net',
      container: 'exports',
      prefix: 'focus/daily/',
      directBlob: false,
    });
    expect(parseAzureExportUrl('https://a.blob.core.windows.net/exports/f/part.csv.gz').directBlob).toBe(true);
    expect(() => parseAzureExportUrl('https://a.blob.core.windows.net/')).toThrow(/container/);
  });

  it('lists (with paging), picks the latest run, and reads each blob with the SAS', async () => {
    const gz = await gzip(CSV);
    const fetch = fakeFetch((url) => {
      if (url.includes('comp=list') && !url.includes('marker=')) {
        return new Response(
          azureListXml(
            [{ name: 'focus/20260601-20260630/run1/part_0.csv.gz', modified: 'Wed, 10 Jun 2026 00:00:00 GMT', size: 5 }],
            'page2',
          ),
        );
      }
      if (url.includes('comp=list')) {
        return new Response(
          azureListXml([
            { name: 'focus/20260601-20260630/run2/part_0.csv.gz', modified: 'Sat, 20 Jun 2026 00:00:00 GMT', size: 5 },
            { name: 'focus/20260601-20260630/run2/manifest.json', modified: 'Sat, 20 Jun 2026 00:00:01 GMT', size: 5 },
          ]),
        );
      }
      return new Response(gz as BodyInit);
    });

    const t = createAzureBlobTransport({
      exportUrl: 'https://a.blob.core.windows.net/exports/focus',
      sasToken: '?sv=2024&sig=abc',
      fetch,
    });
    const rows = await t.fetchExportRows(WINDOW);
    expect(rows).toHaveLength(1);

    const urls = fetch.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('restype=container&comp=list&prefix=focus%2F&sv=2024&sig=abc');
    expect(urls[1]).toContain('marker=page2');
    expect(urls[2]).toBe(
      'https://a.blob.core.windows.net/exports/focus/20260601-20260630/run2/part_0.csv.gz?sv=2024&sig=abc',
    );
    expect(urls).toHaveLength(3); // manifest never read
  });

  it('fails loudly when the container holds no readable export', async () => {
    const t = createAzureBlobTransport({
      exportUrl: 'https://a.blob.core.windows.net/exports',
      sasToken: 'sig=x',
      fetch: fakeFetch(() => new Response(azureListXml([]))),
    });
    await expect(t.fetchExportRows(WINDOW)).rejects.toThrow(/no CSV\/JSON export files/);
  });
});

// ---------------------------------------------------------------------------
// AWS S3
// ---------------------------------------------------------------------------

function s3ListXml(keys: Array<{ key: string; modified: string }>, token = ''): string {
  return `<ListBucketResult>${keys
    .map((k) => `<Contents><Key>${k.key}</Key><LastModified>${k.modified}</LastModified><Size>10</Size></Contents>`)
    .join('')}<IsTruncated>${token ? 'true' : 'false'}</IsTruncated>${
    token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ''
  }</ListBucketResult>`;
}

describe('AWS S3 transport', () => {
  it('resolves virtual-hosted, dotted-bucket, and S3-compatible endpoints', () => {
    expect(resolveS3Location({ bucket: 'exports/focus', region: 'us-east-1' })).toEqual({
      base: 'https://exports.s3.us-east-1.amazonaws.com/',
      prefix: 'focus',
    });
    expect(resolveS3Location({ bucket: 'my.exports', region: 'eu-west-1' }).base).toBe(
      'https://s3.eu-west-1.amazonaws.com/my.exports/',
    );
    expect(
      resolveS3Location({ bucket: 'focus', region: 'us-east-1', endpoint: 'https://minio.internal:9000/', prefix: 'aws' }),
    ).toEqual({ base: 'https://minio.internal:9000/focus/', prefix: 'aws' });
  });

  it('pages ListObjectsV2, reads the window month, and signs every request', async () => {
    const fetch = fakeFetch(async (url) => {
      if (url.includes('list-type=2') && !url.includes('continuation-token')) {
        return new Response(
          s3ListXml(
            [{ key: 'focus/ratio/data/BILLING_PERIOD=2026-05/part-0.csv.gz', modified: '2026-06-02T00:00:00Z' }],
            'tok/1',
          ),
        );
      }
      if (url.includes('list-type=2')) {
        return new Response(
          s3ListXml([{ key: 'focus/ratio/data/BILLING_PERIOD=2026-06/part-0.csv.gz', modified: '2026-06-01T00:00:00Z' }]),
        );
      }
      return new Response((await gzip(CSV)) as BodyInit);
    });

    const t = createAwsS3Transport({
      bucket: 'exports',
      prefix: 'focus/ratio',
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
      sessionToken: 'session',
      fetch,
    });
    const rows = await t.fetchExportRows(WINDOW);
    expect(rows).toHaveLength(1);

    const calls = fetch.mock.calls.map(([u, init]) => ({ url: String(u), headers: init?.headers as Record<string, string> }));
    expect(calls[1].url).toContain('continuation-token=tok%2F1');
    // BILLING_PERIOD=2026-06 wins over the more recently written May re-run.
    expect(calls[2].url).toBe(
      'https://exports.s3.us-east-1.amazonaws.com/focus/ratio/data/BILLING_PERIOD%3D2026-06/part-0.csv.gz',
    );
    for (const c of calls) {
      expect(c.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request/);
      expect(c.headers['x-amz-security-token']).toBe('session');
    }
  });

  it('surfaces S3 access errors on ping', async () => {
    const t = createAwsS3Transport({
      bucket: 'exports',
      region: 'us-east-1',
      accessKeyId: 'a',
      secretAccessKey: 'b',
      fetch: fakeFetch(() => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Status + fixed reason only; the upstream XML body is logged server-side, never thrown.
    const err = await t.ping().catch((e: unknown) => e);
    expect((err as Error).message).toBe('S3 FOCUS export returned 403 (forbidden)');
    expect((err as Error).message).not.toContain('AccessDenied');
    expect(String(warn.mock.calls[0][0])).toContain('AccessDenied');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// GCP BigQuery
// ---------------------------------------------------------------------------

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

describe('GCP BigQuery transport', () => {
  it('validates the table reference (no SQL injection through the env)', () => {
    expect(parseTableRef('billing.focus_view', 'p')).toEqual({ project: 'p', dataset: 'billing', table: 'focus_view' });
    expect(parseTableRef('other-proj.billing.focus', 'p').project).toBe('other-proj');
    expect(() => parseTableRef('billing.focus; DROP TABLE x', 'p')).toThrow(/dataset\.table/);
    expect(() => parseTableRef('justone', 'p')).toThrow();
  });

  it('exchanges a signed JWT for a token, runs a parameterized query, and pages results', async () => {
    const sa = await serviceAccountJson();
    const schema = {
      fields: [{ name: 'BilledCost' }, { name: 'BillingCurrency' }, { name: 'ChargePeriodStart' }, { name: 'ServiceName' }],
    };
    const fetch = fakeFetch(async (url, init) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        const form = new URLSearchParams(String(init.body));
        expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
        expect(form.get('assertion')?.split('.')).toHaveLength(3);
        return Response.json({ access_token: 'ya29.token', expires_in: 3600 });
      }
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ya29.token');
      if (url.endsWith('/projects/ratio-prod/queries')) {
        const body = JSON.parse(String(init.body));
        expect(body.query).toBe(
          'SELECT * FROM `ratio-prod.billing.focus_view` WHERE ChargePeriodStart >= @start AND ChargePeriodStart < @end',
        );
        expect(body.queryParameters[0].parameterValue.value).toBe('2026-06-01 00:00:00.000+00');
        return Response.json({
          jobComplete: true,
          jobReference: { jobId: 'job1', location: 'US' },
          schema,
          rows: [{ f: [{ v: '5.5' }, { v: 'USD' }, { v: '1780790400' }, { v: 'Vertex AI' }] }],
          pageToken: 'p2',
        });
      }
      if (url.endsWith('/projects/ratio-prod/datasets/billing/tables/focus_view')) {
        return Response.json({ id: 'ratio-prod:billing.focus_view' });
      }
      expect(url).toContain('/queries/job1?');
      expect(url).toContain('location=US');
      expect(url).toContain('pageToken=p2');
      return Response.json({ jobComplete: true, rows: [{ f: [{ v: '1.25' }, { v: 'USD' }, { v: '1780876800' }, { v: 'GKE' }] }] });
    });

    const t = createGcpBigQueryTransport({ dataset: 'billing.focus_view', projectId: 'ratio-prod', credentials: sa, fetch });
    const rows = await t.fetchExportRows(WINDOW);
    expect(rows.map((r) => r.BilledCost)).toEqual([5.5, 1.25]);
    expect(rows[1].ServiceName).toBe('GKE');

    // Token is cached across calls.
    await t.ping();
    expect(fetch.mock.calls.filter((c) => String(c[0]).includes('oauth2')).length).toBe(1);
  });

  it('accepts a base64-encoded key and rejects a non-service-account key', async () => {
    const sa = await serviceAccountJson();
    const fetch = fakeFetch((url) =>
      url.includes('oauth2') ? Response.json({ access_token: 't' }) : Response.json({ id: 'tbl' }),
    );
    const b64 = btoa(sa);
    await expect(
      createGcpBigQueryTransport({ dataset: 'a.b', projectId: 'p', credentials: b64, fetch }).ping(),
    ).resolves.toBe(true);
    await expect(
      createGcpBigQueryTransport({ dataset: 'a.b', projectId: 'p', credentials: '{"type":"user"}', fetch }).ping(),
    ).rejects.toThrow(/not a service-account key/);
  });
});

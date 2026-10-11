// Contract tests: fixtures/connector-formats (each with a verified/unverified provenance header) through the REAL
// transport, parse, coerce and normalize path; fetch is stubbed at the network boundary. Unverified shapes stay unverified.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CloudConnectorAdapter } from './CloudConnectorAdapter';
import { AWS_CONNECTOR_SPEC, AZURE_CONNECTOR_SPEC, GCP_CONNECTOR_SPEC } from './cloudConnectorConfig';
import { FocusFileAdapter } from './FocusFileAdapter';
import type { CanonicalFocusRow } from './focusRows';
import { coerceFocusRecord, parseExportText, validateFocusRecords } from './transports/focusExport';

/** Fixture text minus its `#` provenance lines (the only transformation applied). */
const fixture = (name: string) =>
  readFileSync(path.resolve(__dirname, '../../fixtures/connector-formats', name), 'utf8').replace(/^#.*\n/gm, '');
const stubFetch = (route: (url: string) => Response | Promise<Response>) =>
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => route(String(input))));
afterEach(() => vi.unstubAllGlobals());

const KEYS = ['BilledCost', 'ChargePeriodStart', 'BillingCurrency', 'ServiceCategory', 'ServiceSubcategory', 'ConsumedQuantity', 'ConsumedUnit', 'UsageQuantity', 'UsageUnit'] as const;
const table = (rows: CanonicalFocusRow[]) => rows.map((r) => KEYS.map((k) => r[k]));
const SEPT = { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' };
const T0914 = '2026-09-14T03:00:00.000Z';

it('AWS Data Exports FOCUS 1.0 CSV via S3 manifest (gzip)', async () => {
  const base = 'finops/focus-v1';
  const keys = [`${base}/metadata/BILLING_PERIOD=2026-09/focus-v1-Manifest.json`, `${base}/data/BILLING_PERIOD=2026-09/20260914T060000Z-synthetic-run-0001/focus-v1-00001.csv.gz`];
  const gz = await new Response(new Blob([fixture('aws-focus-1.0.csv')]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  stubFetch((url) => {
    if (url.includes('list-type=2')) return new Response(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key><LastModified>2026-09-14T06:00:00Z</LastModified><Size>9</Size></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    return new Response(url.endsWith('.json') ? fixture('aws-focus-1.0-Manifest.json') : gz);
  });
  const env = { COSTSOURCE_AWS_LIVE: 'true', AWS_FOCUS_EXPORT_BUCKET: `synthetic-focus-bucket/${base}`, AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIASYNTHETIC', AWS_SECRET_ACCESS_KEY: 'synthetic' };
  const result = await new CloudConnectorAdapter(AWS_CONNECTOR_SPEC, { env }).fetchCostRows(SEPT);
  expect(table(result.rows)).toEqual([
    [0.34, T0914, 'USD', 'Compute', '', 1, 'Hrs', 1, 'Hrs'],
    [0.0000023, T0914, 'USD', 'Storage', '', 0.1, 'GB-Mo', 0.1, 'GB-Mo'],
    [-1.25, '2026-09-01T00:00:00.000Z', 'USD', 'Other', '', 0, '', 0, ''],
  ]);
  expect(result.rows.map((r) => [r.ProviderName, r.ResourceId === ''])).toEqual([['AWS', false], ['AWS', false], ['AWS', true]]);
  expect(result.rows[0]).not.toHaveProperty('Tags'); // connector path drops Tags and x_* (current behavior)
  expect(result.backfilledColumns).toEqual(['ServiceSubcategory', 'SkuMeter', 'CapacityReservationId', 'CapacityReservationStatus', 'PricingCurrency']);
});
const GCP = [[0.016263, T0914, 'USD', 'Networking', '', 2342, 'seconds', 2342, 'seconds'],
  [0.00021, T0914, 'USD', 'Storage', '', 6075910000000, 'byte-seconds', 6075910000000, 'byte-seconds']];
it('GCP FOCUS 1.0 CSV view via the focus_file path keeps Tags and BigQuery text dates', () => {
  const raws = validateFocusRecords(parseExportText(fixture('gcp-focus-1.0-view.csv')), 'gcp', { keepExtensions: true });
  const { rows } = FocusFileAdapter.ingest(raws, '1.0', 'focus-file-sandbox', SEPT);
  expect(table(rows)).toEqual(GCP);
  expect(rows.map((r) => r.BillingPeriodStart)).toEqual(['2026-09-01T07:00:00.000Z', '2026-09-01T07:00:00.000Z']);
  expect((rows[0] as unknown as { Tags: string }).Tags).toBe('{"team":"platform","env":"dev"}');
});

it('GCP BigQuery jobs.query f/v response via the live transport (epoch-second timestamps)', async () => {
  const algo = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  const { privateKey } = (await crypto.subtle.generateKey(algo, true, ['sign'])) as CryptoKeyPair; // throwaway signing key
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey))))}\n-----END PRIVATE KEY-----\n`;
  stubFetch((url) => (url.includes('oauth2') ? Response.json({ access_token: 'synthetic' }) : new Response(fixture('gcp-bigquery-jobs-query.json'))));
  const credentials = JSON.stringify({ client_email: 'synthetic@synthetic.iam.gserviceaccount.com', private_key: pem });
  const env = { COSTSOURCE_GCP_LIVE: 'true', GCP_FOCUS_BQ_DATASET: 'synthetic.focus', GCP_PROJECT_ID: 'synthetic-gcp-project-0001', GOOGLE_APPLICATION_CREDENTIALS: credentials };
  const { rows } = await new CloudConnectorAdapter(GCP_CONNECTOR_SPEC, { env }).fetchCostRows(SEPT);
  expect(table(rows)).toEqual(GCP.map(([cost, start, cur, , ...rest]) => [cost, start, cur, '', ...rest])); // no ServiceCategory field
  expect(rows.map((r) => [r.BillingPeriodEnd, r.ProviderName, r.ResourceId === ''])).toEqual([['2026-10-01T07:00:00.000Z', 'Google Cloud', false], ['2026-10-01T07:00:00.000Z', 'Google Cloud', true]]);
});

it.each([['azure-focus-1.0.csv', ''], ['azure-focus-1.2-preview.csv', 'Virtual Machines']])('Azure Cost Management %s via blob listing + manifest.json', async (file, vmSubcategory) => {
  const run = 'focus/synthetic-focus-daily/20261001-20261031/00000000-0000-0000-0000-00000000a001';
  const blob = (n: string) => `<Blob><Name>${run}/${n}</Name><Properties><Last-Modified>Sun, 11 Oct 2026 04:00:06 GMT</Last-Modified><Content-Length>9</Content-Length></Properties></Blob>`;
  stubFetch((url) => {
    if (url.includes('comp=list')) return new Response(`<EnumerationResults><Blobs>${blob('manifest.json')}${blob('part_0_0001.csv')}</Blobs></EnumerationResults>`);
    return new Response(fixture(url.includes('/manifest.json?') ? 'azure-manifest.json' : file));
  });
  const env = { COSTSOURCE_AZURE_LIVE: 'true', AZURE_FOCUS_EXPORT_URL: 'https://syntheticstore.blob.core.windows.net/synthetic-exports/focus/synthetic-focus-daily', AZURE_FOCUS_SAS: 'sp=rl&sig=synthetic' };
  const { rows } = await new CloudConnectorAdapter(AZURE_CONNECTOR_SPEC, { env }).fetchCostRows({ start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' });
  expect(table(rows)).toEqual([
    [12.48, '2026-10-01T00:00:00.000Z', 'USD', 'Compute', vmSubcategory, 24, 'Hours', 24, 'Hours'],
    [0, '2026-10-01T00:00:00.000Z', 'USD', 'Business', '', 1, 'Each', 1, 'Each'],
    [-3.25, '2026-10-02T00:00:00.000Z', 'USD', '', '', 0, '', 0, ''],
  ]);
});

it('derives ProviderName (removed in FOCUS 1.4) from ServiceProviderName, then InvoiceIssuerName (test-built rows)', () => {
  const base = { BilledCost: '1', BillingCurrency: 'USD', ChargePeriodStart: '2026-09-01T00:00:00Z' };
  expect(coerceFocusRecord({ ...base, ServiceProviderName: 'AWS', InvoiceIssuerName: 'Synthetic Reseller' }).ProviderName).toBe('AWS');
  expect(coerceFocusRecord({ ...base, InvoiceIssuerName: 'Synthetic Issuer' }).ProviderName).toBe('Synthetic Issuer');
  expect(coerceFocusRecord({ ...base, ProviderName: 'AWS', ServiceProviderName: 'Other' }).ProviderName).toBe('AWS');
});

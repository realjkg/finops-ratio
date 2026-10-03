// GCP FOCUS export → BigQuery, queried with a service-account OAuth token.
//
// GCP publishes FOCUS as a BigQuery view over the Cloud Billing detailed
// export. GCP_FOCUS_BQ_DATASET names that view / table as `dataset.table` (or
// `project.dataset.table`); GCP_PROJECT_ID is the project the query job runs
// (and bills) in. GOOGLE_APPLICATION_CREDENTIALS is a service-account key: a
// file path (Node), inline JSON, or base64-encoded JSON — the latter two suit
// serverless hosts with no filesystem. The account needs
// `roles/bigquery.jobUser` on the project and `roles/bigquery.dataViewer` on
// the dataset. Only rows inside the requested window are queried.

import type { FocusExportTransport } from '../CloudConnectorAdapter';
import type { RawSourceRow } from '../focusRows';
import { coerceFocusRecord, fetchChecked, inWindow, type FetchLike } from './focusExport';

export interface GcpBigQueryTransportOptions {
  dataset: string;
  projectId: string;
  credentials: string;
  fetch?: FetchLike;
  /** Override the clock — tests only. */
  now?: () => number;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const LABEL = 'BigQuery FOCUS export';
const BQ = 'https://bigquery.googleapis.com/bigquery/v2';
const SCOPE = 'https://www.googleapis.com/auth/bigquery.readonly';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const MAX_PAGES = 50;

// --- table reference ----------------------------------------------------------

export interface TableRef {
  project: string;
  dataset: string;
  table: string;
}

/** Validates + splits the configured table so it can be safely backtick-quoted. */
export function parseTableRef(ref: string, defaultProject: string): TableRef {
  const parts = ref.replace(/`/g, '').split('.');
  const valid = parts.every((p) => /^[A-Za-z0-9_$-]+$/.test(p));
  if (!valid || parts.length < 2 || parts.length > 3) {
    throw new Error(
      `GCP_FOCUS_BQ_DATASET must be 'dataset.table' or 'project.dataset.table' (got '${ref}')`,
    );
  }
  const [project, dataset, table] = parts.length === 3 ? parts : [defaultProject, ...parts];
  return { project, dataset, table };
}

// --- credentials ----------------------------------------------------------------

export async function loadServiceAccount(raw: string): Promise<ServiceAccountKey> {
  const value = raw.trim();
  let json: string;
  if (value.startsWith('{')) {
    json = value;
  } else if (!/^(\/|\.{1,2}[\\/]|~|[A-Za-z]:\\)/.test(value) && !/\.json$/i.test(value)) {
    json = atob(value.replace(/\s/g, ''));
  } else {
    // A filesystem path — only meaningful on a Node server. Kept out of the
    // client bundle: the browser never reaches this branch (no credentials).
    const fs = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'node:fs/promises')) as {
      readFile(path: string, enc: 'utf8'): Promise<string>;
    };
    json = await fs.readFile(value, 'utf8');
  }
  const key = JSON.parse(json) as Partial<ServiceAccountKey>;
  if (!key.client_email || !key.private_key) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not a service-account key (client_email / private_key missing)');
  }
  return key as ServiceAccountKey;
}

function base64Url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Signed RS256 JWT assertion for the OAuth 2.0 JWT-bearer grant. */
export async function signJwtAssertion(key: ServiceAccountKey, nowSec: number): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: key.token_uri ?? DEFAULT_TOKEN_URI,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(key.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${base64Url(new Uint8Array(sig))}`;
}

// --- query results ----------------------------------------------------------------

interface BqField {
  name: string;
}
interface BqQueryResponse {
  jobComplete?: boolean;
  jobReference?: { jobId: string; location?: string };
  schema?: { fields: BqField[] };
  rows?: Array<{ f: Array<{ v: unknown }> }>;
  pageToken?: string;
}

export function bqRowsToRecords(res: BqQueryResponse): Record<string, unknown>[] {
  const fields = res.schema?.fields ?? [];
  return (res.rows ?? []).map((r) => {
    const rec: Record<string, unknown> = {};
    fields.forEach((f, i) => {
      rec[f.name] = r.f[i]?.v ?? null;
    });
    return rec;
  });
}

/** ISO 8601 → BigQuery canonical TIMESTAMP literal. */
function bqTimestamp(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace('Z', '+00');
}

export function createGcpBigQueryTransport(opts: GcpBigQueryTransportOptions): FocusExportTransport {
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const table = parseTableRef(opts.dataset, opts.projectId);
  let cached: { token: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt > now() + 60_000) return cached.token;
    const key = await loadServiceAccount(opts.credentials);
    const assertion = await signJwtAssertion(key, Math.floor(now() / 1000));
    const res = await fetchChecked(
      fetchImpl,
      key.token_uri ?? DEFAULT_TOKEN_URI,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      },
      'Google OAuth token endpoint',
    );
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('Google OAuth token endpoint returned no access_token');
    cached = { token: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  async function bq<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await accessToken();
    const res = await fetchChecked(
      fetchImpl,
      `${BQ}${path}`,
      {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      },
      LABEL,
      60_000,
    );
    return (await res.json()) as T;
  }

  return {
    async ping() {
      await bq(
        `/projects/${encodeURIComponent(table.project)}/datasets/${encodeURIComponent(table.dataset)}/tables/${encodeURIComponent(table.table)}`,
      );
      return true;
    },
    async fetchExportRows(window) {
      const fqtn = `\`${table.project}.${table.dataset}.${table.table}\``;
      let res = await bq<BqQueryResponse>(`/projects/${encodeURIComponent(opts.projectId)}/queries`, {
        method: 'POST',
        body: JSON.stringify({
          query: `SELECT * FROM ${fqtn} WHERE ChargePeriodStart >= @start AND ChargePeriodStart < @end`,
          useLegacySql: false,
          parameterMode: 'NAMED',
          queryParameters: [
            { name: 'start', parameterType: { type: 'TIMESTAMP' }, parameterValue: { value: bqTimestamp(window.start) } },
            { name: 'end', parameterType: { type: 'TIMESTAMP' }, parameterValue: { value: bqTimestamp(window.end) } },
          ],
          timeoutMs: 30_000,
          maxResults: 10_000,
        }),
      });

      const records: Record<string, unknown>[] = [];
      let schema = res.schema;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        if (res.jobComplete !== false) records.push(...bqRowsToRecords({ ...res, schema: res.schema ?? schema }));
        schema = res.schema ?? schema;
        const done = res.jobComplete !== false && !res.pageToken;
        if (done) break;
        const job = res.jobReference;
        if (!job) throw new Error(`${LABEL}: query did not complete and returned no job reference`);
        const params = new URLSearchParams({ timeoutMs: '30000', maxResults: '10000' });
        if (job.location) params.set('location', job.location);
        if (res.pageToken) params.set('pageToken', res.pageToken);
        res = await bq<BqQueryResponse>(
          `/projects/${encodeURIComponent(opts.projectId)}/queries/${encodeURIComponent(job.jobId)}?${params.toString()}`,
        );
      }

      return records
        .map(coerceFocusRecord)
        .filter((r): r is RawSourceRow => r !== null && inWindow(r, window));
    },
  };
}

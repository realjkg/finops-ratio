// AWS Data Exports ("FOCUS 1.0 with AWS columns") → S3, read with SigV4.
//
// Data Exports writes `<prefix>/<export-name>/data/BILLING_PERIOD=YYYY-MM/…csv.gz`
// with a metadata manifest beside it. AWS_FOCUS_EXPORT_BUCKET is the bucket,
// optionally with the prefix appended (`my-bucket/exports/focus`);
// AWS_FOCUS_EXPORT_PREFIX is an alternative way to give the prefix.
//
// AWS_S3_ENDPOINT points the same reader at an S3-compatible store (MinIO,
// Ceph RGW, NetApp StorageGRID…) for private-cloud / on-prem exports; it uses
// path-style addressing. The export must be CSV (gzip OK), not Parquet.

import type { FocusExportTransport } from '../CloudConnectorAdapter';
import type { RawSourceRow } from '../focusRows';
import {
  assertExportFileCap,
  decodeExportBytes,
  fetchChecked,
  listingTruncatedError,
  rowsFromExportText,
  selectExportObjects,
  xmlValues,
  type ExportObject,
  type FetchLike,
} from './focusExport';
import { rfc3986, signS3Request, type SigV4Credentials } from './sigv4';

export interface AwsS3TransportOptions {
  bucket: string; // 'bucket' or 'bucket/prefix'
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  prefix?: string;
  endpoint?: string; // S3-compatible endpoint override
  fetch?: FetchLike;
}

const LABEL = 'S3 FOCUS export';

export interface S3Location {
  base: string; // URL that object keys are appended to (ends with '/')
  prefix: string;
}

export function resolveS3Location(opts: Pick<AwsS3TransportOptions, 'bucket' | 'region' | 'prefix' | 'endpoint'>): S3Location {
  const [bucket, ...rest] = opts.bucket.replace(/^s3:\/\//, '').split('/');
  const prefix = [rest.join('/'), opts.prefix ?? ''].filter(Boolean).join('/').replace(/^\/+/, '');
  let base: string;
  if (opts.endpoint) {
    base = `${opts.endpoint.replace(/\/+$/, '')}/${bucket}/`;
  } else if (bucket.includes('.')) {
    // Dotted bucket names break virtual-hosted TLS — fall back to path style.
    base = `https://s3.${opts.region}.amazonaws.com/${bucket}/`;
  } else {
    base = `https://${bucket}.s3.${opts.region}.amazonaws.com/`;
  }
  return { base, prefix };
}

/** ListObjectsV2 XML → export objects. */
export function parseS3Listing(xml: string): { objects: ExportObject[]; continuationToken: string } {
  const blocks = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
  const objects = blocks.map((b) => ({
    key: xmlValues(b, 'Key')[0] ?? '',
    lastModified: xmlValues(b, 'LastModified')[0] ?? '',
    size: Number(xmlValues(b, 'Size')[0] ?? 0),
  }));
  const truncated = xmlValues(xml, 'IsTruncated')[0] === 'true';
  return {
    objects,
    continuationToken: truncated ? (xmlValues(xml, 'NextContinuationToken')[0] ?? '') : '',
  };
}

export function createAwsS3Transport(opts: AwsS3TransportOptions): FocusExportTransport {
  const fetchImpl = opts.fetch ?? fetch;
  const loc = resolveS3Location(opts);
  const creds: SigV4Credentials = {
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    sessionToken: opts.sessionToken,
  };

  async function signedGet(url: string): Promise<Response> {
    const headers = await signS3Request({ method: 'GET', url, region: opts.region }, creds);
    return fetchChecked(fetchImpl, url, { headers }, LABEL);
  }

  /**
   * Lists the prefix. A full listing (fetchExportRows) THROWS if pages remain
   * after `maxPages`; only ping's 1-page reachability probe may stop early.
   */
  async function list(maxPages = 20, allowPartial = false): Promise<ExportObject[]> {
    const all: ExportObject[] = [];
    let token = '';
    let more = false;
    for (let page = 0; page < maxPages; page += 1) {
      const params = new URLSearchParams({ 'list-type': '2' });
      if (loc.prefix) params.set('prefix', loc.prefix);
      if (token) params.set('continuation-token', token);
      if (page === 0 && maxPages === 1) params.set('max-keys', '1');
      const res = await signedGet(`${loc.base}?${params.toString()}`);
      const { objects, continuationToken } = parseS3Listing(await res.text());
      all.push(...objects);
      more = Boolean(continuationToken);
      if (!more) break;
      token = continuationToken;
    }
    if (more && !allowPartial) throw listingTruncatedError(LABEL, maxPages);
    return all;
  }

  async function readObject(key: string): Promise<string> {
    const res = await signedGet(`${loc.base}${key.split('/').map(rfc3986).join('/')}`);
    return decodeExportBytes(new Uint8Array(await res.arrayBuffer()), key);
  }

  return {
    async ping() {
      await list(1, true);
      return true;
    },
    async fetchExportRows(window) {
      const keys = selectExportObjects(await list(), window).map((o) => o.key);
      if (keys.length === 0) {
        throw new Error(`${LABEL}: no CSV/JSON export files found under s3 prefix '${loc.prefix}'`);
      }
      assertExportFileCap(keys.length, LABEL);
      const rows: RawSourceRow[] = [];
      for (const key of keys) rows.push(...rowsFromExportText(await readObject(key), window, `${LABEL} ${key}`));
      return rows;
    },
  };
}

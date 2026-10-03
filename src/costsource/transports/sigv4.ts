// AWS Signature Version 4 for S3 requests, on Web Crypto (no AWS SDK).
//
// Scope is deliberately narrow: unsigned-payload-free GET/HEAD requests against
// S3 (or an S3-compatible store), which is all the Data Exports reader needs.
// Verified against the published S3 SigV4 examples in sigv4.test.ts.

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return crypto.subtle.sign('HMAC', k, encoder.encode(data));
}

/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone). */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SigV4Request {
  method: 'GET' | 'HEAD';
  url: string;
  region: string;
  service?: string; // default 's3'
  /** Extra headers to sign and send (e.g. Range). */
  headers?: Record<string, string>;
  /** Override the clock — tests only. */
  now?: Date;
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function amzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/** Returns the full header set (including Authorization) for a signed request. */
export async function signS3Request(
  req: SigV4Request,
  creds: SigV4Credentials,
): Promise<Record<string, string>> {
  const url = new URL(req.url);
  const service = req.service ?? 's3';
  const timestamp = amzDate(req.now ?? new Date());
  const date = timestamp.slice(0, 8);

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': EMPTY_SHA256,
    'x-amz-date': timestamp,
    ...Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  };
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  // S3 canonical URI: each path segment encoded exactly once.
  const canonicalUri =
    url.pathname
      .split('/')
      .map((seg) => rfc3986(decodeURIComponent(seg)))
      .join('/') || '/';

  const canonicalQuery = Array.from(url.searchParams.entries())
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    req.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    EMPTY_SHA256,
  ].join('\n');

  const scope = `${date}/${req.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, await sha256Hex(canonicalRequest)].join('\n');

  const kDate = await hmac(encoder.encode(`AWS4${creds.secretAccessKey}`), date);
  const kRegion = await hmac(kDate, req.region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  const sendHeaders = { ...headers };
  delete sendHeaders.host; // fetch sets Host itself
  return {
    ...sendHeaders,
    Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

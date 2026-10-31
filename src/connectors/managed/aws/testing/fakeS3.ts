// Test-only: a SYNTHETIC in-process S3 endpoint (path-style, HTTP on 127.0.0.1) with just what the
// AWS FOCUS retriever uses: ListObjectsV2 (prefix, delimiter, paging), GetObject (If-Match, Range).
// It records every request (method, path, query, headers) so tests can assert what was sent, and a
// `deny` hook answers with an S3 error (AccessDenied, InvalidAccessKeyId, ...). Never shipped.
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

export interface FakeObject { bytes: Buffer; etag: string; lastModified: Date | null }
export interface FakeRequest { method: string; path: string; query: Record<string, string>; headers: http.IncomingHttpHeaders }

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class FakeS3 {
  readonly objects = new Map<string, FakeObject>();
  readonly requests: FakeRequest[] = [];
  pageSize = 1000;
  deny?: (r: FakeRequest) => { status: number; code: string } | undefined;
  private server?: http.Server;
  endpoint = '';

  constructor(readonly bucket: string) {}

  put(key: string, body: Buffer | string, lastModified: Date | null = new Date('2026-10-01T00:00:00Z')): void {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    this.objects.set(key, { bytes, etag: crypto.createHash('md5').update(bytes).update(key).digest('hex'), lastModified });
  }

  delete(key: string): void {
    this.objects.delete(key);
  }

  /** GETs of object bodies (not listings), by key. */
  gets(): string[] {
    return this.requests.filter((r) => r.method === 'GET' && r.query['list-type'] === undefined).map((r) => r.path.split('/').slice(2).map(decodeURIComponent).join('/'));
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.endpoint;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private error(res: http.ServerResponse, status: number, code: string): void {
    res.writeHead(status, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>synthetic ${code}</Message><RequestId>synthetic</RequestId></Error>`);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://fake');
    const r: FakeRequest = { method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers };
    this.requests.push(r);
    req.resume();
    const denied = this.deny?.(r);
    if (denied) return this.error(res, denied.status, denied.code);
    const [, bucket, ...rest] = url.pathname.split('/');
    if (decodeURIComponent(bucket) !== this.bucket) return this.error(res, 404, 'NoSuchBucket');
    if (rest.length === 0 || (rest.length === 1 && rest[0] === '')) return this.list(res, r.query);
    const key = rest.map(decodeURIComponent).join('/');
    const o = this.objects.get(key);
    if (!o) return this.error(res, 404, 'NoSuchKey');
    const ifMatch = req.headers['if-match'];
    if (ifMatch !== undefined && ifMatch.replace(/"/g, '') !== o.etag) return this.error(res, 412, 'PreconditionFailed');
    let body = o.bytes;
    let status = 200;
    const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
    if (range) {
      body = o.bytes.subarray(Number(range[1]), Number(range[2]) + 1);
      status = 206;
    }
    res.writeHead(status, { 'content-type': 'application/octet-stream', 'content-length': body.length, etag: `"${o.etag}"`, ...(o.lastModified ? { 'last-modified': o.lastModified.toUTCString() } : {}) });
    res.end(body);
  }

  private list(res: http.ServerResponse, q: Record<string, string>): void {
    const prefix = q.prefix ?? '';
    const delimiter = q.delimiter;
    const entries: Array<{ key?: string; prefix?: string }> = [];
    const seen = new Set<string>();
    for (const key of [...this.objects.keys()].sort()) {
      if (!key.startsWith(prefix)) continue;
      const i = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
      if (i >= 0) {
        const p = key.slice(0, i + delimiter!.length);
        if (!seen.has(p)) entries.push({ prefix: p });
        seen.add(p);
      } else entries.push({ key });
    }
    const start = Number(q['continuation-token'] ?? 0);
    const size = Math.min(this.pageSize, Number(q['max-keys'] ?? 1000));
    const page = entries.slice(start, start + size);
    const truncated = start + size < entries.length;
    const contents = page.filter((e) => e.key).map((e) => {
      const o = this.objects.get(e.key!)!;
      return `<Contents><Key>${xml(e.key!)}</Key>${o.lastModified ? `<LastModified>${o.lastModified.toISOString()}</LastModified>` : ''}<ETag>&quot;${o.etag}&quot;</ETag><Size>${o.bytes.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
    });
    const prefixes = page.filter((e) => e.prefix).map((e) => `<CommonPrefixes><Prefix>${xml(e.prefix!)}</Prefix></CommonPrefixes>`);
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${this.bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${size}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents.join('')}${prefixes.join('')}${truncated ? `<NextContinuationToken>${start + size}</NextContinuationToken>` : ''}</ListBucketResult>`,
    );
  }
}

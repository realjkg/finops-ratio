// S3FocusExportSource against a FAKE S3 client (no network): bounded manifest
// reads without trusting ContentLength (Copilot H1), and conditional artifact
// reads pinned to the listed ETag (Copilot H2).
import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { S3FocusExportSource } from './S3FocusExportSource';
import { dataPrefix, metadataPrefix, periodMetadataPrefix, type ExportLocation } from './layout';

const LOC: ExportLocation = { bucket: 'b', prefix: 'p', exportName: 'e' };
const P = '2026-07-01';
const MANIFEST_KEY = periodMetadataPrefix(LOC, P) + 'e-Manifest.json';
const DATA_KEY = dataPrefix(LOC, P) + 'run-1/a.csv.gz';
const MIB = 1024 * 1024;

interface FakeObject {
  etag: string;
  size: number;
  /** A fresh body per GET. */
  body: () => Readable;
  /** Omit ContentLength from the GET response (chunked transfer). */
  noContentLength?: boolean;
}

/** A body like the SDK's: a Readable with transformToByteArray (which buffers everything). */
function sdkBody(stream: Readable): Readable & { transformToByteArray(): Promise<Uint8Array> } {
  return Object.assign(stream, {
    async transformToByteArray(): Promise<Uint8Array> {
      const parts: Buffer[] = [];
      for await (const c of stream) parts.push(Buffer.from(c as Buffer));
      return new Uint8Array(Buffer.concat(parts));
    },
  });
}

function fakeClient(objects: Map<string, FakeObject>, calls: Array<{ key: string; ifMatch?: string }>): S3Client {
  return {
    async send(cmd: unknown) {
      if (cmd instanceof ListObjectsV2Command) {
        const { Prefix = '', Delimiter } = cmd.input;
        const keys = [...objects.keys()].filter((k) => k.startsWith(Prefix));
        if (Delimiter) {
          const prefixes = [...new Set(keys.map((k) => k.slice(Prefix.length)).filter((r) => r.includes(Delimiter)).map((r) => Prefix + r.slice(0, r.indexOf(Delimiter) + 1)))];
          return { CommonPrefixes: prefixes.map((p) => ({ Prefix: p })), Contents: [], IsTruncated: false };
        }
        return { Contents: keys.map((k) => ({ Key: k, Size: objects.get(k)!.size, ETag: objects.get(k)!.etag })), IsTruncated: false };
      }
      if (cmd instanceof GetObjectCommand) {
        const { Key = '', IfMatch } = cmd.input;
        calls.push({ key: Key, ...(IfMatch !== undefined ? { ifMatch: IfMatch } : {}) });
        const o = objects.get(Key);
        if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        if (IfMatch !== undefined && IfMatch !== o.etag) {
          throw Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
        }
        return { Body: sdkBody(o.body()), ETag: o.etag, ...(o.noContentLength ? {} : { ContentLength: o.size }) };
      }
      throw new Error('unexpected command');
    },
  } as unknown as S3Client;
}

const manifestFor = (keys: string[]) => Buffer.from(JSON.stringify({ dataFiles: keys }));

describe('S3FocusExportSource with a fake S3 client', () => {
  it('H1: an oversized manifest without ContentLength is refused after reading at most the limit (streamed, aborted)', async () => {
    let produced = 0;
    let destroyed = false;
    const huge = (): Readable => {
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      const r = new Readable({
        read() {
          if (produced >= 64 * MIB) return this.push(null);
          produced += chunk.length;
          this.push(chunk);
        },
      });
      r.on('close', () => (destroyed = true));
      return r;
    };
    const objects = new Map<string, FakeObject>([[MANIFEST_KEY, { etag: '"m1"', size: 64 * MIB, body: huge, noContentLength: true }]]);
    const src = new S3FocusExportSource({ client: fakeClient(objects, []), location: LOC });
    const [listing] = await src.listPeriods();
    expect(listing).toMatchObject({ ok: false, billingPeriod: P, code: 'MANIFEST_INVALID' });
    expect(produced).toBeLessThanOrEqual(16 * MIB + 2 * 64 * 1024);
    await new Promise((r) => setImmediate(r));
    expect(destroyed).toBe(true);
  });

  it('H1: a manifest at the limit is still read (no false refusal)', async () => {
    const data = Buffer.from('x');
    const objects = new Map<string, FakeObject>([
      [MANIFEST_KEY, { etag: '"m1"', size: 0, body: () => Readable.from([manifestFor([DATA_KEY])]), noContentLength: true }],
      [DATA_KEY, { etag: '"d1"', size: data.length, body: () => Readable.from([data]) }],
    ]);
    const src = new S3FocusExportSource({ client: fakeClient(objects, []), location: LOC });
    const [listing] = await src.listPeriods();
    expect(listing.ok).toBe(true);
  });

  it('H2: the artifact GET is conditional on the listed ETag; a replaced object fails SOURCE_CHANGED (retryable)', async () => {
    const v1 = Buffer.from('version one');
    const objects = new Map<string, FakeObject>([
      [MANIFEST_KEY, { etag: '"m1"', size: 0, body: () => Readable.from([manifestFor([DATA_KEY])]) }],
      [DATA_KEY, { etag: '"d1"', size: v1.length, body: () => Readable.from([v1]) }],
    ]);
    const calls: Array<{ key: string; ifMatch?: string }> = [];
    const src = new S3FocusExportSource({ client: fakeClient(objects, calls), location: LOC });
    const [listing] = await src.listPeriods();
    if (!listing.ok) throw new Error('listing failed');
    const ref = listing.set.artifacts[0];
    expect(ref.version).toBe('"d1"');

    // Unchanged: the read succeeds and was conditional on the listed ETag.
    const chunks: Buffer[] = [];
    for await (const c of await src.openArtifact(ref)) chunks.push(Buffer.from(c as Buffer));
    expect(Buffer.concat(chunks).equals(v1)).toBe(true);
    expect(calls.at(-1)).toEqual({ key: DATA_KEY, ifMatch: '"d1"' });

    // Replaced between listing and GET.
    const v2 = Buffer.from('version two, different bytes');
    objects.set(DATA_KEY, { etag: '"d2"', size: v2.length, body: () => Readable.from([v2]) });
    await expect(src.openArtifact(ref)).rejects.toMatchObject({ code: 'SOURCE_CHANGED', retryable: true });
    expect(calls.at(-1)).toEqual({ key: DATA_KEY, ifMatch: '"d1"' });
  });
});

describe('S3FocusExportSource listing is abortable (Copilot M3)', () => {
  it('an endlessly paginating listing stops when the signal aborts: every request carries the signal, no request after the abort', async () => {
    let sends = 0;
    let sendsAfterAbort = 0;
    let withSignal = 0;
    const ac = new AbortController();
    const client = {
      async send(_cmd: unknown, opts?: { abortSignal?: AbortSignal }) {
        sends++;
        if (ac.signal.aborted) sendsAfterAbort++;
        if (opts?.abortSignal) withSignal++;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 20);
          opts?.abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
          });
        });
        return { CommonPrefixes: [], Contents: [], IsTruncated: true, NextContinuationToken: `t${sends}` };
      },
    } as unknown as S3Client;
    const src = new S3FocusExportSource({ client, location: LOC });
    setTimeout(() => ac.abort(new Error('deadline')), 200);
    await expect(src.listPeriods(undefined, { signal: ac.signal })).rejects.toThrow();
    expect(sends).toBeGreaterThan(2);
    expect(withSignal).toBe(sends);
    expect(sendsAfterAbort).toBe(0);
    const n = sends;
    await new Promise((r) => setTimeout(r, 100));
    expect(sends).toBe(n);
  });

  it('a transport that does not honour the abort signal: the abort check BETWEEN pages still stops the listing (no request after the abort)', async () => {
    let sends = 0;
    let sendsAfterAbort = 0;
    const ac = new AbortController();
    const client = {
      async send() {
        sends++;
        if (ac.signal.aborted) sendsAfterAbort++;
        await new Promise((r) => setTimeout(r, 5)); // completes regardless of the signal
        // Bounded so that a missing check fails the assertions instead of hanging the test.
        return { CommonPrefixes: [], Contents: [], IsTruncated: sends < 400, NextContinuationToken: `t${sends}` };
      },
    } as unknown as S3Client;
    const src = new S3FocusExportSource({ client, location: LOC });
    setTimeout(() => ac.abort(new Error('deadline')), 100);
    await expect(src.listPeriods(undefined, { signal: ac.signal })).rejects.toThrow('deadline');
    expect(sends).toBeGreaterThan(2);
    expect(sendsAfterAbort).toBe(0);
  });
});

describe('S3FocusExportSource, PR #54 third review (H1, M1, M3)', () => {
  const v1 = Buffer.from('version one');
  const baseObjects = () =>
    new Map<string, FakeObject>([
      [MANIFEST_KEY, { etag: '"m1"', size: 0, body: () => Readable.from([manifestFor([DATA_KEY])]) }],
      [DATA_KEY, { etag: '"d1"', size: v1.length, body: () => Readable.from([v1]) }],
    ]);
  /** The fake client, but the listing of `prefix` claims more pages without a continuation token. */
  const truncatedWithoutToken = (inner: S3Client, prefix: string): S3Client =>
    ({
      async send(cmd: unknown, opts?: unknown) {
        const r = await (inner.send as (c: unknown, o?: unknown) => Promise<Record<string, unknown>>)(cmd, opts);
        if (cmd instanceof ListObjectsV2Command && cmd.input.Prefix === prefix) return { ...r, IsTruncated: true, NextContinuationToken: undefined };
        return r;
      },
    }) as unknown as S3Client;

  for (const [where, prefix] of [
    ['the metadata folder (period discovery)', metadataPrefix(LOC)],
    ["a period's data folder", dataPrefix(LOC, P)],
  ] as const) {
    it(`H1: a page of ${where} that is truncated but has no continuation token is SOURCE_LISTING_INVALID (non-retryable), never a short listing`, async () => {
      const calls: Array<{ key: string; ifMatch?: string }> = [];
      const inner = fakeClient(baseObjects(), calls);
      // Sanity: the prefix really is one the source lists.
      const seen: string[] = [];
      const spy = { async send(cmd: unknown) { if (cmd instanceof ListObjectsV2Command) seen.push(cmd.input.Prefix ?? ''); return inner.send(cmd as never); } } as unknown as S3Client;
      await new S3FocusExportSource({ client: spy, location: LOC }).listPeriods();
      expect(seen).toContain(prefix);

      const src = new S3FocusExportSource({ client: truncatedWithoutToken(inner, prefix), location: LOC });
      await expect(src.listPeriods()).rejects.toMatchObject({ code: 'SOURCE_LISTING_INVALID', retryable: false });
    });
  }

  it('M1: an artifact listed without an ETag is refused (SOURCE_LISTING_INVALID); a ref without a version is never fetched unconditionally', async () => {
    const objects = baseObjects();
    objects.set(DATA_KEY, { etag: '', size: v1.length, body: () => Readable.from([v1]) });
    const calls: Array<{ key: string; ifMatch?: string }> = [];
    const src = new S3FocusExportSource({ client: fakeClient(objects, calls), location: LOC });
    const [listing] = await src.listPeriods();
    expect(listing).toMatchObject({ ok: false, billingPeriod: P, code: 'SOURCE_LISTING_INVALID' });

    const getsBefore = calls.length;
    await expect(src.openArtifact({ name: 'run-1/a.csv.gz', key: DATA_KEY, byteSize: v1.length, version: '' })).rejects.toMatchObject({
      code: 'SOURCE_LISTING_INVALID',
      retryable: false,
    });
    expect(calls.length).toBe(getsBefore); // no GET at all, let alone one without If-Match
  });

  it('M3: the artifact GET carries the abort signal; an aborted open rejects with the abort reason', async () => {
    let signalSeen: AbortSignal | undefined;
    const ac = new AbortController();
    const reason = Object.assign(new Error('run exceeded the maximum duration'), { code: 'MAX_RUN_EXCEEDED' });
    const client = {
      async send(cmd: unknown, opts?: { abortSignal?: AbortSignal }) {
        if (!(cmd instanceof GetObjectCommand)) throw new Error('unexpected command');
        signalSeen = opts?.abortSignal;
        return new Promise((_, reject) => {
          opts?.abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })), { once: true });
        });
      },
    } as unknown as S3Client;
    const src = new S3FocusExportSource({ client, location: LOC });
    const opening = src.openArtifact({ name: 'run-1/a.csv.gz', key: DATA_KEY, byteSize: 1, version: '"d1"' }, { signal: ac.signal });
    setTimeout(() => ac.abort(reason), 20);
    await expect(opening).rejects.toBe(reason);
    expect(signalSeen).toBe(ac.signal);
  });
});

describe('S3FocusExportSource, PR #54 fourth review M2: the manifest GET is pinned to its listed ETag', () => {
  const v1 = Buffer.from('version one');
  const objects = () =>
    new Map<string, FakeObject>([
      [MANIFEST_KEY, { etag: '"m1"', size: 0, body: () => Readable.from([manifestFor([DATA_KEY])]) }],
      [DATA_KEY, { etag: '"d1"', size: v1.length, body: () => Readable.from([v1]) }],
    ]);

  it('the manifest GET carries If-Match = the listed ETag', async () => {
    const calls: Array<{ key: string; ifMatch?: string }> = [];
    const [l] = await new S3FocusExportSource({ client: fakeClient(objects(), calls), location: LOC }).listPeriods();
    expect(l.ok).toBe(true);
    expect(calls.find((c) => c.key === MANIFEST_KEY)).toEqual({ key: MANIFEST_KEY, ifMatch: '"m1"' });
  });

  it('a manifest replaced between the metadata listing and its GET: SOURCE_CHANGED (retryable), never the new bytes against the old listing', async () => {
    const objs = objects();
    const calls: Array<{ key: string; ifMatch?: string }> = [];
    const inner = fakeClient(objs, calls);
    const client = {
      async send(cmd: unknown, opts?: unknown) {
        if (cmd instanceof GetObjectCommand && cmd.input.Key === MANIFEST_KEY) {
          // Replaced by the provider just before the GET (a new run with new controls).
          objs.set(MANIFEST_KEY, { etag: '"m2"', size: 0, body: () => Readable.from([Buffer.from(JSON.stringify({ dataFiles: [DATA_KEY], 'x-ratio-control': { rowCount: 99 } }))]) });
        }
        return (inner.send as (c: unknown, o?: unknown) => Promise<unknown>)(cmd, opts);
      },
    } as unknown as S3Client;
    await expect(new S3FocusExportSource({ client, location: LOC }).listPeriods()).rejects.toMatchObject({ code: 'SOURCE_CHANGED', retryable: true });
  });

  it('a manifest listed without an ETag: the period is SOURCE_LISTING_INVALID, and the manifest is never read unconditionally', async () => {
    const objs = objects();
    objs.set(MANIFEST_KEY, { ...objs.get(MANIFEST_KEY)!, etag: '' });
    const calls: Array<{ key: string; ifMatch?: string }> = [];
    const [l] = await new S3FocusExportSource({ client: fakeClient(objs, calls), location: LOC }).listPeriods();
    expect(l).toMatchObject({ ok: false, billingPeriod: P, code: 'SOURCE_LISTING_INVALID' });
    expect(calls.filter((c) => c.key === MANIFEST_KEY)).toEqual([]);
  });
});


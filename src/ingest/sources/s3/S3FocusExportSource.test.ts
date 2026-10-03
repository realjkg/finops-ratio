// S3FocusExportSource against a FAKE S3 client (no network): bounded manifest
// reads without trusting ContentLength (Copilot H1), and conditional artifact
// reads pinned to the listed ETag (Copilot H2).
import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { S3FocusExportSource } from './S3FocusExportSource';
import { dataPrefix, periodMetadataPrefix, type ExportLocation } from './layout';

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

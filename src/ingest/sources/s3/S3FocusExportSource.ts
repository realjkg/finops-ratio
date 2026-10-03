// The one real source (D2): an AWS Data Exports FOCUS 1.0 CSV+gzip export in an
// S3-compatible bucket. Lists periods from the metadata folder, reads exactly
// one manifest per period, confines its data files to the export (layout.ts)
// and streams raw bytes. Never parses CSV itself (D6: parse the evidence copy).
import type { Readable } from 'stream';
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { IngestError } from '../../errors';
import { isTransientError } from '../../retry';
import type { ArtifactRef, FocusSource, ListOptions, PeriodListing, PeriodRange, OpenOptions } from '../types';
import {
  dataPrefix,
  isManifestKey,
  listingFingerprint,
  metadataPrefix,
  parseManifest,
  parsePeriodPrefix,
  periodInRange,
  periodMetadataPrefix,
  type ExportLocation,
  type ListingEntry,
} from './layout';

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

/** Rejects with the signal's reason (e.g. MAX_RUN_EXCEEDED) once it has aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

function isPreconditionFailed(e: unknown): boolean {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return x?.$metadata?.httpStatusCode === 412 || x?.name === 'PreconditionFailed';
}

function sourceError(code: string, what: string, e: unknown): IngestError {
  const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const name = (e as { name?: string })?.name ?? 'Error';
  return new IngestError(code, `${what} failed (${name}${status ? ` ${status}` : ''})`, { retryable: isTransientError(e), cause: e });
}

export class S3FocusExportSource implements FocusSource {
  readonly kind = 'focus_file' as const;
  private readonly client: S3Client;
  private readonly location: ExportLocation;

  constructor(opts: { client: S3Client; location: ExportLocation }) {
    this.client = opts.client;
    this.location = opts.location;
  }

  private async list(prefix: string, delimiter: string | undefined, signal: AbortSignal | undefined): Promise<{ keys: Map<string, ListingEntry>; prefixes: string[] }> {
    const keys = new Map<string, ListingEntry>();
    const prefixes: string[] = [];
    let token: string | undefined;
    do {
      throwIfAborted(signal); // between pages
      const r = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.location.bucket, Prefix: prefix, Delimiter: delimiter, ContinuationToken: token }),
        { abortSignal: signal }, // tears the in-flight request down
      );
      for (const c of r.Contents ?? []) if (c.Key) keys.set(c.Key, { size: Number(c.Size ?? 0), etag: String(c.ETag ?? '') });
      for (const p of r.CommonPrefixes ?? []) if (p.Prefix) prefixes.push(p.Prefix);
      // A page that claims more results without saying where they are is a broken
      // listing, never a complete one (review H1, third round).
      if (r.IsTruncated && !r.NextContinuationToken) {
        throw new IngestError('SOURCE_LISTING_INVALID', `listing ${prefix} claims more results but has no continuation token`);
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return { keys, prefixes };
  }

  /**
   * Reads at most `limit` bytes of an object. The body is STREAMED and the
   * read aborted (stream destroyed) as soon as more than `limit` bytes have
   * arrived — ContentLength is only an early hint, never trusted (it may be
   * missing on a chunked response, or wrong).
   */
  private async getBytes(key: string, limit: number, signal: AbortSignal | undefined): Promise<Buffer> {
    throwIfAborted(signal);
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.location.bucket, Key: key }), { abortSignal: signal });
    const body = r.Body as Readable;
    const tooLarge = () => new IngestError('MANIFEST_INVALID', 'manifest is too large');
    if (r.ContentLength !== undefined && Number(r.ContentLength) > limit) {
      body.destroy();
      throw tooLarge();
    }
    const parts: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of body) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += b.length;
        if (total > limit) throw tooLarge();
        parts.push(b);
      }
    } finally {
      if (total > limit) body.destroy();
    }
    return Buffer.concat(parts, total);
  }

  async listPeriods(range?: PeriodRange, opts: ListOptions = {}): Promise<PeriodListing[]> {
    const signal = opts.signal;
    let periods: string[];
    try {
      const top = await this.list(metadataPrefix(this.location), '/', signal);
      periods = top.prefixes
        .map((p) => parsePeriodPrefix(p, this.location))
        .filter((p): p is string => p !== null && periodInRange(p, range))
        .sort();
    } catch (e) {
      throwIfAborted(signal);
      if (e instanceof IngestError) throw e;
      throw sourceError('SOURCE_LIST_FAILED', 'listing the export metadata folder', e);
    }
    const out: PeriodListing[] = [];
    for (const period of periods) out.push(await this.listPeriod(period, signal));
    return out;
  }

  private async listPeriod(billingPeriod: string, signal: AbortSignal | undefined): Promise<PeriodListing> {
    let metaKeys: string[];
    let data: Map<string, ListingEntry>;
    try {
      metaKeys = [...(await this.list(periodMetadataPrefix(this.location, billingPeriod), undefined, signal)).keys.keys()].filter(isManifestKey).sort();
      data = (await this.list(dataPrefix(this.location, billingPeriod), undefined, signal)).keys;
    } catch (e) {
      throwIfAborted(signal);
      if (e instanceof IngestError) throw e;
      throw sourceError('SOURCE_LIST_FAILED', `listing period ${billingPeriod}`, e);
    }
    if (metaKeys.length === 0) return { ok: false, billingPeriod, code: 'MANIFEST_MISSING', message: `no manifest for ${billingPeriod}` };
    if (metaKeys.length > 1) {
      return { ok: false, billingPeriod, code: 'MANIFEST_AMBIGUOUS', message: `${metaKeys.length} manifests for ${billingPeriod}; refusing to guess which is current` };
    }
    const manifestKey = metaKeys[0];
    let bytes: Buffer;
    try {
      bytes = await this.getBytes(manifestKey, MAX_MANIFEST_BYTES, signal);
    } catch (e) {
      throwIfAborted(signal);
      if (e instanceof IngestError && e.code === 'MANIFEST_INVALID') return { ok: false, billingPeriod, code: e.code, message: e.message };
      throw sourceError('SOURCE_READ_FAILED', `reading the manifest for ${billingPeriod}`, e);
    }
    const manifest = { name: manifestKey.slice(periodMetadataPrefix(this.location, billingPeriod).length), bytes };
    const parsed = parseManifest(bytes, { location: this.location, billingPeriod, listing: data });
    if (!parsed.ok) return { ok: false, billingPeriod, code: parsed.code, message: parsed.message, manifest };
    // Every read is conditional on the listed version (If-Match): an artifact the listing
    // gives no ETag for cannot be pinned, so the period is refused (review M1, third round).
    const unversioned = parsed.artifacts.find((a) => !a.version);
    if (unversioned) {
      return { ok: false, billingPeriod, code: 'SOURCE_LISTING_INVALID', message: `artifact ${unversioned.name} has no ETag in the listing; it cannot be read conditionally`, manifest };
    }
    return {
      ok: true,
      set: {
        billingPeriod,
        artifacts: parsed.artifacts,
        ...(parsed.control ? { control: parsed.control } : {}),
        listingFingerprint: listingFingerprint(bytes, parsed.artifacts),
        manifest,
      },
    };
  }

  /**
   * Raw bytes of exactly the object version that was listed: the GET is
   * conditional on the listed ETag (If-Match). If the object was replaced
   * since the listing, S3 answers 412 and this fails SOURCE_CHANGED
   * (retryable): the pipeline re-lists the period instead of capturing bytes
   * that do not belong to the listed manifest. (Whatever is captured is hashed
   * from the bytes actually read, so the evidence sha256 always binds them.)
   */
  async openArtifact(ref: ArtifactRef, opts: OpenOptions = {}): Promise<Readable> {
    const signal = opts.signal;
    if (!ref.version) throw new IngestError('SOURCE_LISTING_INVALID', `artifact ${ref.name} has no listed version; refusing an unconditional read`);
    throwIfAborted(signal);
    try {
      // The run's abort signal tears the request down at MAX_RUN_SECONDS (review M3, third round).
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.location.bucket, Key: ref.key, IfMatch: ref.version }), { abortSignal: signal });
      return r.Body as Readable;
    } catch (e) {
      throwIfAborted(signal);
      if (isPreconditionFailed(e)) {
        throw new IngestError('SOURCE_CHANGED', `artifact ${ref.name} changed since it was listed (ETag mismatch)`, { retryable: true, cause: e });
      }
      throw sourceError('SOURCE_READ_FAILED', `reading artifact ${ref.name}`, e);
    }
  }
}

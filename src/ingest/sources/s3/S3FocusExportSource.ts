// The one real source (D2): an AWS Data Exports FOCUS 1.0 CSV+gzip export in an
// S3-compatible bucket. Lists periods from the metadata folder, reads exactly
// one manifest per period, confines its data files to the export (layout.ts)
// and streams raw bytes. Never parses CSV itself (D6: parse the evidence copy).
import type { Readable } from 'stream';
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { IngestError } from '../../errors';
import { isTransientError } from '../../retry';
import type { ArtifactRef, FocusSource, PeriodListing, PeriodRange } from '../types';
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

  private async list(prefix: string, delimiter?: string): Promise<{ keys: Map<string, ListingEntry>; prefixes: string[] }> {
    const keys = new Map<string, ListingEntry>();
    const prefixes: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.location.bucket, Prefix: prefix, Delimiter: delimiter, ContinuationToken: token }),
      );
      for (const c of r.Contents ?? []) if (c.Key) keys.set(c.Key, { size: Number(c.Size ?? 0), etag: String(c.ETag ?? '') });
      for (const p of r.CommonPrefixes ?? []) if (p.Prefix) prefixes.push(p.Prefix);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return { keys, prefixes };
  }

  private async getBytes(key: string, limit: number): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.location.bucket, Key: key }));
    if (Number(r.ContentLength ?? 0) > limit) throw new IngestError('MANIFEST_INVALID', 'manifest is too large');
    const bytes = Buffer.from(await r.Body!.transformToByteArray());
    if (bytes.length > limit) throw new IngestError('MANIFEST_INVALID', 'manifest is too large');
    return bytes;
  }

  async listPeriods(range?: PeriodRange): Promise<PeriodListing[]> {
    let periods: string[];
    try {
      const top = await this.list(metadataPrefix(this.location), '/');
      periods = top.prefixes
        .map((p) => parsePeriodPrefix(p, this.location))
        .filter((p): p is string => p !== null && periodInRange(p, range))
        .sort();
    } catch (e) {
      throw sourceError('SOURCE_LIST_FAILED', 'listing the export metadata folder', e);
    }
    const out: PeriodListing[] = [];
    for (const period of periods) out.push(await this.listPeriod(period));
    return out;
  }

  private async listPeriod(billingPeriod: string): Promise<PeriodListing> {
    let metaKeys: string[];
    let data: Map<string, ListingEntry>;
    try {
      metaKeys = [...(await this.list(periodMetadataPrefix(this.location, billingPeriod))).keys.keys()].filter(isManifestKey).sort();
      data = (await this.list(dataPrefix(this.location, billingPeriod))).keys;
    } catch (e) {
      throw sourceError('SOURCE_LIST_FAILED', `listing period ${billingPeriod}`, e);
    }
    if (metaKeys.length === 0) return { ok: false, billingPeriod, code: 'MANIFEST_MISSING', message: `no manifest for ${billingPeriod}` };
    if (metaKeys.length > 1) {
      return { ok: false, billingPeriod, code: 'MANIFEST_AMBIGUOUS', message: `${metaKeys.length} manifests for ${billingPeriod}; refusing to guess which is current` };
    }
    const manifestKey = metaKeys[0];
    let bytes: Buffer;
    try {
      bytes = await this.getBytes(manifestKey, MAX_MANIFEST_BYTES);
    } catch (e) {
      if (e instanceof IngestError && e.code === 'MANIFEST_INVALID') return { ok: false, billingPeriod, code: e.code, message: e.message };
      throw sourceError('SOURCE_READ_FAILED', `reading the manifest for ${billingPeriod}`, e);
    }
    const manifest = { name: manifestKey.slice(periodMetadataPrefix(this.location, billingPeriod).length), bytes };
    const parsed = parseManifest(bytes, { location: this.location, billingPeriod, listing: data });
    if (!parsed.ok) return { ok: false, billingPeriod, code: parsed.code, message: parsed.message, manifest };
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

  async openArtifact(ref: ArtifactRef): Promise<Readable> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.location.bucket, Key: ref.key }));
      return r.Body as Readable;
    } catch (e) {
      throw sourceError('SOURCE_READ_FAILED', `reading artifact ${ref.name}`, e);
    }
  }
}

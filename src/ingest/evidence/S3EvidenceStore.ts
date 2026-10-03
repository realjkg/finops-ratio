// Evidence bucket (D6) on any S3-compatible store. Content-addressed keys make
// re-puts idempotent; an existing object with a different size is a conflict
// (fail loudly). No delete code exists here by design (retention, D6).
import crypto from 'crypto';
import fs from 'fs';
import { Writable, type Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { IngestError } from '../errors';
import { isTransientError } from '../retry';
import { idleWatchdog } from '../stall';
import type { EvidenceStore, EvidenceWriteOptions } from './types';

/** User metadata carrying the object's sha256 (a claim, not proof: see put()). */
const SHA_META = 'ratio-sha256';

function evidenceError(what: string, e: unknown): IngestError {
  if (e instanceof IngestError) return e;
  const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const name = (e as { name?: string })?.name ?? 'Error';
  return new IngestError('EVIDENCE_STORE_FAILED', `${what} failed (${name}${status ? ` ${status}` : ''})`, { retryable: isTransientError(e), cause: e });
}

export class S3EvidenceStore implements EvidenceStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  /** `prefix` (optional) places the content-addressed keys under a folder of a shared bucket. */
  constructor(opts: { client: S3Client; bucket: string; prefix?: string }) {
    this.client = opts.client;
    this.bucket = opts.bucket;
    this.prefix = opts.prefix ? `${opts.prefix.replace(/\/+$/, '')}/` : '';
  }

  private k(key: string): string {
    return this.prefix + key;
  }

  private async head(key: string, signal: AbortSignal | undefined): Promise<{ size: number; sha256: string | null } | null> {
    if (signal?.aborted) throw signal.reason;
    try {
      const h = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }), { abortSignal: signal });
      return { size: Number(h.ContentLength ?? 0), sha256: h.Metadata?.[SHA_META] ?? null };
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (status === 404 || (e as { name?: string })?.name === 'NotFound') return null;
      throw evidenceError('checking an evidence object', e);
    }
  }

  /**
   * An object already stored under `key` is only accepted if its BYTES hash to
   * `sha256` — never on size alone (a same-size corrupted or pre-seeded object
   * would otherwise stand in for the evidence). It is streamed and hashed (the
   * S3 ETag is not a content hash for multipart uploads); a mismatch fails
   * visibly and nothing is overwritten (review M1, fourth round).
   */
  private async verifyExisting(key: string, sha256: string, opts: EvidenceWriteOptions): Promise<void> {
    const { signal, onProgress, stallMs } = opts;
    const h = crypto.createHash('sha256');
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }), { abortSignal: signal });
      // A long re-hash feeds run progress (the lease keeps renewing while bytes flow) and runs
      // under the same idle watchdog as the load: a source of bytes that goes silent is
      // EVIDENCE_STALLED, an aborted run ends it with the abort reason (challenger round 3 L1).
      const sink = new Writable({
        write(chunk: Buffer, _enc, cb) {
          h.update(chunk);
          if (!stallMs) onProgress?.(); // with a watchdog, its data callback feeds progress
          cb();
        },
      });
      if (stallMs) {
        const watchdog = idleWatchdog(stallMs, 'EVIDENCE_STALLED', 'verifying the existing evidence copy', () => onProgress?.(), signal);
        await pipeline(r.Body as Readable, watchdog.stream, sink);
      } else {
        await pipeline(r.Body as Readable, sink);
      }
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      throw evidenceError('verifying an existing evidence object', e);
    }
    if (h.digest('hex') !== sha256) {
      throw new IngestError('EVIDENCE_INTEGRITY_MISMATCH', 'an evidence object with this key exists but its bytes do not match the expected sha256; it was not overwritten');
    }
  }

  /**
   * Artifact evidence. An existing object is accepted without reading it back
   * only when HEAD shows the expected size AND the expected ratio-sha256
   * metadata (challenger round 3 L2). Metadata is a claim, not proof — it can
   * be copied onto forged bytes — so this fast path is safe only because every
   * artifact a NEW batch references is re-hashed at load (loadArtifact, all
   * formats) before anything is staged as published or quarantined; an
   * unchanged/superseded outcome makes no new claim about the object. Missing
   * or different metadata: the full re-hash runs.
   */
  async put(key: string, filePath: string, info: { sha256: string; byteSize: number }, opts: EvidenceWriteOptions = {}): Promise<'stored' | 'exists'> {
    const signal = opts.signal;
    const existing = await this.head(key, signal);
    if (existing !== null) {
      if (existing.size !== info.byteSize) throw new IngestError('EVIDENCE_CONFLICT', 'an evidence object with this key but a different size exists');
      if (existing.sha256 === info.sha256) return 'exists';
      await this.verifyExisting(key, info.sha256, opts);
      return 'exists';
    }
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.k(key),
          Body: fs.createReadStream(filePath),
          ContentLength: info.byteSize,
          ContentType: 'application/octet-stream',
          Metadata: { [SHA_META]: info.sha256 },
        }),
        { abortSignal: signal }, // the run's signal tears the upload down
      );
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      throw evidenceError('storing an evidence object', e);
    }
    return 'stored';
  }

  /**
   * Manifest evidence: NEVER the metadata fast path. Manifest evidence is not
   * re-read at load, so an existing object is always re-hashed here (its
   * metadata is still written, for operators).
   */
  async putBytes(key: string, bytes: Buffer, opts: EvidenceWriteOptions = {}): Promise<'stored' | 'exists'> {
    const signal = opts.signal;
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const existing = await this.head(key, signal);
    if (existing !== null) {
      if (existing.size !== bytes.length) throw new IngestError('EVIDENCE_CONFLICT', 'an evidence object with this key but a different size exists');
      await this.verifyExisting(key, sha256, opts);
      return 'exists';
    }
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.k(key), Body: bytes, ContentType: 'application/octet-stream', Metadata: { [SHA_META]: sha256 } }), {
        abortSignal: signal,
      });
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      throw evidenceError('storing an evidence object', e);
    }
    return 'stored';
  }

  async open(key: string, opts: { signal?: AbortSignal } = {}): Promise<Readable> {
    const signal = opts.signal;
    if (signal?.aborted) throw signal.reason;
    try {
      // The run's abort signal tears the request down at MAX_RUN_SECONDS (review M5, third round).
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }), { abortSignal: signal });
      return r.Body as Readable;
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      throw evidenceError('reading an evidence object', e);
    }
  }
}

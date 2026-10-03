// Evidence bucket (D6) on any S3-compatible store. Content-addressed keys make
// re-puts idempotent; an existing object with a different size is a conflict
// (fail loudly). No delete code exists here by design (retention, D6).
import fs from 'fs';
import type { Readable } from 'stream';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { IngestError } from '../errors';
import { isTransientError } from '../retry';
import type { EvidenceStore } from './types';

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

  private async existingSize(key: string): Promise<number | null> {
    try {
      const h = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      return Number(h.ContentLength ?? 0);
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (status === 404 || (e as { name?: string })?.name === 'NotFound') return null;
      throw evidenceError('checking an evidence object', e);
    }
  }

  async put(key: string, filePath: string, info: { sha256: string; byteSize: number }): Promise<'stored' | 'exists'> {
    const existing = await this.existingSize(key);
    if (existing !== null) {
      if (existing !== info.byteSize) throw new IngestError('EVIDENCE_CONFLICT', 'an evidence object with this key but a different size exists');
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
          Metadata: { 'ratio-sha256': info.sha256 },
        }),
      );
    } catch (e) {
      throw evidenceError('storing an evidence object', e);
    }
    return 'stored';
  }

  async putBytes(key: string, bytes: Buffer): Promise<'stored' | 'exists'> {
    const existing = await this.existingSize(key);
    if (existing !== null) {
      if (existing !== bytes.length) throw new IngestError('EVIDENCE_CONFLICT', 'an evidence object with this key but a different size exists');
      return 'exists';
    }
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.k(key), Body: bytes, ContentType: 'application/octet-stream' }));
    } catch (e) {
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

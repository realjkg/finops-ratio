// Raw evidence first (D6): stream each source artifact to a local temp file
// while hashing (sha256) and counting bytes under a hard cap, then store it in
// the evidence bucket at its content-addressed key. The source is read exactly
// once; nothing is parsed here.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { IngestError } from '../errors';
import { isTransientError } from '../retry';
import { evidenceKey, type EvidenceStore } from '../evidence/types';
import { idleWatchdog, raceAbort, withDeadline } from '../stall';
import type { ArtifactRef, FocusSource } from '../sources/types';

export interface CapturedArtifact {
  ref: ArtifactRef;
  sha256: string;
  byteSize: number;
  evidenceKey: string;
  stored: 'stored' | 'exists';
}

export async function captureArtifact(opts: {
  source: FocusSource;
  evidence: EvidenceStore;
  ref: ArtifactRef;
  tenantId: string;
  sourceId: string;
  tmpDir: string;
  maxBytes: number;
  /** Idle limit for opening/reading the source (SOURCE_STALLED). */
  stallMs: number;
  /** Called whenever bytes arrive (keeps the lease renewing). */
  progress?: () => void;
  /** Aborts the capture (e.g. maximum run duration exceeded). */
  signal?: AbortSignal;
}): Promise<CapturedArtifact> {
  const dir = await fs.promises.mkdtemp(path.join(opts.tmpDir, 'ratio-capture-'));
  const file = path.join(dir, 'artifact');
  try {
    const hash = crypto.createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > opts.maxBytes) {
          cb(new IngestError('ARTIFACT_TOO_LARGE', `artifact ${opts.ref.name} exceeds the configured byte limit`));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    let body;
    try {
      // The run's abort signal reaches the source request (review M3, third round).
      body = await withDeadline(opts.source.openArtifact(opts.ref, { signal: opts.signal }), opts.stallMs, 'SOURCE_STALLED', `opening artifact ${opts.ref.name}`, opts.signal);
    } catch (e) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      if (e instanceof IngestError) throw e;
      throw new IngestError('SOURCE_READ_FAILED', `reading artifact ${opts.ref.name} failed`, { retryable: isTransientError(e), cause: e });
    }
    const watchdog = idleWatchdog(opts.stallMs, 'SOURCE_STALLED', `artifact ${opts.ref.name}`, () => opts.progress?.(), opts.signal);
    try {
      await pipeline(body, watchdog.stream, meter, fs.createWriteStream(file, { mode: 0o600 }));
    } catch (e) {
      body.destroy();
      if (e instanceof IngestError) throw e;
      throw new IngestError('SOURCE_READ_FAILED', `streaming artifact ${opts.ref.name} failed`, { retryable: isTransientError(e), cause: e });
    }
    const sha256 = hash.digest('hex');
    const key = evidenceKey(opts.tenantId, opts.sourceId, sha256);
    // The upload carries the run's signal, and an abort ends the wait even if the store ignores it.
    const stored = await raceAbort(opts.evidence.put(key, file, { sha256, byteSize: size }, { signal: opts.signal, onProgress: opts.progress, stallMs: opts.stallMs }), opts.signal);
    return { ref: opts.ref, sha256, byteSize: size, evidenceKey: key, stored };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Stores manifest bytes as evidence; returns the key. */
export async function captureManifest(
  evidence: EvidenceStore,
  tenantId: string,
  sourceId: string,
  bytes: Buffer,
  signal?: AbortSignal,
  watch: { onProgress?: () => void; stallMs?: number } = {},
): Promise<string> {
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const key = evidenceKey(tenantId, sourceId, sha);
  await raceAbort(evidence.putBytes(key, bytes, { signal, ...watch }), signal);
  return key;
}

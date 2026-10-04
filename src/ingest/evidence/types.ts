// Raw evidence (D6): every source artifact's original bytes are stored,
// content-addressed, BEFORE parsing; parsing reads only this copy. Evidence is
// retained — there is deliberately no delete operation in this interface.
import type { Readable } from 'stream';

export interface EvidenceWriteOptions {
  /** The run's abort signal (MAX_RUN_SECONDS). */
  signal?: AbortSignal;
  /** Called while bytes flow (verifying an existing object): keeps the lease renewing. */
  onProgress?: () => void;
  /** Idle limit while verifying an existing object (EVIDENCE_STALLED). */
  stallMs?: number;
}

export interface EvidenceStore {
  /** Stores a local file under `key`. Idempotent: 'exists' when an object of the same size is already there. */
  put(key: string, filePath: string, info: { sha256: string; byteSize: number }, opts?: EvidenceWriteOptions): Promise<'stored' | 'exists'>;
  /** Stores small in-memory bytes (manifests) under `key`; idempotent like put. */
  putBytes(key: string, bytes: Buffer, opts?: EvidenceWriteOptions): Promise<'stored' | 'exists'>;
  /** Streams an evidence object. The signal (the run's) tears the request down; it then rejects with its reason. */
  open(key: string, opts?: { signal?: AbortSignal }): Promise<Readable>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** evidence/<tenant>/<source>/<sha256> — matches the ingest_artifacts CHECK. */
export function evidenceKey(tenantId: string, sourceId: string, sha256: string): string {
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(sourceId) || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new TypeError('evidenceKey needs lower-case uuids and a hex sha256');
  }
  return `evidence/${tenantId}/${sourceId}/${sha256}`;
}

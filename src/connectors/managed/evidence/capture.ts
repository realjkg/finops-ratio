// M0b: capture of provider ORIGINALS. The exact bytes received (an object, or
// one API/query page) are stored content-addressed in the restricted evidence
// store BEFORE any normalization, with their identity and retrieval time.
// The store is the worker's EvidenceStore (src/ingest/evidence), passed in
// structurally so this module never imports src/ingest.
import { createHash } from 'crypto';
import type { CapturedOriginal, ObjectIdentity, SchemaSnapshot, VersionFacts } from './types';

export interface OriginalsStore { putBytes(key: string, bytes: Buffer): Promise<'stored' | 'exists'> }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET_PARAM_RE = /(key|token|secret|signature|sig|password|passwd|authorization|credential|sas)/i;
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** connector-originals/<tenant>/<source>/<sha256>: separate from the parsed-artifact evidence keys. */
export function originalKey(tenantId: string, sourceId: string, hash: string): string {
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(sourceId) || !/^[0-9a-f]{64}$/.test(hash)) throw new TypeError('originalKey needs lower-case uuids and a hex sha256');
  return `connector-originals/${tenantId}/${sourceId}/${hash}`;
}

/** Identity without credential material: secret-looking params are redacted, query strings dropped from endpoints. */
function safeIdentity(id: ObjectIdentity): ObjectIdentity {
  if (id.kind === 'object') return { ...id };
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(id.params)) params[k] = SECRET_PARAM_RE.test(k) ? '[redacted]' : v;
  return { ...id, endpoint: id.endpoint.split(/[?#]/)[0], params };
}

export async function captureOriginal(
  store: OriginalsStore,
  where: { tenantId: string; sourceId: string },
  bytes: Buffer,
  identity: ObjectIdentity,
  now: Date = new Date(),
): Promise<CapturedOriginal> {
  const hash = sha256(bytes);
  const key = originalKey(where.tenantId, where.sourceId, hash);
  const stored = await store.putBytes(key, bytes);
  return { sha256: hash, byteSize: bytes.length, key, identity: safeIdentity(identity), retrievedAt: now.toISOString(), stored };
}

/** Tracks a paged response: complete only for pages 0..n-1 in order whose last page has no next token. */
export class PageSequence {
  private seen: Array<{ pageIndex: number; nextPageToken?: string }> = [];
  add(p: { pageIndex: number; nextPageToken?: string }): void {
    this.seen.push({ pageIndex: p.pageIndex, nextPageToken: p.nextPageToken });
  }
  get pages(): number {
    return this.seen.length;
  }
  completion(): 'complete' | 'incomplete' {
    if (this.seen.length === 0) return 'incomplete';
    const ordered = this.seen.every((p, i) => p.pageIndex === i);
    const terminalOnlyLast = this.seen.every((p, i) => (i === this.seen.length - 1 ? !p.nextPageToken : !!p.nextPageToken));
    return ordered && terminalOnlyLast ? 'complete' : 'incomplete';
  }
}

export function observeSchema(columns: readonly string[]): SchemaSnapshot {
  return { columns: [...columns], sha256: sha256(columns.join('\n')) };
}

type VersionInput = Partial<Omit<VersionFacts, 'provider' | 'dataset' | 'mappingVersion' | 'canonicalModelVersion'>> & Pick<VersionFacts, 'provider' | 'dataset' | 'mappingVersion' | 'canonicalModelVersion'>;

/** Separate version facts; anything the source does not state is 'unknown'. */
export function versionFacts(v: VersionInput): VersionFacts {
  for (const k of ['provider', 'dataset', 'mappingVersion', 'canonicalModelVersion'] as const) {
    if (typeof v[k] !== 'string' || v[k].trim() === '') throw new TypeError(`version facts: ${k} is required (use 'unknown' only where the source does not state it)`);
  }
  const snap = v.observedSchema ?? 'unknown';
  if (snap !== 'unknown' && observeSchema(snap.columns).sha256 !== snap.sha256) throw new TypeError('version facts: observedSchema hash does not match its columns');
  const u = (x: string | undefined) => (x && x.trim() ? x : 'unknown');
  return {
    provider: v.provider, dataset: v.dataset, apiVersion: u(v.apiVersion), exportSchemaVersion: u(v.exportSchemaVersion), observedSchema: snap,
    sourceFocusVersion: u(v.sourceFocusVersion), mappingVersion: v.mappingVersion, canonicalModelVersion: v.canonicalModelVersion,
  };
}

// M0b: capture of provider ORIGINALS. The exact bytes received (an object, or
// one API/query page) are stored content-addressed in the restricted evidence
// store BEFORE any normalization, with their identity and retrieval time.
// The store is the worker's EvidenceStore (src/ingest/evidence), passed in
// structurally so this module never imports src/ingest.
import { createHash } from 'crypto';
import { hashValue, redactDeep } from './redact';
import type { CapturedOriginal, ObjectIdentity, SchemaSnapshot, VersionFacts } from './types';

export interface OriginalsStore { putBytes(key: string, bytes: Buffer): Promise<'stored' | 'exists'> }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** connector-originals/<tenant>/<source>/<sha256>: separate from the parsed-artifact evidence keys. */
export function originalKey(tenantId: string, sourceId: string, hash: string): string {
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(sourceId) || !/^[0-9a-f]{64}$/.test(hash)) throw new TypeError('originalKey needs lower-case uuids and a hex sha256');
  return `connector-originals/${tenantId}/${sourceId}/${hash}`;
}

/** Identity without credential material: params redacted by name (pagination tokens kept as a sha256), userinfo, query and fragment dropped from endpoints. */
function safeIdentity(id: ObjectIdentity): ObjectIdentity {
  if (id.kind === 'object') return { ...id };
  const { pageToken, ...rest } = id;
  return { ...rest, endpoint: id.endpoint.split(/[?#]/)[0].replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1'), params: redactDeep(id.params, { n: 0 }, { isParams: true }), ...(pageToken === undefined ? {} : { pageToken: hashValue(pageToken) }) };
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

/** Complete only for pages 0..n-1 in order, each requested with the previous page's next token, no token repeated, ending on a page without one. */
export class PageSequence {
  private seen: Array<{ pageIndex: number; requestToken?: string; nextPageToken?: string }> = [];
  add(p: { pageIndex: number; requestToken?: string; nextPageToken?: string }): void {
    this.seen.push({ pageIndex: p.pageIndex, requestToken: p.requestToken || undefined, nextPageToken: p.nextPageToken || undefined });
  }
  get pages(): number {
    return this.seen.length;
  }
  completion(): 'complete' | 'incomplete' {
    const last = this.seen.length - 1;
    const tokens = this.seen.map((p) => p.nextPageToken).filter((t) => t !== undefined);
    const chained = this.seen.every((p, i) => p.pageIndex === i && p.requestToken === this.seen[i - 1]?.nextPageToken && (i === last) === !p.nextPageToken);
    return last >= 0 && chained && new Set(tokens).size === tokens.length ? 'complete' : 'incomplete';
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

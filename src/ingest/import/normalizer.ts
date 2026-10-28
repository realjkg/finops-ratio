// R3: the "native export to FOCUS" seam. Connector rows register a normalizer
// per (sourceKind, schemaVersion) (e.g. AWS CUR 2.0, GCP BigQuery billing
// export, OCI cost reports); this row ships NONE except the pass-through for
// data that is already FOCUS. stageAndSync (importFile.ts) runs every delivery
// through exactly one normalizer and stores its mapping report with the batch
// (in the staged manifest, captured as evidence). No connector code here.
import { Readable } from 'stream';
import { IngestError } from '../errors';

/** What a normalizer did, stored with the batch: never cell values. */
export interface MappingReport {
  normalizer: string;
  sourceKind: string;
  schemaVersion: string;
  /** Native columns with no FOCUS mapping (kept out of the FOCUS-shaped output). */
  unmappedColumns: string[];
  /** FOCUS columns filled with a default, and how many rows got it. */
  defaultedFields: Array<{ column: string; rows: number; rule: string }>;
}

export interface NativeNormalizer {
  readonly sourceKind: string;
  readonly schemaVersion: string;
  /** Native bytes in, FOCUS-shaped CSV out, plus the mapping report. */
  normalize(input: Readable): Promise<{ csv: Readable; report: MappingReport }>;
}

/** Already-FOCUS data passes through unchanged (FOCUS exports, operator files). */
export const FOCUS_PASSTHROUGH: NativeNormalizer = Object.freeze({
  sourceKind: 'focus-export',
  schemaVersion: '*',
  async normalize(input: Readable) {
    return { csv: input, report: { normalizer: 'focus-passthrough', sourceKind: 'focus-export', schemaVersion: '*', unmappedColumns: [], defaultedFields: [] } };
  },
});

const registry = new Map<string, NativeNormalizer>([['focus-export', FOCUS_PASSTHROUGH]]);
const keyOf = (kind: string, version: string) => (kind === 'focus-export' ? kind : `${kind}@${version}`);

/** Registers a normalizer; a second registration for the same kind and version is refused. */
export function registerNormalizer(n: NativeNormalizer): void {
  const k = keyOf(n.sourceKind, n.schemaVersion);
  if (registry.has(k)) throw new IngestError('NORMALIZER_EXISTS', `a normalizer for ${k} is already registered`);
  registry.set(k, n);
}

/** The normalizer for a delivery; an unknown native kind is refused (never guessed). */
export function normalizerFor(sourceKind: string, schemaVersion: string): NativeNormalizer {
  const n = registry.get(keyOf(sourceKind, schemaVersion));
  if (!n) throw new IngestError('NORMALIZER_NOT_FOUND', `no normalizer is registered for ${sourceKind} ${schemaVersion}; only FOCUS data can be imported`);
  return n;
}

/** Collects a stream, refusing more than `max` bytes; a single chunk is returned without a copy (review B2). */
export async function collect(stream: Readable, max: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    n += b.length;
    if (n > max) throw new IngestError('IMPORT_TOO_LARGE', `the delivery is larger than the import cap of ${max} bytes`);
    parts.push(b);
  }
  return parts.length === 1 ? parts[0] : Buffer.concat(parts, n);
}

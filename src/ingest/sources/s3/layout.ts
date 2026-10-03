// Pure logic for the AWS Data Exports "FOCUS 1.0" CSV+gzip layout (D2):
//   <prefix>/<exportName>/data/BILLING_PERIOD=YYYY-MM/<runId>/*.csv.gz
//   <prefix>/<exportName>/metadata/BILLING_PERIOD=YYYY-MM/...Manifest.json
// The manifest's dataFiles define the artifact set. Every referenced file must
// sit inside this export's folder for the same period, in the same bucket, and
// exist in the listing — anything else is refused (confinement).
//
// NOTE: written from the public layout description; not yet verified against a
// real AWS export (manual acceptance procedure, NOT YET PERFORMED).
import crypto from 'crypto';
import { IngestError } from '../../errors';
import { isDecimalString } from '../../focus/decimal';
import { redact } from '../../redact';
import { validateBucketName } from '../../config';
import type { ArtifactRef, ArtifactSetControl, PeriodRange } from '../types';

export interface ExportLocation {
  bucket: string;
  /** May be ''. No leading/trailing slash, no '.'/'..' segments. */
  prefix: string;
  exportName: string;
}

export interface ListingEntry {
  size: number;
  etag: string;
}

const EXPORT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SEGMENT_RE = /^[A-Za-z0-9!_.*'()=-]+$/;

export function validateLocation(config: unknown): ExportLocation {
  const bad = (m: string): never => {
    throw new IngestError('SOURCE_CONFIG_INVALID', m);
  };
  if (!config || typeof config !== 'object') bad('source config must be an object');
  const c = config as Record<string, unknown>;
  if (c.layout !== 'aws-data-exports') bad('source config layout must be "aws-data-exports"');
  if (typeof c.bucket !== 'string') bad('source config bucket is required');
  try {
    validateBucketName(c.bucket as string, 'source bucket');
  } catch {
    bad('source config bucket is not a valid bucket name');
  }
  const prefix = c.prefix ?? '';
  if (typeof prefix !== 'string') bad('source config prefix must be a string');
  if ((prefix as string).length > 512) bad('source config prefix is too long');
  if (prefix !== '') {
    for (const seg of (prefix as string).split('/')) {
      if (seg === '' || seg === '.' || seg === '..' || !SEGMENT_RE.test(seg)) bad('source config prefix has an invalid segment');
    }
  }
  if (typeof c.exportName !== 'string' || !EXPORT_NAME_RE.test(c.exportName) || c.exportName === '.' || c.exportName === '..') {
    bad('source config exportName is invalid');
  }
  return { bucket: c.bucket as string, prefix: prefix as string, exportName: c.exportName as string };
}

function root(loc: ExportLocation): string {
  return loc.prefix ? `${loc.prefix}/${loc.exportName}/` : `${loc.exportName}/`;
}

export function metadataPrefix(loc: ExportLocation): string {
  return `${root(loc)}metadata/`;
}

const ym = (period: string) => period.slice(0, 7);

export function dataPrefix(loc: ExportLocation, period: string): string {
  return `${root(loc)}data/BILLING_PERIOD=${ym(period)}/`;
}

export function periodMetadataPrefix(loc: ExportLocation, period: string): string {
  return `${metadataPrefix(loc)}BILLING_PERIOD=${ym(period)}/`;
}

/** 'YYYY-MM-01' for a `.../metadata/BILLING_PERIOD=YYYY-MM/` common prefix of this export, else null. */
export function parsePeriodPrefix(commonPrefix: string, loc: ExportLocation): string | null {
  const base = metadataPrefix(loc);
  if (!commonPrefix.startsWith(base)) return null;
  const m = /^BILLING_PERIOD=(\d{4})-(0[1-9]|1[0-2])\/$/.exec(commonPrefix.slice(base.length));
  return m ? `${m[1]}-${m[2]}-01` : null;
}

export function periodInRange(period: string, range: PeriodRange | undefined): boolean {
  return !range || (period >= range.from && period <= range.to);
}

export function classifyArtifact(name: string): 'csv.gz' | 'csv' | 'unsupported' {
  const n = name.toLowerCase();
  if (n.endsWith('.csv.gz')) return 'csv.gz';
  if (n.endsWith('.csv')) return 'csv';
  return 'unsupported';
}

export function isManifestKey(key: string): boolean {
  return /Manifest\.json$/.test(key);
}

export function listingFingerprint(manifestBytes: Buffer | null, artifacts: ArtifactRef[]): string {
  const h = crypto.createHash('sha256');
  h.update('manifest:');
  h.update(manifestBytes ? crypto.createHash('sha256').update(manifestBytes).digest('hex') : 'none');
  for (const a of [...artifacts].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
    h.update(`\n${a.name}|${a.version}|${a.byteSize}`);
  }
  return h.digest('hex');
}

export type ManifestResult = { ok: true; artifacts: ArtifactRef[]; control?: ArtifactSetControl } | { ok: false; code: 'MANIFEST_INVALID'; message: string };

const MAX_FILES = 100_000;

export function parseManifest(
  bytes: Buffer,
  ctx: { location: ExportLocation; billingPeriod: string; listing: Map<string, ListingEntry> },
): ManifestResult {
  const invalid = (m: string): ManifestResult => ({ ok: false, code: 'MANIFEST_INVALID', message: redact(m).slice(0, 500) });
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch {
    return invalid('manifest is not valid JSON');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return invalid('manifest must be a JSON object');
  const d = doc as Record<string, unknown>;
  if (!Array.isArray(d.dataFiles)) return invalid('manifest has no dataFiles array');
  if (d.dataFiles.length > MAX_FILES) return invalid('manifest lists too many data files');

  const bp = d.billingPeriod as { start?: unknown } | undefined;
  if (bp !== undefined) {
    if (!bp || typeof bp !== 'object' || typeof bp.start !== 'string' || !bp.start.startsWith(ctx.billingPeriod)) {
      return invalid(`manifest billingPeriod does not match folder period ${ctx.billingPeriod}`);
    }
  }

  const base = dataPrefix(ctx.location, ctx.billingPeriod);
  const artifacts: ArtifactRef[] = [];
  const artifactRowCounts: Record<string, number> = {};
  const seen = new Set<string>();
  for (const [i, entry] of d.dataFiles.entries()) {
    let ref: unknown;
    let rows: unknown;
    if (typeof entry === 'string') ref = entry;
    else if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      ref = e.key ?? e.uri;
      rows = e.rowCount;
    }
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > 2048) return invalid(`dataFiles[${i}] is not a key or s3 URI`);
    let key = ref;
    if (ref.startsWith('s3://')) {
      const rest = ref.slice(5);
      const slash = rest.indexOf('/');
      if (slash <= 0) return invalid(`dataFiles[${i}] is not a valid s3 URI`);
      if (rest.slice(0, slash) !== ctx.location.bucket) return invalid(`dataFiles[${i}] is in another bucket`);
      key = rest.slice(slash + 1);
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
      return invalid(`dataFiles[${i}] uses an unsupported scheme`);
    }
    if (/[?#\\]/.test(key) || [...key].some((ch) => ch.charCodeAt(0) < 0x20)) return invalid(`dataFiles[${i}] contains forbidden characters`);
    if (!key.startsWith(base)) return invalid(`dataFiles[${i}] is outside this export's data folder for ${ctx.billingPeriod}`);
    const name = key.slice(base.length);
    const segs = name.split('/');
    if (segs.some((s) => s === '' || s === '.' || s === '..' || !SEGMENT_RE.test(s))) return invalid(`dataFiles[${i}] has an invalid path segment`);
    if (seen.has(key)) return invalid(`dataFiles[${i}] is listed twice`);
    seen.add(key);
    const listed = ctx.listing.get(key);
    if (!listed) return invalid(`dataFiles[${i}] does not exist in the export's data folder`);
    if (rows !== undefined) {
      if (typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 0) return invalid(`dataFiles[${i}].rowCount must be a non-negative integer`);
      artifactRowCounts[name] = rows;
    }
    artifacts.push({ name, key, byteSize: listed.size, version: listed.etag });
  }

  const control: ArtifactSetControl = {};
  const xc = d['x-ratio-control'];
  if (xc !== undefined) {
    if (!xc || typeof xc !== 'object' || Array.isArray(xc)) return invalid('x-ratio-control must be an object');
    const c = xc as Record<string, unknown>;
    if (c.rowCount !== undefined) {
      if (typeof c.rowCount !== 'number' || !Number.isSafeInteger(c.rowCount) || c.rowCount < 0) return invalid('x-ratio-control.rowCount must be a non-negative integer');
      control.rowCount = c.rowCount;
    }
    if (c.billedTotal !== undefined) {
      if (typeof c.billedTotal !== 'string' || !isDecimalString(c.billedTotal)) return invalid('x-ratio-control.billedTotal must be a decimal string');
      control.billedTotal = c.billedTotal;
    }
  }
  if (Object.keys(artifactRowCounts).length) control.artifactRowCounts = artifactRowCounts;
  return Object.keys(control).length ? { ok: true, artifacts, control } : { ok: true, artifacts };
}

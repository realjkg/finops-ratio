// M1a: AWS Data Exports FOCUS export (S3, manifest-driven) as a managed retriever. It wraps the
// durable S3FocusExportSource (one manifest per period, confinement, If-Match reads) with the
// source's own S3 client (s3ClientFromSecret) and turns every period that cannot be read into a
// specific refusal (never a silent empty period). The gzip ORIGINALS go to the runtime (evidence
// capture, then stageAndSync); this module never publishes. At staging, the registered normalizer
// decompresses, detects the FOCUS version from the header and records it apart from the declared
// table. Layout and manifest field names are NOT VERIFIED against a real AWS export
// (docs/connectors/aws.md); CUR 2.0 is M1b.
import crypto from 'crypto';
import { Readable } from 'stream';
import zlib from 'zlib';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { IngestError } from '../../../ingest/errors';
import { REQUIRED_COLUMNS } from '../../../ingest/focus/validate';
import { collect, registerNormalizer, type NativeNormalizer } from '../../../ingest/import/normalizer';
import { MAX_IMPORT_BYTES } from '../../../ingest/import/stageFile';
import { S3FocusExportSource } from '../../../ingest/sources/s3/S3FocusExportSource';
import { classifyArtifact, dataPrefix, isManifestKey, metadataPrefix, parseManifest, parsePeriodPrefix, periodMetadataPrefix, validateLocation, type ExportLocation } from '../../../ingest/sources/s3/layout';
import type { ArtifactRef, ArtifactSetControl } from '../../../ingest/sources/types';
import { ManagedError } from '../engagementSpec';
import { observeSchema, versionFacts } from '../evidence/capture';
import type { DeliveryInventory, VersionFacts } from '../evidence/types';
import type { Delivery, ManagedRetriever, ProbeStages, RetrieverFactory } from '../runtime';
import { s3ClientFromSecret } from './s3ClientFromSecret';

export const AWS_FOCUS_KIND = 'aws-focus-export';
/** Data Exports table -> FOCUS version. FOCUS_1_2_AWS per the AWS CID template; FOCUS_1_0_AWS is NOT VERIFIED. */
const TABLES = { FOCUS_1_0_AWS: '1.0', FOCUS_1_2_AWS: '1.2' } as const;
type Table = keyof typeof TABLES;
type Version = (typeof TABLES)[Table];
// FOCUS spec column additions (focus-1.x-columns.json): any of them marks a 1.1 or 1.2 header.
const ADDED_11 = ['CapacityReservationId', 'CapacityReservationStatus', 'CommitmentDiscountQuantity', 'CommitmentDiscountUnit', 'ServiceSubcategory', 'SkuMeter', 'SkuPriceDetails'];
const ADDED_12 = ['BillingAccountType', 'InvoiceId', 'PricingCurrency', 'PricingCurrencyContractedUnitPrice', 'PricingCurrencyEffectiveCost', 'PricingCurrencyListUnitPrice', 'SubAccountType'];
const PARAM_KEYS = ['bucket', 'prefix', 'exportName', 'region', 'table', 'endpoint', 'manifestSelection', 'manifestSelectionEvidence'];
const AUTH_ERRORS = new Set(['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'InvalidToken', 'TokenRefreshRequired']);
const FORMAT_HINT = 'this build reads only CSV with GZIP compression (Data Exports format TEXT_OR_CSV, compression GZIP)';
const MAX_MONTHS = 36;
const MiB = 1024 * 1024;

export interface FocusParams { location: ExportLocation; region: string; table: Table; endpoint?: string; manifestSelection: 'single' | 'latest-complete' }
interface Facts { versions: VersionFacts; inventory: DeliveryInventory; manifest: { key: string; sha256: string; selection: string }; aggregateControls: { control: 'aggregate'; proof: false } & ArtifactSetControl }
type Ref = { refuse: { code: string; message: string } } | { artifact: ArtifactRef };
interface PeriodSet { artifacts: ArtifactRef[]; control?: ArtifactSetControl; manifestKey: string; manifestBytes: Buffer }
export type AwsFocusRetriever = ManagedRetriever & { deliveryEvidence(id: string): Facts | undefined };

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const errName = (e: unknown) => String((e as { name?: unknown })?.name ?? 'Error').replace(/\W/g, '').slice(0, 64);
const errStatus = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
const coded = (e: unknown) => e instanceof ManagedError || e instanceof IngestError;

export function parseFocusParams(p: Record<string, unknown>): FocusParams {
  const bad = (m: string): never => { throw new ManagedError('PARAMS_INVALID', `params.${m}`); };
  for (const k of Object.keys(p)) if (!PARAM_KEYS.includes(k)) bad(`${k.replace(/\W/g, '?').slice(0, 40)}: unknown key`);
  if (typeof p.table !== 'string' || !Object.hasOwn(TABLES, p.table)) throw new ManagedError('TABLE_UNSUPPORTED', `params.table: must be one of ${Object.keys(TABLES).join(', ')} (the CUR 2.0 table needs its normalizer, M1b)`);
  if (typeof p.region !== 'string' || !/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/.test(p.region)) bad('region: must be an AWS region name such as us-east-1');
  let location: ExportLocation | undefined;
  try {
    location = validateLocation({ layout: 'aws-data-exports', bucket: p.bucket, prefix: p.prefix ?? '', exportName: p.exportName });
  } catch (e) {
    bad(`bucket/prefix/exportName: ${(e as Error).message.replace(/^source config /, '')}`);
  }
  const u = p.endpoint === undefined ? undefined : URL.canParse(String(p.endpoint)) ? new URL(String(p.endpoint)) : null;
  if (u === null || (u && (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))))) {
    bad('endpoint: must be an https:// origin (http:// only for a loopback test store), without credentials, path or query');
  }
  const sel = p.manifestSelection ?? 'single';
  if (sel !== 'single' && sel !== 'latest-complete') bad('manifestSelection: must be single or latest-complete');
  if (sel === 'latest-complete' && !/^sha256:[0-9a-f]{64}$/.test(String(p.manifestSelectionEvidence ?? ''))) {
    throw new ManagedError('MANIFEST_SELECTION_UNPROVEN', 'params.manifestSelection latest-complete is allowed only with params.manifestSelectionEvidence, the sha256 of the live Connector Evidence Record that proved the CREATE_NEW_REPORT manifest rule (docs/connectors/aws.md)');
  }
  return { location: location!, region: p.region as string, table: p.table as Table, ...(p.endpoint !== undefined ? { endpoint: String(p.endpoint) } : {}), manifestSelection: sel as FocusParams['manifestSelection'] };
}

/** FOCUS 1.0 by its required columns, 1.1/1.2 by any column those versions added; unknown otherwise. */
export function inspectHeader(columns: readonly string[], declared: Version): { observed: '1.0' | '1.1' | '1.2' | 'unknown'; problem?: { code: string; message: string } } {
  const has = new Set(columns);
  if (!has.has('BilledCost') && columns.some((c) => c.toLowerCase() === 'billedcost')) {
    return { observed: 'unknown', problem: { code: 'HEADER_CASE_MISMATCH', message: 'the data file header spells the FOCUS column names in another case (e.g. lower case); they are case-sensitive, so nothing of it was staged' } };
  }
  const observed = ADDED_12.some((c) => has.has(c)) ? '1.2' : ADDED_11.some((c) => has.has(c)) ? '1.1' : REQUIRED_COLUMNS.every((c) => has.has(c)) ? '1.0' : 'unknown';
  if (observed === declared) return { observed };
  return { observed, problem: { code: observed === 'unknown' ? 'FOCUS_VERSION_UNKNOWN' : 'FOCUS_VERSION_MISMATCH', message: `the data file header is ${observed === 'unknown' ? 'not a FOCUS header' : `FOCUS ${observed} by its columns`}, but the export is configured as FOCUS ${declared} (params.table); nothing of it was staged` } };
}

function headerOf(csv: Buffer): string[] {
  const start = csv[0] === 0xef && csv[1] === 0xbb && csv[2] === 0xbf ? 3 : 0;
  const nl = csv.indexOf(10, start);
  const line = csv.toString('utf8', start, Math.min(nl < 0 ? csv.length : nl, start + MiB)).replace(/\r$/, '');
  return line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.replace(/^"|"$/g, '').replaceAll('""', '"'));
}

/** CSV bytes of a data file: gzip decompressed (bounded), Parquet and ZIP refused by their magic bytes. */
function decode(raw: Buffer, max: number, partial = false): Buffer {
  const magic = raw.subarray(0, 4).toString('latin1');
  if (magic === 'PAR1' || magic === 'PK\u0003\u0004') throw new IngestError('FORMAT_UNSUPPORTED', `the data file is ${magic === 'PAR1' ? 'Parquet' : 'ZIP'}; ${FORMAT_HINT}`);
  if (raw[0] !== 0x1f || raw[1] !== 0x8b) return raw;
  try {
    return zlib.gunzipSync(raw, { maxOutputLength: max, ...(partial ? { finishFlush: zlib.constants.Z_SYNC_FLUSH } : {}) });
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') throw new IngestError('IMPORT_TOO_LARGE', `the decompressed data file is larger than the import cap of ${max} bytes`);
    throw new IngestError('IMPORT_FILE_INVALID', 'the data file could not be decompressed (corrupt gzip)');
  }
}

const factsOf = (table: Table, v: Partial<VersionFacts> = {}) =>
  versionFacts({ provider: 'AWS', dataset: table, exportSchemaVersion: TABLES[table], mappingVersion: 'aws-focus-passthrough-v1', canonicalModelVersion: 'ratio-cost-facts-focus-1.0', ...v });

/** Staging step for one FOCUS table: original (gzip) in, FOCUS CSV out; the report carries the version facts. */
export function awsFocusNormalizer(version: Version): NativeNormalizer {
  const table = (Object.keys(TABLES) as Table[]).find((t) => TABLES[t] === version)!;
  return Object.freeze({
    sourceKind: AWS_FOCUS_KIND,
    schemaVersion: version,
    async normalize(input: Readable) {
      const csv = decode(await collect(input, MAX_IMPORT_BYTES), MAX_IMPORT_BYTES);
      const columns = headerOf(csv);
      const h = inspectHeader(columns, version);
      if (h.problem) throw new IngestError(h.problem.code, h.problem.message);
      const versions = factsOf(table, { observedSchema: observeSchema(columns), sourceFocusVersion: h.observed });
      return { csv: Readable.from([csv]), report: Object.assign({ normalizer: AWS_FOCUS_KIND, sourceKind: AWS_FOCUS_KIND, schemaVersion: version, unmappedColumns: [], defaultedFields: [] }, { versions }) };
    },
  });
}
for (const v of Object.values(TABLES)) registerNormalizer(awsFocusNormalizer(v));

function monthsOf(range: { from: string; to: string }): string[] {
  const out: string[] = [];
  let [y, m] = range.from.split('-').map(Number);
  for (let ym = range.from; ym <= range.to; ym = `${y}-${String(m).padStart(2, '0')}`) {
    if (out.length === MAX_MONTHS) throw new ManagedError('RANGE_TOO_LONG', `a fetch range covers at most ${MAX_MONTHS} billing months`);
    out.push(`${ym}-01`);
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  }
  return out;
}

/** A range-less fetch reads only the periods the export has; months between the first and last that have none are named. */
function gapWarning(present: string[]): string[] {
  if (present.length < 2) return [];
  const have = new Set(present);
  const gaps = monthsOf({ from: present[0].slice(0, 7), to: present[present.length - 1].slice(0, 7) }).filter((m) => !have.has(m)).map((m) => m.slice(0, 7));
  if (!gaps.length) return [];
  const shown = gaps.slice(0, 24).join(', ');
  return [`no delivery exists for ${gaps.length} billing month(s) inside the delivered span: ${shown}${gaps.length > 24 ? `, and ${gaps.length - 24} more` : ''}; this fetch had no --from/--to, so they were not refused (give a range to get PERIOD_NOT_DELIVERED)`];
}

export function createAwsFocusRetriever(ctx: Parameters<RetrieverFactory>[0], deps: { fetch?: typeof fetch; now?: () => Date } = {}): AwsFocusRetriever {
  const p = parseFocusParams(ctx.params);
  const { client } = s3ClientFromSecret({ secret: ctx.secret, region: p.region, endpoint: p.endpoint, registerSecret: ctx.registerSecret, ...deps });
  const loc = p.location;
  const source = new S3FocusExportSource({ client, location: loc });
  const version = TABLES[p.table];
  const facts = new Map<string, Facts>();
  let warnings: string[] = [];
  const refusal = (period: string, code: string, message: string): Delivery =>
    ({ id: `aws-focus ${period.slice(0, 7)} ${code}`, billingPeriod: period, completion: 'incomplete', objects: [{ name: 'refused', ref: { refuse: { code, message } } satisfies Ref }] });

  async function list(prefix: string, delimiter?: string) {
    const keys: Array<{ key: string; etag: string; size: number; at: number }> = [];
    const prefixes: string[] = [];
    let token: string | undefined;
    do {
      const r = await client.send(new ListObjectsV2Command({ Bucket: loc.bucket, Prefix: prefix, Delimiter: delimiter, ContinuationToken: token }));
      for (const c of r.Contents ?? []) if (c.Key) keys.push({ key: c.Key, etag: String(c.ETag ?? ''), size: Number(c.Size ?? 0), at: c.LastModified?.getTime() ?? NaN });
      for (const x of r.CommonPrefixes ?? []) if (x.Prefix) prefixes.push(x.Prefix);
      if (r.IsTruncated && !r.NextContinuationToken) throw new ManagedError('SOURCE_LISTING_INVALID', 'a listing claims more results but has no continuation token');
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return { keys, prefixes };
  }

  /** Billing periods of the export's metadata folder: BILLING_PERIOD= (read) and other spellings (refused). */
  async function periods() {
    const base = metadataPrefix(loc);
    const upper = new Set<string>();
    const other = new Set<string>();
    for (const pre of (await list(base, '/')).prefixes) {
      const per = parsePeriodPrefix(pre, loc);
      const m = /^billing_period=(\d{4})-(0[1-9]|1[0-2])\/$/i.exec(pre.slice(base.length));
      if (per) upper.add(per);
      else if (m) other.add(`${m[1]}-${m[2]}-01`);
    }
    return { upper, other };
  }

  /**
   * CREATE_NEW_REPORT rule (evidence-gated): the newest manifest whose data files all exist; a tie stays ambiguous.
   * A newer manifest whose files have not landed yet is skipped (documented rule). A newer manifest that is INVALID
   * (other bucket, outside the export, malformed, ../ path, wrong period) refuses the period: the older manifest is
   * never published in its place.
   */
  async function latestComplete(period: string): Promise<PeriodSet | { code: string; message: string }> {
    const [meta, data] = await Promise.all([list(periodMetadataPrefix(loc, period)), list(dataPrefix(loc, period))]);
    const listing = new Map(data.keys.map((k) => [k.key, { size: k.size, etag: k.etag }]));
    // Parsed against a listing that has every file: what fails then is invalid, not merely not landed yet.
    const structural = new (class extends Map<string, { size: number; etag: string }> { override get() { return { size: 0, etag: '"structure-only"' }; } })();
    const complete: Array<PeriodSet & { at: number }> = [];
    const invalid: Array<{ at: number; message: string }> = [];
    for (const m of meta.keys.filter((k) => isManifestKey(k.key))) {
      const r = await client.send(new GetObjectCommand({ Bucket: loc.bucket, Key: m.key, IfMatch: m.etag }));
      const bytes = await collect(r.Body as Readable, 16 * MiB);
      const shape = parseManifest(bytes, { location: loc, billingPeriod: period, listing: structural });
      if (!shape.ok) {
        invalid.push({ at: m.at, message: shape.message });
        continue;
      }
      const parsed = parseManifest(bytes, { location: loc, billingPeriod: period, listing });
      if (parsed.ok && parsed.artifacts.every((a) => a.version) && Number.isFinite(m.at)) complete.push({ artifacts: parsed.artifacts, control: parsed.control, manifestKey: m.key, manifestBytes: bytes, at: m.at });
    }
    complete.sort((a, b) => b.at - a.at);
    const ym = period.slice(0, 7);
    // An invalid manifest that is not provably older than the chosen one blocks the period (equal or unknown time cannot be ordered).
    const blocking = invalid.find((i) => !complete.length || !(i.at < complete[0].at));
    if (blocking) return { code: 'MANIFEST_INVALID', message: `a manifest for ${ym} is invalid${complete.length ? ' and is not older than the newest complete one' : ''}, so no manifest is used and nothing was staged: ${blocking.message}` };
    if (!complete.length) return { code: 'MANIFEST_INVALID', message: `no manifest for ${ym} lists only data files that exist; nothing was staged` };
    if (complete.length > 1 && complete[1].at === complete[0].at) return { code: 'MANIFEST_AMBIGUOUS', message: `two complete manifests for ${ym} have the same LastModified; refusing to guess which is current` };
    return complete[0];
  }

  function deliveryOf(period: string, set: PeriodSet, selection: string): Delivery {
    const odd = set.artifacts.find((a) => classifyArtifact(a.name) === 'unsupported');
    if (odd) return refusal(period, 'FORMAT_UNSUPPORTED', `the manifest lists ${/\.parquet$/i.test(odd.name) ? 'Parquet' : /\.zip$/i.test(odd.name) ? 'ZIP' : 'non-CSV'} data files; ${FORMAT_HINT}`);
    const declared = /\b(FOCUS_\d_\d_AWS|COST_AND_USAGE_REPORT)\b/.exec(set.manifestBytes.toString('utf8'))?.[1];
    if (declared && declared !== p.table) return refusal(period, 'FOCUS_TABLE_MISMATCH', `the manifest names the table ${declared}, but the source is configured for ${p.table} (params.table); nothing was read`);
    const sha = sha256(set.manifestBytes);
    const id = `aws-focus ${period.slice(0, 7)} manifest-sha256:${sha} selection:${selection}`;
    facts.set(id, {
      versions: factsOf(p.table),
      inventory: { scope: `s3://${loc.bucket}/${metadataPrefix(loc).slice(0, -'metadata/'.length)}`, usageWindow: 'unknown', billingPeriod: period, extractedAt: (deps.now?.() ?? new Date()).toISOString(), filters: { table: p.table }, grouping: [], completion: 'complete', revision: `manifest-sha256:${sha}`, exclusions: [] },
      manifest: { key: set.manifestKey, sha256: sha, selection },
      aggregateControls: { control: 'aggregate', proof: false, ...set.control },
    });
    return { id, billingPeriod: period, completion: 'complete', objects: set.artifacts.map((a) => ({ name: a.name, ref: { artifact: a } satisfies Ref, size: a.byteSize })) };
  }

  async function listDeliveries(range?: { from: string; to: string }): Promise<Delivery[]> {
    warnings = [];
    try {
      const { upper, other } = await periods();
      const months = range ? monthsOf(range) : [...new Set([...upper, ...other])].sort();
      if (!months.length) throw new ManagedError('EXPORT_EMPTY', 'the export metadata folder has no BILLING_PERIOD= partition: nothing is delivered under this bucket, prefix and exportName');
      if (!range) warnings = gapWarning(months);
      const wanted = months.filter((m) => upper.has(m));
      const listed = wanted.length ? await source.listPeriods({ from: wanted[0], to: wanted[wanted.length - 1] }) : [];
      const byPeriod = new Map(listed.map((l) => [l.ok ? l.set.billingPeriod : l.billingPeriod, l]));
      const out: Delivery[] = [];
      for (const m of months) {
        const ym = m.slice(0, 7);
        const l = byPeriod.get(m);
        if (other.has(m)) out.push(refusal(m, 'LAYOUT_CASE_MISMATCH', `the partition folder for ${ym} is not spelled BILLING_PERIOD= (upper case, as this build reads it); nothing of the period was read`));
        else if (!l) out.push(refusal(m, 'PERIOD_NOT_DELIVERED', `the export has no delivery for ${ym}; nothing is published for it`));
        else if (l.ok) out.push(deliveryOf(m, { artifacts: l.set.artifacts, control: l.set.control, manifestKey: periodMetadataPrefix(loc, m) + l.set.manifest!.name, manifestBytes: l.set.manifest!.bytes }, 'single'));
        else if (l.code === 'MANIFEST_AMBIGUOUS' && p.manifestSelection === 'latest-complete') {
          const s = await latestComplete(m);
          out.push('code' in s ? refusal(m, s.code, s.message) : deliveryOf(m, s, 'latest-complete'));
        } else out.push(refusal(m, l.code, l.message));
      }
      return out;
    } catch (e) {
      if (coded(e)) throw e;
      throw new ManagedError('SOURCE_LIST_FAILED', `reading the export listing or a manifest failed (${errName(e)}${errStatus(e) ? ` ${errStatus(e)}` : ''})`);
    }
  }

  async function probe(): Promise<ProbeStages> {
    let found: Awaited<ReturnType<typeof periods>>;
    try {
      found = await periods();
    } catch (e) {
      const [name, code] = [errName(e), (e as { code?: unknown }).code];
      const auth = { ok: true, detail: 'the credential was accepted (the request was authorized against it)' };
      if (typeof code === 'string' && code.startsWith('AUTH_')) return { auth: { ok: false, code, detail: (e as Error).message } };
      if (AUTH_ERRORS.has(name)) return { auth: { ok: false, code: 'AUTH_FAILED', detail: `the credential was not accepted (${name})` } };
      if (name === 'AccessDenied' || errStatus(e) === 403) return { auth, scope: { ok: false, code: 'SCOPE_DENIED', detail: 'listing the export metadata folder was denied (s3:ListBucket on the export prefix)' } };
      return name === 'NoSuchBucket' ? { auth, scope: { ok: false, code: 'EXPORT_NOT_FOUND', detail: 'the export bucket does not exist' } } : { auth: { ok: false, code: 'PROBE_UNREACHABLE', detail: `the export bucket could not be reached (${name})` } };
    }
    const auth = { ok: true, detail: 'the credential was accepted' };
    const scope = { ok: true, detail: `listed the export metadata folder (${found.upper.size} billing periods)` };
    const latest = [...found.upper].sort().pop();
    if (!latest) return { auth, scope, data: { ok: false, code: found.other.size ? 'LAYOUT_CASE_MISMATCH' : 'EXPORT_EMPTY', detail: 'no readable BILLING_PERIOD= partition in the export' } };
    let d: Delivery;
    try {
      [d] = await listDeliveries({ from: latest.slice(0, 7), to: latest.slice(0, 7) });
    } catch (e) {
      return { auth, scope, data: { ok: false, code: coded(e) ? (e as ManagedError).code : 'SOURCE_LIST_FAILED', detail: 'reading the latest manifest failed' } };
    }
    const first = d.objects[0]?.ref as Ref | undefined;
    if (!first || 'refuse' in first) return { auth, scope, data: { ok: false, code: first ? first.refuse.code : 'DELIVERY_EMPTY', detail: first ? first.refuse.message : 'the latest manifest lists no data files' } };
    const data = { ok: true, detail: `read the manifest of ${latest.slice(0, 7)} (${d.objects.length} data files)` };
    try {
      // Only the head of one data file (a ranged GET), never a whole month.
      const r = await client.send(new GetObjectCommand({ Bucket: loc.bucket, Key: first.artifact.key, IfMatch: first.artifact.version, Range: 'bytes=0-65535' }));
      const h = inspectHeader(headerOf(decode(await collect(r.Body as Readable, 65536), 16 * MiB, true)), version);
      return { auth, scope, data, contract: h.problem ? { ok: false, code: h.problem.code, detail: h.problem.message } : { ok: true, detail: `the data header is FOCUS ${h.observed}, as configured (${p.table})` } };
    } catch (e) {
      return { auth, scope, data, contract: { ok: false, code: coded(e) ? (e as ManagedError).code : 'HEADER_UNREADABLE', detail: 'the head of the first data file could not be read' } };
    }
  }

  return {
    describe: () => ({ connector: 'aws-data-exports', sourceKind: AWS_FOCUS_KIND, schemaVersion: version, dataset: p.table }),
    probe,
    listDeliveries,
    warnings: () => [...warnings],
    async open(ref: unknown) {
      const r = ref as Ref;
      if ('refuse' in r) throw new ManagedError(r.refuse.code, r.refuse.message);
      const bytes = await collect(await source.openArtifact(r.artifact), MAX_IMPORT_BYTES);
      return { bytes, identity: { kind: 'object', bucket: loc.bucket, key: r.artifact.key, etag: r.artifact.version.replace(/^"|"$/g, '') } };
    },
    deliveryEvidence: (id) => facts.get(id),
  };
}

export const awsFocusRetriever = (ctx: Parameters<RetrieverFactory>[0]): AwsFocusRetriever => createAwsFocusRetriever(ctx);

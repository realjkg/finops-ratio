// M0a: the managed retrieval runtime. Runs ONLY in the worker (operator command
// `fetch` in src/ingest/workerCli.ts), never from a web request (boundary.test.ts).
//   retriever.listDeliveries -> open each object -> capture the ORIGINAL bytes as
//   evidence (M0b) -> stage once per complete delivery through the import pipeline
//   (stageAndSync: normalizer registry, validator, reconciliation, publish/supersede).
// The pipeline is injected (`stage`), so this module never imports src/ingest.
// Failures carry a code and never fall back to sample or simulated data. Error
// text from foreign code is replaced by fixed text (it may carry payload values);
// ManagedError text (connector-authored) is kept with secret values scrubbed.
import { ManagedError, type ManagedSpec } from './engagementSpec';
import { captureOriginal, type OriginalsStore } from './evidence/capture';
import type { CapturedOriginal, ObjectIdentity } from './evidence/types';
import { managedRegistry, type RetrieverRegistry } from './registry';
import { scrubSecrets, secretScrubTargets, type SecretValue } from './secrets/resolve';

export type StageName = 'auth' | 'scope' | 'data' | 'contract';
export type ProbeStages = Partial<Record<StageName, { ok: boolean; code?: string; detail?: string }>>;

export interface Delivery {
  id: string;
  billingPeriod?: string;
  /** complete: the provider's manifest is present and lists these objects, or every page was consumed. */
  completion: 'complete' | 'incomplete';
  objects: Array<{ name: string; ref: unknown }>;
}

export interface ManagedRetriever {
  describe(): { connector: string; sourceKind: string; schemaVersion: string; dataset: string };
  /** auth (credential accepted), scope (listing or metadata allowed), data (one object or page read), contract (schema hash = pinned). */
  probe(): Promise<ProbeStages>;
  listDeliveries(range?: { from: string; to: string }): Promise<Delivery[]>;
  open(ref: unknown): Promise<{ bytes: Buffer; identity: ObjectIdentity }>;
}

/**
 * `registerSecret`: a connector registers every secret string it derives (a session token, a signed
 * header) so it is scrubbed like the resolved secret from every result, log line and provenance.
 */
export type RetrieverFactory = (ctx: { params: Record<string, unknown>; secret?: SecretValue; registerSecret: (value: string) => void }) => ManagedRetriever;
export { ManagedError, managedSpecFrom, managedSpecFromEngagementFile, type ManagedSpec } from './engagementSpec';

/** `period` ('YYYY-MM-01') stages only the delivery's billing period. */
export interface StageRequest { objects: Array<{ name: string; bytes: Buffer }>; sourceKind: string; schemaVersion: string; period?: string; provenance: Record<string, unknown>; secrets: string[] }

export interface FetchOptions {
  tenantId: string;
  sourceKey: string;
  sourceId: string;
  /** The spec, or a function reading it (its errors become a failed result with their code). */
  spec: ManagedSpec | (() => ManagedSpec);
  /** Inclusive 'YYYY-MM' range: deliveries outside it (or without a period) are refused unopened. */
  range?: { from: string; to: string };
  registry?: RetrieverRegistry;
  resolveSecret: (ref: string) => SecretValue;
  originals: OriginalsStore;
  stage: (r: StageRequest) => Promise<{ status: string; error?: { code: string } }>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** Called with every string registered for scrubbing (the caller redacts its own output with them). */
  onSecrets?: (values: string[]) => void;
  /** Bytes one delivery may hold (all objects); larger is refused (IMPORT_TOO_LARGE) before staging. */
  maxDeliveryBytes?: number;
  now?: () => Date;
}

export interface DeliveryOutcome {
  delivery: string;
  billingPeriod?: string;
  completion: Delivery['completion'];
  originals: CapturedOriginal[];
  outcome: 'staged' | 'refused' | 'quarantined' | 'failed';
  code?: string;
  message?: string;
  result?: object;
  /** Rows of the delivery outside its billing period, which staging left out (`period` set). */
  rowsOutsidePeriod?: number;
}

export interface FetchResult {
  status: 'succeeded' | 'failed';
  connector: string;
  sourceKey: string;
  deliveries: DeliveryOutcome[];
  error?: { code: string; message: string };
  note?: string;
  /** A failed fetch that staged some deliveries first: which, and the periods they published. */
  partial?: { staged: Array<{ delivery: string; billingPeriod?: string; published: string[] }>; message: string };
}

const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])-01$/;
const codeOf = (e: unknown, fallback: string) => {
  const c = (e as { code?: unknown })?.code;
  return typeof c === 'string' && CODE_RE.test(c) ? c : fallback;
};
/** Connector- and pipeline-authored messages are kept (scrubbed); anything else is fixed text. */
const messageOf = (e: unknown, fixed: string, secrets: string[]) =>
  e instanceof Error && codeOf(e, '') !== '' ? scrubSecrets(e.message, secrets).slice(0, 500) : fixed;

/** Why a listed delivery is refused before it is opened, or null. */
function refusalOf(dl: Delivery, range: FetchOptions['range'], periodCount: Map<string, number>): { code: string; message: string } | null {
  if (!Array.isArray(dl.objects) || dl.objects.length === 0) return { code: 'DELIVERY_EMPTY', message: 'the delivery lists no objects; nothing to stage' };
  if (dl.billingPeriod !== undefined && !PERIOD_RE.test(dl.billingPeriod)) return { code: 'DELIVERY_PERIOD_INVALID', message: "the delivery's billing period is not 'YYYY-MM-01'" };
  if (dl.billingPeriod !== undefined && (periodCount.get(dl.billingPeriod) ?? 0) > 1) return { code: 'DELIVERY_PERIOD_DUPLICATE', message: 'the connector listed several deliveries for this billing period; none of them is staged' };
  if (range && dl.billingPeriod === undefined) return { code: 'DELIVERY_PERIOD_UNKNOWN', message: 'the delivery names no billing period, so it cannot be held to --from/--to' };
  if (range && dl.billingPeriod !== undefined && (dl.billingPeriod.slice(0, 7) < range.from || dl.billingPeriod.slice(0, 7) > range.to)) return { code: 'DELIVERY_OUT_OF_RANGE', message: 'the delivery is outside --from/--to; it was not opened' };
  return null;
}

/** Declared rows minus staged records, when the stage result reports both (stageAndSync does). */
function rowsLeftOut(r: object): number | undefined {
  const x = r as { files?: Array<{ dataRows?: unknown }>; staged?: Array<{ records?: unknown }> };
  if (!Array.isArray(x.files) || !Array.isArray(x.staged)) return undefined;
  const rows = x.files.reduce((n, f) => n + (typeof f.dataRows === 'number' ? f.dataRows : 0), 0);
  const staged = x.staged.reduce((n, s) => n + (typeof s.records === 'number' ? s.records : 0), 0);
  return rows - staged;
}

const publishedOf = (r: object | undefined): string[] =>
  Array.isArray((r as { periods?: unknown })?.periods)
    ? ((r as { periods: Array<{ billingPeriod?: unknown; outcome?: unknown }> }).periods).filter((p) => p.outcome === 'published' && typeof p.billingPeriod === 'string').map((p) => p.billingPeriod as string)
    : [];

export async function runManagedFetch(o: FetchOptions): Promise<FetchResult> {
  const secrets: string[] = [];
  const register = (values: string[]) => {
    const fresh = values.filter((v) => typeof v === 'string' && v.length >= 4 && !secrets.includes(v));
    if (!fresh.length) return;
    secrets.push(...fresh);
    o.onSecrets?.(fresh);
  };
  // Everything leaving this function (result, log fields, provenance) is scrubbed at its exit point.
  const log = (event: string, fields: Record<string, unknown>) => o.log?.(event, scrubSecrets(fields, secrets));
  const done = (r: FetchResult): FetchResult => scrubSecrets(r, secrets);
  const base = { connector: 'unknown', sourceKey: o.sourceKey };
  const failed = (e: unknown, fallback: string, fixed: string): FetchResult => done({ status: 'failed', ...base, deliveries: [], error: { code: codeOf(e, fallback), message: messageOf(e, fixed, secrets) } });
  let spec: ManagedSpec;
  try {
    spec = typeof o.spec === 'function' ? o.spec() : o.spec;
  } catch (e) {
    return failed(e, 'SPEC_UNAVAILABLE', 'the managed retrieval spec could not be read');
  }
  base.connector = spec.connector;
  const factory = (o.registry ?? managedRegistry).factory(spec.connector);
  if (!factory) return failed(new ManagedError('CONNECTOR_NOT_REGISTERED', `no retriever is registered for connector ${spec.connector} in this build`), '', '');
  let retriever: ManagedRetriever;
  let deliveries: Delivery[];
  let d: ReturnType<ManagedRetriever['describe']>;
  try {
    const secret = spec.secretRef ? o.resolveSecret(spec.secretRef) : undefined;
    if (secret) register(secretScrubTargets(secret.reveal()));
    retriever = factory({ params: spec.params, secret, registerSecret: (v) => register(secretScrubTargets(v)) });
    d = retriever.describe();
    deliveries = await retriever.listDeliveries(o.range);
  } catch (e) {
    return failed(e, 'RETRIEVAL_FAILED', 'the connector failed before listing deliveries');
  }
  const periodCount = new Map<string, number>();
  for (const dl of deliveries) if (dl.billingPeriod !== undefined) periodCount.set(dl.billingPeriod, (periodCount.get(dl.billingPeriod) ?? 0) + 1);
  const max = o.maxDeliveryBytes ?? Infinity;
  const outcomes: DeliveryOutcome[] = [];
  for (const dl of deliveries) {
    const out: DeliveryOutcome = { delivery: String(dl.id), ...(dl.billingPeriod !== undefined ? { billingPeriod: dl.billingPeriod } : {}), completion: dl.completion, originals: [], outcome: 'failed' };
    outcomes.push(out);
    const refused = refusalOf(dl, o.range, periodCount);
    if (refused) {
      Object.assign(out, { outcome: 'refused', ...refused });
      log('managed.delivery', { delivery: out.delivery, outcome: out.outcome, code: out.code, originals: 0 });
      continue;
    }
    const objects: StageRequest['objects'] = [];
    let bytesSoFar = 0;
    try {
      for (const obj of dl.objects) {
        const { bytes, identity } = await retriever.open(obj.ref);
        bytesSoFar += bytes.length;
        if (bytesSoFar > max) throw new ManagedError('IMPORT_TOO_LARGE', `the delivery is larger than the import cap of ${max} bytes; nothing of it was staged`);
        out.originals.push(await captureOriginal(o.originals, { tenantId: o.tenantId, sourceId: o.sourceId }, bytes, identity, o.now?.()));
        objects.push({ name: obj.name, bytes });
      }
    } catch (e) {
      const code = codeOf(e, 'RETRIEVAL_FAILED');
      Object.assign(out, { outcome: code === 'IMPORT_TOO_LARGE' ? 'refused' : 'failed', code, message: messageOf(e, 'the connector failed while retrieving this delivery', secrets) });
      log('managed.delivery', { delivery: out.delivery, outcome: out.outcome, code: out.code, originals: out.originals.length });
      continue;
    }
    if (dl.completion !== 'complete') {
      Object.assign(out, { outcome: 'quarantined', code: 'DELIVERY_INCOMPLETE', message: 'the delivery is incomplete (no manifest, or pages not all consumed); originals kept as evidence, nothing staged' });
    } else {
      try {
        const provenance = scrubSecrets({ connector: d.connector, dataset: d.dataset, delivery: out.delivery, originals: out.originals.map((c) => ({ sha256: c.sha256, key: c.key, identity: c.identity, retrievedAt: c.retrievedAt })) }, secrets);
        const r = await o.stage({ objects, sourceKind: d.sourceKind, schemaVersion: d.schemaVersion, ...(dl.billingPeriod !== undefined ? { period: dl.billingPeriod } : {}), provenance, secrets: [...secrets] });
        out.result = r;
        const left = dl.billingPeriod !== undefined ? rowsLeftOut(r) : undefined;
        if (left !== undefined && left > 0) out.rowsOutsidePeriod = left;
        if (r.status === 'succeeded') out.outcome = 'staged';
        else Object.assign(out, { outcome: r.status === 'refused' ? 'refused' : 'failed', code: r.error?.code ?? 'STAGE_FAILED' });
      } catch (e) {
        Object.assign(out, { code: codeOf(e, 'STAGE_FAILED'), message: messageOf(e, 'staging the delivery failed', secrets) });
      }
    }
    log('managed.delivery', { delivery: out.delivery, outcome: out.outcome, code: out.code ?? null, originals: out.originals.length, ...(out.rowsOutsidePeriod ? { rowsOutsidePeriod: out.rowsOutsidePeriod } : {}) });
  }
  const ok = outcomes.every((x) => x.outcome === 'staged');
  const staged = outcomes.filter((x) => x.outcome === 'staged');
  const partial = !ok && staged.length
    ? { staged: staged.map((x) => ({ delivery: x.delivery, ...(x.billingPeriod !== undefined ? { billingPeriod: x.billingPeriod } : {}), published: publishedOf(x.result) })), message: `${staged.length} of ${outcomes.length} deliveries were staged before others failed; their published periods stand (re-run fetch for the rest)` }
    : undefined;
  return done({ status: ok ? 'succeeded' : 'failed', ...base, deliveries: outcomes, ...(deliveries.length ? {} : { note: 'the connector listed no deliveries for the range' }), ...(partial ? { partial } : {}) });
}

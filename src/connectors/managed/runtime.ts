// M0a: the managed retrieval runtime. Runs ONLY in the worker (operator command
// `fetch` in src/ingest/workerCli.ts), never from a web request (boundary.test.ts).
//   retriever.listDeliveries -> open each object -> capture the ORIGINAL bytes as
//   evidence (M0b) -> stage once per complete delivery through the import pipeline
//   (stageAndSync: normalizer registry, validator, reconciliation, publish/supersede).
// The pipeline is injected (`stage`), so this module never imports src/ingest.
// Failures carry a code and never fall back to sample or simulated data. Error
// text from foreign code is replaced by fixed text (it may carry payload values);
// ManagedError text (connector-authored) is kept with secret values scrubbed.
import fs from 'fs';
import path from 'path';
import { captureOriginal, type OriginalsStore } from './evidence/capture';
import type { CapturedOriginal, ObjectIdentity } from './evidence/types';
import { managedRegistry, type RetrieverRegistry } from './registry';
import { scrubSecrets, type SecretValue } from './secrets/resolve';

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

export type RetrieverFactory = (ctx: { params: Record<string, unknown>; secret?: SecretValue }) => ManagedRetriever;
export interface ManagedSpec { connector: string; params: Record<string, unknown>; secretRef?: string }

export class ManagedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ManagedError';
  }
}

/** `period` ('YYYY-MM-01') stages only the delivery's billing period. */
export interface StageRequest { objects: Array<{ name: string; bytes: Buffer }>; sourceKind: string; schemaVersion: string; period?: string; provenance: Record<string, unknown>; secrets: string[] }

export interface FetchOptions {
  tenantId: string;
  sourceKey: string;
  sourceId: string;
  spec: ManagedSpec;
  range?: { from: string; to: string };
  registry?: RetrieverRegistry;
  resolveSecret: (ref: string) => SecretValue;
  originals: OriginalsStore;
  stage: (r: StageRequest) => Promise<{ status: string; error?: { code: string } } & Record<string, unknown>>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
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
  result?: Record<string, unknown>;
}

export interface FetchResult {
  status: 'succeeded' | 'failed';
  connector: string;
  sourceKey: string;
  deliveries: DeliveryOutcome[];
  error?: { code: string; message: string };
  note?: string;
}

const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const codeOf = (e: unknown, fallback: string) => {
  const c = (e as { code?: unknown })?.code;
  return typeof c === 'string' && CODE_RE.test(c) ? c : fallback;
};
/** Connector- and pipeline-authored messages are kept (scrubbed); anything else is fixed text. */
const messageOf = (e: unknown, fixed: string, secrets: string[]) =>
  e instanceof Error && codeOf(e, '') !== '' ? scrubSecrets(e.message, secrets).slice(0, 500) : fixed;

// A secretRef must be a NAME; a credential-looking value is refused without being echoed.
const LOOKS_LIKE_CREDENTIAL = [/-----BEGIN /, /^eyJ[\w-]{8,}\./, /(AKIA|ASIA)[A-Z0-9]{16}/, /[A-Za-z0-9+/_=-]{40,}/];

/**
 * The managed retrieval of one engagement-config source (R1 `sources[].retrieval`). The source row's
 * config jsonb cannot carry it: its CHECKs refuse keys such as secretRef and connector.
 */
export function managedSpecFrom(source: unknown): ManagedSpec {
  const r = (source as { retrieval?: Record<string, unknown> } | null)?.retrieval;
  const bad = () => new ManagedError('SOURCE_NOT_MANAGED', 'the source config has no valid managed retrieval block (kind managed, connector, optional params and secretRef)');
  if (!r || r.kind !== 'managed' || typeof r.connector !== 'string') throw bad();
  if (r.params !== undefined && (typeof r.params !== 'object' || r.params === null || Array.isArray(r.params))) throw bad();
  if (r.secretRef !== undefined && (typeof r.secretRef !== 'string' || r.secretRef.length > 128 || LOOKS_LIKE_CREDENTIAL.some((x) => x.test(r.secretRef as string)))) throw bad();
  return { connector: r.connector, params: (r.params as Record<string, unknown>) ?? {}, ...(r.secretRef ? { secretRef: r.secretRef } : {}) };
}

/** Reads RATIO_ENGAGEMENT_CONFIG (absolute, at most 1 MiB) and returns the managed retrieval of source `sourceId`. */
export function managedSpecFromEngagementFile(file: string | undefined, sourceId: string): ManagedSpec {
  const invalid = (m: string) => new ManagedError('ENGAGEMENT_CONFIG_INVALID', `RATIO_ENGAGEMENT_CONFIG: ${m}`);
  if (!file || !path.isAbsolute(file)) throw invalid('must be the absolute path of the engagement config');
  let parsed: unknown;
  try {
    if (fs.statSync(file).size > 1024 * 1024) throw invalid('file is larger than 1 MiB');
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw e instanceof ManagedError ? e : invalid('file is missing, unreadable or not valid JSON');
  }
  const sources = (parsed as { sources?: unknown } | null)?.sources;
  const found = Array.isArray(sources) ? sources.find((x) => (x as { id?: unknown })?.id === sourceId) : undefined;
  if (!found) throw new ManagedError('SOURCE_NOT_IN_ENGAGEMENT_CONFIG', `the engagement config has no source ${sourceId}`);
  return managedSpecFrom(found);
}

export async function runManagedFetch(o: FetchOptions): Promise<FetchResult> {
  const base = { connector: o.spec.connector, sourceKey: o.sourceKey };
  const secrets: string[] = [];
  const failed = (e: unknown, fallback: string, fixed: string): FetchResult => ({ status: 'failed', ...base, deliveries: [], error: { code: codeOf(e, fallback), message: messageOf(e, fixed, secrets) } });
  const factory = (o.registry ?? managedRegistry).factory(o.spec.connector);
  if (!factory) return failed(new ManagedError('CONNECTOR_NOT_REGISTERED', `no retriever is registered for connector ${o.spec.connector} in this build`), '', '');
  let retriever: ManagedRetriever;
  let deliveries: Delivery[];
  try {
    const secret = o.spec.secretRef ? o.resolveSecret(o.spec.secretRef) : undefined;
    if (secret) secrets.push(secret.reveal());
    retriever = factory({ params: o.spec.params, secret });
    deliveries = await retriever.listDeliveries(o.range);
  } catch (e) {
    return failed(e, 'RETRIEVAL_FAILED', 'the connector failed before listing deliveries');
  }
  const d = retriever.describe();
  const outcomes: DeliveryOutcome[] = [];
  for (const dl of deliveries) {
    const out: DeliveryOutcome = { delivery: dl.id, ...(dl.billingPeriod ? { billingPeriod: dl.billingPeriod } : {}), completion: dl.completion, originals: [], outcome: 'failed' };
    outcomes.push(out);
    const objects: StageRequest['objects'] = [];
    try {
      for (const obj of dl.objects) {
        const { bytes, identity } = await retriever.open(obj.ref);
        out.originals.push(await captureOriginal(o.originals, { tenantId: o.tenantId, sourceId: o.sourceId }, bytes, identity, o.now?.()));
        objects.push({ name: obj.name, bytes });
      }
    } catch (e) {
      Object.assign(out, { code: codeOf(e, 'RETRIEVAL_FAILED'), message: messageOf(e, 'the connector failed while retrieving this delivery', secrets) });
      continue;
    }
    if (dl.completion !== 'complete') {
      Object.assign(out, { outcome: 'quarantined', code: 'DELIVERY_INCOMPLETE', message: 'the delivery is incomplete (no manifest, or pages not all consumed); originals kept as evidence, nothing staged' });
      continue;
    }
    try {
      const provenance = { connector: d.connector, dataset: d.dataset, delivery: dl.id, originals: out.originals.map((c) => ({ sha256: c.sha256, key: c.key, identity: c.identity, retrievedAt: c.retrievedAt })) };
      const r = await o.stage({ objects, sourceKind: d.sourceKind, schemaVersion: d.schemaVersion, ...(dl.billingPeriod ? { period: dl.billingPeriod } : {}), provenance, secrets: [...secrets] });
      out.result = scrubSecrets(r, secrets);
      if (r.status === 'succeeded') out.outcome = 'staged';
      else Object.assign(out, { outcome: r.status === 'refused' ? 'refused' : 'failed', code: r.error?.code ?? 'STAGE_FAILED' });
    } catch (e) {
      Object.assign(out, { code: codeOf(e, 'STAGE_FAILED'), message: messageOf(e, 'staging the delivery failed', secrets) });
    }
    o.log?.('managed.delivery', { delivery: dl.id, outcome: out.outcome, code: out.code ?? null, originals: out.originals.length });
  }
  const ok = outcomes.every((x) => x.outcome === 'staged');
  return { status: ok ? 'succeeded' : 'failed', ...base, deliveries: outcomes, ...(deliveries.length ? {} : { note: 'the connector listed no deliveries for the range' }) };
}

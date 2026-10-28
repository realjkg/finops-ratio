// M0a: staged health and honest connector states for every managed connector.
// Four stages, in order: auth (credential accepted), scope (listing or metadata
// allowed), data (one manifest, object or page read), contract (schema hash
// equals the pinned one). A later stage counts only after the earlier ones
// passed. "connected" only when all four pass. Details are the connector's
// fixed text with secret values scrubbed; a throwing probe is fixed text.
import { LIVE_STATUS } from './evidence/package';
import type { ManagedRetriever, StageName } from './runtime';
import { scrubSecrets } from './secrets/resolve';

export interface StageResult { ok: boolean | null; code?: string; detail: string }
export type HealthState = 'configured-not-verified' | 'auth-verified' | 'degraded' | 'source-access-verified';
export interface HealthReport { state: HealthState; connected: boolean; stages: Record<StageName, StageResult> }

export type ConnectorState =
  | 'not-configured' | 'configured-not-verified' | 'auth-verified' | 'source-access-verified' | 'extraction-completed'
  | 'mapping-validated' | 'reconciliation-passed' | 'live-verified' | 'degraded' | 'failed' | 'simulated';

const ORDER: StageName[] = ['auth', 'scope', 'data', 'contract'];

export async function probeManaged(retriever: ManagedRetriever, opts: { secrets: readonly string[] }): Promise<HealthReport> {
  let raw: Awaited<ReturnType<ManagedRetriever['probe']>>;
  try {
    raw = await retriever.probe();
  } catch {
    raw = { auth: { ok: false, code: 'PROBE_FAILED', detail: 'the connector probe failed' } };
  }
  const stages = {} as Record<StageName, StageResult>;
  let blocked = false;
  for (const name of ORDER) {
    const s = raw[name];
    if (blocked) stages[name] = { ok: null, detail: 'not run: an earlier stage did not pass' };
    else if (!s) stages[name] = { ok: null, detail: 'not reported by the connector' };
    else stages[name] = { ok: s.ok === true, ...(s.code ? { code: s.code } : {}), detail: scrubSecrets(String(s.detail ?? (s.ok ? 'passed' : 'failed')), opts.secrets).slice(0, 300) };
    if (stages[name].ok !== true) blocked = true;
  }
  const state: HealthState =
    stages.auth.ok !== true ? 'configured-not-verified'
    : stages.scope.ok !== true ? 'auth-verified'
    : stages.data.ok === true && stages.contract.ok === true ? 'source-access-verified'
    : 'degraded';
  return { state, connected: state === 'source-access-verified', stages };
}

/** The furthest state the evidence supports; "live verified" only with a live Connector Evidence Record. */
export function connectorState(i: {
  configured: boolean;
  simulated?: boolean;
  health?: HealthReport;
  lastRun?: { status: 'succeeded' | 'failed'; extraction: 'complete' | 'incomplete'; mappingValidated: boolean; reconciled: boolean };
  /** release.status of the connector's evidence record (M0b), when one exists. */
  evidenceStatus?: string;
}): ConnectorState {
  if (i.simulated) return 'simulated';
  if (!i.configured) return 'not-configured';
  if (!i.health) return 'configured-not-verified';
  if (i.health.state !== 'source-access-verified') return i.health.state;
  if (!i.lastRun) return 'source-access-verified';
  if (i.lastRun.status === 'failed') return 'failed';
  if (i.lastRun.extraction !== 'complete') return 'source-access-verified';
  if (!i.lastRun.mappingValidated) return 'extraction-completed';
  if (!i.lastRun.reconciled) return 'mapping-validated';
  return i.evidenceStatus === LIVE_STATUS ? 'live-verified' : 'reconciliation-passed';
}

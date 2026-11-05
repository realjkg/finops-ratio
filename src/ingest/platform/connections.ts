// A1 (ADR-0001 §6): the tenant-scoped platform connections registry. Worker-only (src/ingest owns all writes).
// It EXTENDS the M0a managed-connector framework instead of duplicating it: a connection's state is whatever M0a's
// connectorState() derives from health probes, sync runs and evidence records, and its step on the owner's ladder
// (Configured -> Authorized -> Retrieved -> Validated -> Reconciled) is LADDER_FROM_MANAGED_STATE. Two rules on top:
// a step counts only when evidence refs cover it and every step before it (evidence before claims), and live
// verification is a separate flag that needs the M0a live state AND a connector evidence record (M0b). The ladder is
// never collapsed into "Connected". Every call names the tenant; the registry opens only when the owner enabled the
// platform economics capability (D7). Storage is an interface: in memory here; Postgres after draft 0020 is promoted.
import { connectorState, type ConnectorState } from '../../connectors/managed/health';
import { CONNECTION_LADDER, LADDER_FROM_MANAGED_STATE, validateConnectorDeclaration, type ConnectorDeclaration, type LadderStep } from '../../platform/contracts/connector';
import { isIsoInstant, isSha256Hex } from '../../platform/contracts/validate';
import { requireCapability, type PlatformFlags } from '../../platform/flags';

/** Storage record version of an evidence ref (the draft 0020 `schema_version` column). */
export const EVIDENCE_REF_SCHEMA = 'platform-evidence-ref/1';
/** What each kind of evidence proves: the ladder step it covers. */
export const EVIDENCE_KINDS = {
  health_probe: 'authorized', sync_run: 'retrieved', mapping_validation: 'validated', reconciliation: 'reconciled', connector_evidence_record: 'reconciled',
} as const satisfies Record<string, LadderStep>;
export type EvidenceKind = keyof typeof EVIDENCE_KINDS;

export interface EvidenceRef {
  tenantId: string;
  connectionId: string;
  refId: string;
  kind: EvidenceKind;
  /** Evidence store key or repository path: an identifier, never a URL with credentials. */
  locator: string;
  sha256: string;
  recordedAt: string;
}

type OffLadder = 'not-configured' | 'degraded' | 'failed' | 'simulated';
const STEP_LABEL: Record<LadderStep, string> = { configured: 'Configured', authorized: 'Authorized', retrieved: 'Retrieved', validated: 'Validated', reconciled: 'Reconciled' };
const OFF_LABEL: Record<OffLadder, string> = { 'not-configured': 'Not configured', degraded: 'Degraded', failed: 'Failed', simulated: 'Simulated' };

export interface LadderView {
  managedState: ConnectorState;
  /** Highest step with evidence for it and every step before it; null off the ladder. */
  step: LadderStep | null;
  reached: LadderStep[];
  /** Steps M0a reports that no evidence ref covers yet (shown, never counted). */
  unevidenced: LadderStep[];
  label: string;
  liveVerified: boolean;
}

export function ladderView(state: ConnectorState, refs: readonly EvidenceRef[] = []): LadderView {
  const claimed: LadderStep | null = LADDER_FROM_MANAGED_STATE[state];
  if (claimed === null) return { managedState: state, step: null, reached: [], unevidenced: [], label: OFF_LABEL[state as OffLadder], liveVerified: false };
  const byState = CONNECTION_LADDER.slice(0, CONNECTION_LADDER.indexOf(claimed) + 1);
  const covered = new Set<LadderStep>(['configured', ...refs.map((r) => EVIDENCE_KINDS[r.kind])]);
  const firstGap = byState.findIndex((s) => !covered.has(s));
  const reached = firstGap === -1 ? byState : byState.slice(0, firstGap);
  const step = reached[reached.length - 1];
  const liveVerified = state === 'live-verified' && step === 'reconciled' && refs.some((r) => r.kind === 'connector_evidence_record');
  return { managedState: state, step, reached, unevidenced: byState.slice(reached.length), label: STEP_LABEL[step], liveVerified };
}

export class ConnectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ConnectionError';
  }
}

const TENANT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // canonical lowercase, as R1 normalizes
const CONNECTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LOCATOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/; // the contracts' id rule: no '@', so no URL userinfo
const REF_KEYS = ['tenantId', 'connectionId', 'refId', 'kind', 'locator', 'sha256', 'recordedAt'];

/** Problems of an evidence ref, by key, never by value. */
export function evidenceRefProblems(r: unknown): string[] {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return ['evidenceRef: must be an object'];
  const o = r as Record<string, unknown>;
  const p = Object.keys(o).filter((k) => !REF_KEYS.includes(k)).map((k) => (/^\w{1,40}$/.test(k) ? `evidenceRef.${k}: unknown key` : 'evidenceRef: unknown key (not printed)'));
  const check = (k: string, ok: boolean, why: string) => { if (!ok) p.push(`evidenceRef.${k}: ${why}`); };
  const str = (k: string, re: RegExp) => typeof o[k] === 'string' && re.test(o[k] as string);
  check('tenantId', str('tenantId', TENANT_RE), 'canonical lowercase UUID');
  check('connectionId', str('connectionId', CONNECTION_ID_RE), 'connection id');
  check('refId', str('refId', TENANT_RE), 'canonical lowercase UUID');
  check('kind', typeof o.kind === 'string' && Object.prototype.hasOwnProperty.call(EVIDENCE_KINDS, o.kind), `one of ${Object.keys(EVIDENCE_KINDS).join('|')}`);
  check('locator', str('locator', LOCATOR_RE), 'evidence store key or repository path');
  check('sha256', isSha256Hex(o.sha256), 'sha256 hex');
  check('recordedAt', isIsoInstant(o.recordedAt), 'UTC instant ending in Z');
  return p;
}

export interface Connection { tenantId: string; connectionId: string; declaration: ConnectorDeclaration; managedState: ConnectorState }
/** Every method is scoped by tenant; an implementation never returns another tenant's rows. */
export interface ConnectionStore {
  get(tenantId: string, connectionId: string): Connection | undefined;
  list(tenantId: string): Connection[];
  put(c: Connection): void;
  addRef(r: EvidenceRef): void;
  refs(tenantId: string, connectionId: string): EvidenceRef[];
}

export function memoryConnectionStore(): ConnectionStore {
  const conns = new Map<string, Map<string, Connection>>();
  const refs = new Map<string, EvidenceRef[]>();
  const of = (t: string) => conns.get(t) ?? conns.set(t, new Map()).get(t)!;
  const key = (t: string, id: string) => JSON.stringify([t, id]);
  return {
    get: (t, id) => structuredClone(of(t).get(id)),
    list: (t) => [...of(t).values()].sort((a, b) => (a.connectionId < b.connectionId ? -1 : 1)).map((c) => structuredClone(c)),
    put: (c) => void of(c.tenantId).set(c.connectionId, structuredClone(c)),
    addRef: (r) => void refs.set(key(r.tenantId, r.connectionId), [...(refs.get(key(r.tenantId, r.connectionId)) ?? []), structuredClone(r)]),
    refs: (t, id) => structuredClone(refs.get(key(t, id)) ?? []),
  };
}

export interface ConnectionStatus {
  tenantId: string;
  connectionId: string;
  connectorId: string;
  category: ConnectorDeclaration['category'];
  /** The declaration's own verification status (connector-declaration/1). */
  verification: ConnectorDeclaration['verification']['status'];
  ladder: LadderView;
  evidence: EvidenceRef[];
}

export interface ConnectionsRegistry {
  register(tenantId: string, connectionId: string, declaration: unknown): ConnectionStatus;
  /** Records the M0a observation (connectorState() inputs) as the connection's managed state. */
  observe(tenantId: string, connectionId: string, input: Parameters<typeof connectorState>[0]): ConnectionStatus;
  attachEvidence(tenantId: string, ref: EvidenceRef): ConnectionStatus;
  status(tenantId: string, connectionId: string): ConnectionStatus;
  list(tenantId: string): ConnectionStatus[];
}

export function openConnectionsRegistry(flags: PlatformFlags | undefined, store: ConnectionStore): ConnectionsRegistry {
  requireCapability(flags, 'economics');
  const tenant = (t: string) => { if (typeof t !== 'string' || !TENANT_RE.test(t)) throw new ConnectionError('TENANT_INVALID', 'expected a canonical lowercase tenant UUID'); };
  const found = (t: string, id: string) => {
    tenant(t);
    const c = store.get(t, id);
    if (!c) throw new ConnectionError('NOT_FOUND', 'no such connection for this tenant');
    return c;
  };
  const view = (c: Connection): ConnectionStatus => {
    const evidence = store.refs(c.tenantId, c.connectionId);
    return { tenantId: c.tenantId, connectionId: c.connectionId, connectorId: c.declaration.connectorId, category: c.declaration.category,
      verification: c.declaration.verification.status, ladder: ladderView(c.managedState, evidence), evidence };
  };
  return {
    register(t, id, declaration) {
      tenant(t);
      if (typeof id !== 'string' || !CONNECTION_ID_RE.test(id)) throw new ConnectionError('CONNECTION_ID_INVALID', 'connection id must match [a-z0-9][a-z0-9-]*');
      const d = validateConnectorDeclaration(declaration);
      if (!d.ok) throw new ConnectionError('DECLARATION_INVALID', d.problems.slice(0, 5).join('; '));
      if (store.get(t, id)) throw new ConnectionError('DUPLICATE_CONNECTION', 'this tenant already has a connection with this id');
      const c: Connection = { tenantId: t, connectionId: id, declaration: d.value, managedState: connectorState({ configured: true }) };
      store.put(c);
      return view(c);
    },
    observe(t, id, input) {
      const c = { ...found(t, id), managedState: connectorState(input) };
      store.put(c);
      return view(c);
    },
    attachEvidence(t, ref) {
      tenant(t);
      const problems = evidenceRefProblems(ref);
      if (problems.length) throw new ConnectionError('EVIDENCE_INVALID', problems.join('; '));
      if (ref.tenantId !== t) throw new ConnectionError('TENANT_MISMATCH', 'the evidence ref names another tenant');
      const c = found(t, ref.connectionId);
      if (store.refs(t, ref.connectionId).some((r) => r.refId === ref.refId)) throw new ConnectionError('DUPLICATE_EVIDENCE', 'this evidence ref is already attached');
      store.addRef({ ...ref });
      return view(c);
    },
    status: (t, id) => view(found(t, id)),
    list(t) {
      tenant(t);
      return store.list(t).map(view);
    },
  };
}

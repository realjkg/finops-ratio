// A1 (ADR-0001 §6): the tenant-scoped connections registry. It extends M0a: states come from M0a's
// connectorState(), the ladder from LADDER_FROM_MANAGED_STATE, and a step counts only with evidence for it and every
// step before it, recorded against the observation it supports and after the latest degradation. Never "Connected".
// It opens only when the platform economics capability is on (D7), bound to the config's tenant. SYNTHETIC ids.
import { describe, expect, it } from 'vitest';
import type { ConnectorState, HealthReport } from '../../connectors/managed/health';
import { LIVE_STATUS } from '../../connectors/managed/evidence/package';
import { CONNECTION_LADDER } from '../../platform/contracts/connector';
import { connector } from '../../platform/contracts/testing/fixtures';
import { PLATFORM_OFF, PlatformDisabledError } from '../../platform/flags';
import { ConnectionError, EVIDENCE_KINDS, ladderView, memoryConnectionStore, openConnectionsRegistry, type ConnectionStore, type EvidenceRef } from './connections';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ON = { ...PLATFORM_OFF, enabled: true, economics: true };
const ALL_STATES: ConnectorState[] = ['not-configured', 'configured-not-verified', 'auth-verified', 'source-access-verified', 'extraction-completed',
  'mapping-validated', 'reconciliation-passed', 'live-verified', 'degraded', 'failed', 'simulated'];
const T1 = '2026-11-05T10:00:00Z';
const T2 = '2026-11-05T11:00:00Z';
const T3 = '2026-11-05T12:00:00Z';
let n = 0;
const ref = (tenantId: string, kind: EvidenceRef['kind'], observedAt = T1, observedState: ConnectorState = 'reconciliation-passed', connectionId = 'usage-file'): EvidenceRef => ({
  tenantId, connectionId, refId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, kind, locator: `evidence/${kind}/run-${n}.json`, sha256: 'a'.repeat(64),
  observedAt, observedState, recordedAt: observedAt,
});
const kinds = Object.keys(EVIDENCE_KINDS) as EvidenceRef['kind'][];
const allRefs = (t: string, at = T1, state: ConnectorState = 'live-verified') => kinds.map((k) => ref(t, k, at, state));
const health = (state: HealthReport['state']): HealthReport => ({ state, connected: state === 'source-access-verified', stages: { auth: { ok: true, detail: 'passed' }, scope: { ok: true, detail: 'passed' }, data: { ok: true, detail: 'passed' }, contract: { ok: true, detail: 'passed' } } });
const RUN = { status: 'succeeded' as const, extraction: 'complete' as const, mappingValidated: true, reconciled: true };
const reconciled = { configured: true, health: health('source-access-verified'), lastRun: RUN };
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code?: string }).code; } return 'NO ERROR'; };
const open = (tenantId = A, store: ConnectionStore = memoryConnectionStore()) => openConnectionsRegistry({ tenantId, platform: ON }, store);

describe('status ladder view (extends M0a)', () => {
  it('never says "Connected": each M0a state is a ladder step or shown as itself', () => {
    for (const s of ALL_STATES) expect(JSON.stringify(ladderView(s, allRefs(A))), s).not.toMatch(/connected/i);
    expect(ALL_STATES.map((s) => ladderView(s, allRefs(A)).label)).toEqual(['Not configured', 'Configured', 'Authorized', 'Authorized', 'Retrieved', 'Validated', 'Reconciled', 'Reconciled', 'Degraded', 'Failed', 'Simulated']);
    expect(ladderView('degraded', allRefs(A))).toMatchObject({ step: null, reached: [], liveVerified: false });
  });
  it('a step counts only with evidence for it and every step before it; the rest is listed as unevidenced', () => {
    expect(ladderView('reconciliation-passed')).toMatchObject({ step: 'configured', reached: ['configured'], unevidenced: ['authorized', 'retrieved', 'validated', 'reconciled'] });
    expect(ladderView('reconciliation-passed', [ref(A, 'health_probe'), ref(A, 'reconciliation')])).toMatchObject({ step: 'authorized', reached: ['configured', 'authorized'], unevidenced: ['retrieved', 'validated', 'reconciled'] });
    expect(ladderView('mapping-validated', allRefs(A))).toMatchObject({ step: 'validated', unevidenced: [] });
    expect(ladderView('auth-verified', allRefs(A))).toMatchObject({ step: 'authorized', unevidenced: [] }); // evidence never raises a step
    expect(CONNECTION_LADDER).toEqual(['configured', 'authorized', 'retrieved', 'validated', 'reconciled']);
  });
  it('live verification needs the M0a live state AND a connector evidence record; it is a separate flag, not a step', () => {
    expect(ladderView('live-verified', allRefs(A).filter((r) => r.kind !== 'connector_evidence_record'))).toMatchObject({ step: 'reconciled', liveVerified: false });
    expect(ladderView('live-verified', allRefs(A))).toMatchObject({ step: 'reconciled', liveVerified: true, label: 'Reconciled' });
    expect(ladderView('reconciliation-passed', allRefs(A)).liveVerified).toBe(false);
  });
});

describe('connections registry', () => {
  it('opens only when the platform economics capability is on (D7), for one canonical tenant from the config', () => {
    for (const platform of [undefined, PLATFORM_OFF, { ...PLATFORM_OFF, enabled: true }, { ...PLATFORM_OFF, economics: true }]) {
      expect(() => openConnectionsRegistry({ tenantId: A, platform }, memoryConnectionStore())).toThrow(PlatformDisabledError);
    }
    for (const t of ['', 'tenant-a', A.toUpperCase(), '*']) expect(code(() => open(t)), t).toBe('TENANT_INVALID');
    expect(open().tenantId).toBe(A);
  });
  it('a declaration never claims verification: only evidence can (review M1)', () => {
    const reg = open();
    for (const status of ['pre_release_validated', 'live_verified'] as const) {
      expect(code(() => reg.register('usage-file', { ...connector(), verification: { status, limitations: ['X'] } })), status).toBe('DECLARATION_OVERCLAIMS');
    }
    expect(reg.register('usage-file', connector())).toMatchObject({ verification: 'not_verified', ladder: { step: 'configured', liveVerified: false } });
    reg.observe('usage-file', { ...reconciled, evidenceStatus: LIVE_STATUS }, T1);
    for (const r of allRefs(A, T1)) reg.attachEvidence(r);
    expect(reg.status('usage-file')).toMatchObject({ verification: 'live_verified', ladder: { liveVerified: true } });
  });
  it('registers a validated declaration as Configured and follows M0a connectorState() observations', () => {
    const reg = open();
    expect(reg.register('usage-file', connector())).toMatchObject({ tenantId: A, connectionId: 'usage-file', connectorId: 'provider-a-usage-file', category: 'model_provider_usage', observedAt: null, ladder: { managedState: 'configured-not-verified', step: 'configured' } });
    expect(reg.observe('usage-file', reconciled, T1).ladder).toMatchObject({ managedState: 'reconciliation-passed', step: 'configured' });
    for (const r of kinds.filter((k) => k !== 'connector_evidence_record').map((k) => ref(A, k, T1))) reg.attachEvidence(r);
    expect(reg.status('usage-file')).toMatchObject({ observedAt: T1, staleEvidence: 0, ladder: { step: 'reconciled', liveVerified: false } });
    expect(reg.observe('usage-file', { configured: true, health: health('auth-verified') }, T2).ladder).toMatchObject({ managedState: 'auth-verified', step: 'authorized' });
  });
  it('evidence must reference the latest observation and a state that supports its step', () => {
    const reg = open();
    reg.register('usage-file', connector());
    expect(code(() => reg.attachEvidence(ref(A, 'sync_run')))).toBe('OBSERVATION_MISMATCH'); // nothing observed yet
    reg.observe('usage-file', { configured: true, health: health('auth-verified') }, T1);
    expect(code(() => reg.attachEvidence(ref(A, 'health_probe', T2, 'auth-verified')))).toBe('OBSERVATION_MISMATCH');
    expect(code(() => reg.attachEvidence(ref(A, 'health_probe', T1, 'reconciliation-passed')))).toBe('OBSERVATION_MISMATCH');
    expect(code(() => reg.attachEvidence(ref(A, 'sync_run', T1, 'auth-verified')))).toBe('EVIDENCE_STATE_MISMATCH'); // a sync run proves Retrieved
    expect(reg.attachEvidence(ref(A, 'health_probe', '2026-11-05T10:00:00.000Z', 'auth-verified')).ladder.step).toBe('authorized'); // same instant
    expect(code(() => reg.observe('usage-file', reconciled, '2026-11-05T09:59:59Z'))).toBe('OBSERVATION_OUT_OF_ORDER');
    expect(code(() => reg.observe('usage-file', reconciled, '2026-11-05T10:00:00+01:00'))).toBe('OBSERVATION_INVALID');
  });
  it('a degradation makes earlier evidence stale; after recovery the ladder is rebuilt from new evidence only (review L5)', () => {
    const reg = open();
    reg.register('usage-file', connector());
    reg.observe('usage-file', reconciled, T1);
    for (const r of kinds.filter((k) => k !== 'connector_evidence_record').map((k) => ref(A, k, T1))) reg.attachEvidence(r);
    expect(reg.status('usage-file').ladder.step).toBe('reconciled');
    expect(reg.observe('usage-file', { configured: true, health: health('degraded') }, T2)).toMatchObject({ ladder: { managedState: 'degraded', step: null, label: 'Degraded' }, staleEvidence: 4 });
    expect(reg.observe('usage-file', reconciled, T3)).toMatchObject({ ladder: { managedState: 'reconciliation-passed', step: 'configured', unevidenced: ['authorized', 'retrieved', 'validated', 'reconciled'] }, staleEvidence: 4 });
    reg.attachEvidence(ref(A, 'health_probe', T3));
    reg.attachEvidence(ref(A, 'sync_run', T3));
    expect(reg.status('usage-file')).toMatchObject({ ladder: { step: 'retrieved' }, staleEvidence: 4 });
    expect(reg.status('usage-file').evidence).toHaveLength(6); // stale refs are kept (append-only), never counted
    expect(reg.observe('usage-file', { ...reconciled, lastRun: { ...RUN, status: 'failed' } }, '2026-11-05T13:00:00Z')).toMatchObject({ ladder: { managedState: 'failed', step: null }, staleEvidence: 6 });
  });
  it('refuses an invalid declaration, a bad connection id, a duplicate and an invalid evidence ref, by key and never by value', () => {
    const reg = open();
    expect(code(() => reg.register('usage-file', { ...connector(), verification: { status: 'not_verified', limitations: [] } }))).toBe('DECLARATION_INVALID');
    expect(code(() => reg.register('Bad Id', connector()))).toBe('CONNECTION_ID_INVALID');
    reg.register('usage-file', connector());
    expect(code(() => reg.register('usage-file', connector()))).toBe('DUPLICATE_CONNECTION');
    reg.observe('usage-file', reconciled, T1);
    for (const bad of [{ locator: 'https://user:pw@host/x' }, { sha256: 'abc' }, { kind: 'connected' }, { recordedAt: '2026-11-05T10:00:00+01:00' }, { refId: 'not-a-uuid' }, { extra: 1 }, { observedState: 'degraded' }, { observedAt: 'yesterday' }]) {
      let message = '';
      try { reg.attachEvidence({ ...ref(A, 'sync_run'), ...bad } as EvidenceRef); } catch (e) { message = (e as Error).message; expect((e as ConnectionError).code).toBe('EVIDENCE_INVALID'); }
      expect(message, JSON.stringify(bad)).not.toMatch(/user:pw|abc|connected|\+01:00|not-a-uuid|yesterday/);
      expect(message).not.toBe('');
    }
    const r = ref(A, 'sync_run');
    reg.attachEvidence(r);
    expect(code(() => reg.attachEvidence(r))).toBe('DUPLICATE_EVIDENCE');
  });
});

describe('tenant isolation', () => {
  it('a registry is bound to one tenant: over a shared store, the same connection id in two tenants is two connections, never visible across', () => {
    const store = memoryConnectionStore();
    const a = open(A, store);
    const b = open(B, store);
    a.register('usage-file', connector());
    b.register('usage-file', { ...connector(), connectorId: 'provider-b-usage-file' });
    b.register('b-only', connector());
    expect(a.list().map((c) => [c.tenantId, c.connectionId, c.connectorId])).toEqual([[A, 'usage-file', 'provider-a-usage-file']]);
    expect(b.list().map((c) => c.connectionId)).toEqual(['b-only', 'usage-file']);
    expect(code(() => a.status('b-only'))).toBe('NOT_FOUND');
    expect(code(() => a.observe('b-only', { configured: false }, T1))).toBe('NOT_FOUND');
    a.observe('usage-file', reconciled, T1);
    for (const r of kinds.map((k) => ref(A, k, T1))) a.attachEvidence(r);
    expect(b.status('usage-file')).toMatchObject({ evidence: [], observedAt: null });
    expect(a.status('usage-file').evidence.every((e) => e.tenantId === A)).toBe(true);
  });
  it('a ref naming another tenant, or a connection only the other tenant has, is refused; the API takes no tenant argument (review L4)', () => {
    const store = memoryConnectionStore();
    const a = open(A, store);
    const b = open(B, store);
    a.register('usage-file', connector());
    b.register('b-only', connector());
    a.observe('usage-file', reconciled, T1);
    b.observe('b-only', reconciled, T1);
    expect(code(() => a.attachEvidence(ref(B, 'sync_run', T1, 'reconciliation-passed', 'b-only')))).toBe('TENANT_MISMATCH');
    expect(code(() => a.attachEvidence(ref(A, 'sync_run', T1, 'reconciliation-passed', 'b-only')))).toBe('NOT_FOUND');
    expect(b.status('b-only').evidence).toEqual([]);
    expect(a.register.length).toBe(2); // (connectionId, declaration): the tenant comes from the config at open time
  });
  it('results are copies, so a caller cannot reach into the store', () => {
    const reg = open();
    reg.register('usage-file', connector());
    reg.observe('usage-file', reconciled, T1);
    const kept = ref(A, 'health_probe');
    reg.attachEvidence(kept);
    const s = reg.status('usage-file');
    s.evidence.push(ref(A, 'sync_run'));
    s.evidence[0].locator = 'evidence/tampered.json';
    (s as { tenantId: string }).tenantId = B;
    expect(reg.status('usage-file')).toMatchObject({ tenantId: A, evidence: [kept] });
    expect(open(B, memoryConnectionStore()).list()).toEqual([]);
  });
});

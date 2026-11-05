// A1 (ADR-0001 §6): the tenant-scoped connections registry. It extends M0a: states come from M0a's
// connectorState(), the ladder from LADDER_FROM_MANAGED_STATE, and a step counts only with evidence for it and every
// step before it. Never "Connected". It opens only when the platform economics capability is on (D7). SYNTHETIC ids.
import { describe, expect, it } from 'vitest';
import type { ConnectorState, HealthReport } from '../../connectors/managed/health';
import { LIVE_STATUS } from '../../connectors/managed/evidence/package';
import { CONNECTION_LADDER } from '../../platform/contracts/connector';
import { connector } from '../../platform/contracts/testing/fixtures';
import { PLATFORM_OFF, PlatformDisabledError } from '../../platform/flags';
import { ConnectionError, EVIDENCE_KINDS, ladderView, memoryConnectionStore, openConnectionsRegistry, type EvidenceRef } from './connections';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ON = { ...PLATFORM_OFF, enabled: true, economics: true };
const ALL_STATES: ConnectorState[] = ['not-configured', 'configured-not-verified', 'auth-verified', 'source-access-verified', 'extraction-completed',
  'mapping-validated', 'reconciliation-passed', 'live-verified', 'degraded', 'failed', 'simulated'];
const sha = (c: string) => c.repeat(64);
let n = 0;
const ref = (tenantId: string, kind: EvidenceRef['kind'], connectionId = 'usage-file'): EvidenceRef => ({
  tenantId, connectionId, refId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, kind, locator: `evidence/${kind}/run-${n}.json`, sha256: sha('a'), recordedAt: '2026-11-05T10:00:00Z',
});
const allRefs = (t: string) => (Object.keys(EVIDENCE_KINDS) as EvidenceRef['kind'][]).map((k) => ref(t, k));
const health = (state: HealthReport['state']): HealthReport => ({ state, connected: state === 'source-access-verified', stages: { auth: { ok: true, detail: 'passed' }, scope: { ok: true, detail: 'passed' }, data: { ok: true, detail: 'passed' }, contract: { ok: true, detail: 'passed' } } });
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code?: string }).code; } return 'NO ERROR'; };

describe('status ladder view (extends M0a)', () => {
  it('never says "Connected": each M0a state is a ladder step or shown as itself', () => {
    for (const s of ALL_STATES) {
      const v = ladderView(s, allRefs(A));
      expect(JSON.stringify(v), s).not.toMatch(/connected/i);
    }
    expect(ALL_STATES.map((s) => ladderView(s, allRefs(A)).label)).toEqual(['Not configured', 'Configured', 'Authorized', 'Authorized', 'Retrieved', 'Validated', 'Reconciled', 'Reconciled', 'Degraded', 'Failed', 'Simulated']);
    expect(ladderView('degraded', allRefs(A))).toMatchObject({ step: null, reached: [], liveVerified: false });
  });
  it('a step counts only with evidence for it and every step before it; the rest is listed as unevidenced', () => {
    expect(ladderView('reconciliation-passed')).toMatchObject({ step: 'configured', reached: ['configured'], unevidenced: ['authorized', 'retrieved', 'validated', 'reconciled'] });
    const some = [ref(A, 'health_probe'), ref(A, 'reconciliation')];
    expect(ladderView('reconciliation-passed', some)).toMatchObject({ step: 'authorized', reached: ['configured', 'authorized'], unevidenced: ['retrieved', 'validated', 'reconciled'], label: 'Authorized' });
    expect(ladderView('mapping-validated', allRefs(A))).toMatchObject({ step: 'validated', reached: ['configured', 'authorized', 'retrieved', 'validated'], unevidenced: [] });
    // Evidence never raises a step above what M0a observed.
    expect(ladderView('auth-verified', allRefs(A))).toMatchObject({ step: 'authorized', unevidenced: [] });
    expect(CONNECTION_LADDER).toEqual(['configured', 'authorized', 'retrieved', 'validated', 'reconciled']);
  });
  it('live verification needs the M0a live state AND a connector evidence record; it is a separate flag, not a step', () => {
    const withoutRecord = allRefs(A).filter((r) => r.kind !== 'connector_evidence_record');
    expect(ladderView('live-verified', withoutRecord)).toMatchObject({ step: 'reconciled', liveVerified: false });
    expect(ladderView('live-verified', allRefs(A))).toMatchObject({ step: 'reconciled', liveVerified: true, label: 'Reconciled' });
    expect(ladderView('reconciliation-passed', allRefs(A)).liveVerified).toBe(false);
  });
});

describe('connections registry', () => {
  it('opens only when the platform economics capability is on (D7); off by default', () => {
    for (const flags of [undefined, PLATFORM_OFF, { ...PLATFORM_OFF, enabled: true }, { ...PLATFORM_OFF, economics: true }]) {
      expect(() => openConnectionsRegistry(flags, memoryConnectionStore())).toThrow(PlatformDisabledError);
    }
    expect(() => openConnectionsRegistry(ON, memoryConnectionStore())).not.toThrow();
  });
  it('registers a validated declaration as Configured and follows M0a connectorState() observations', () => {
    const reg = openConnectionsRegistry(ON, memoryConnectionStore());
    expect(reg.register(A, 'usage-file', connector())).toMatchObject({ tenantId: A, connectionId: 'usage-file', connectorId: 'provider-a-usage-file', category: 'model_provider_usage', verification: 'not_verified', ladder: { managedState: 'configured-not-verified', step: 'configured' } });
    for (const r of allRefs(A)) reg.attachEvidence(A, r);
    const run = { status: 'succeeded' as const, extraction: 'complete' as const, mappingValidated: true, reconciled: true };
    expect(reg.observe(A, 'usage-file', { configured: true, health: health('source-access-verified'), lastRun: run }).ladder).toMatchObject({ managedState: 'reconciliation-passed', step: 'reconciled', liveVerified: false });
    expect(reg.observe(A, 'usage-file', { configured: true, health: health('source-access-verified'), lastRun: run, evidenceStatus: LIVE_STATUS }).ladder).toMatchObject({ managedState: 'live-verified', liveVerified: true });
    expect(reg.observe(A, 'usage-file', { configured: true, health: health('degraded') }).ladder).toMatchObject({ managedState: 'degraded', step: null, label: 'Degraded' });
    expect(reg.status(A, 'usage-file').evidence).toHaveLength(Object.keys(EVIDENCE_KINDS).length);
  });
  it('refuses an invalid declaration, a bad connection id, a duplicate and an invalid evidence ref, by key and never by value', () => {
    const reg = openConnectionsRegistry(ON, memoryConnectionStore());
    expect(code(() => reg.register(A, 'usage-file', { ...connector(), verification: { status: 'pre_release_validated', limitations: [] } }))).toBe('DECLARATION_INVALID');
    expect(code(() => reg.register(A, 'Bad Id', connector()))).toBe('CONNECTION_ID_INVALID');
    reg.register(A, 'usage-file', connector());
    expect(code(() => reg.register(A, 'usage-file', connector()))).toBe('DUPLICATE_CONNECTION');
    for (const bad of [{ locator: 'https://user:pw@host/x' }, { sha256: 'abc' }, { kind: 'connected' }, { recordedAt: '2026-11-05T10:00:00+01:00' }, { refId: 'not-a-uuid' }, { extra: 1 }]) {
      let message = '';
      try { reg.attachEvidence(A, { ...ref(A, 'sync_run'), ...bad } as EvidenceRef); } catch (e) { message = (e as Error).message; expect((e as ConnectionError).code).toBe('EVIDENCE_INVALID'); }
      expect(message, JSON.stringify(bad)).not.toMatch(/user:pw|abc|connected|\+01:00|not-a-uuid/);
      expect(message).not.toBe('');
    }
    const r = ref(A, 'sync_run');
    reg.attachEvidence(A, r);
    expect(code(() => reg.attachEvidence(A, r))).toBe('DUPLICATE_EVIDENCE');
  });
});

describe('tenant isolation', () => {
  it('the same connection id in two tenants is two connections; a tenant never reads, lists or changes the other\'s', () => {
    const store = memoryConnectionStore();
    const reg = openConnectionsRegistry(ON, store);
    reg.register(A, 'usage-file', connector());
    reg.register(B, 'usage-file', { ...connector(), connectorId: 'provider-b-usage-file' });
    reg.register(B, 'b-only', connector());
    expect(reg.list(A).map((c) => [c.tenantId, c.connectionId, c.connectorId])).toEqual([[A, 'usage-file', 'provider-a-usage-file']]);
    expect(reg.list(B).map((c) => c.connectionId)).toEqual(['b-only', 'usage-file']);
    expect(code(() => reg.status(A, 'b-only'))).toBe('NOT_FOUND');
    expect(code(() => reg.observe(A, 'b-only', { configured: false }))).toBe('NOT_FOUND');
    expect(reg.status(B, 'b-only').ladder.managedState).toBe('configured-not-verified');
    for (const r of allRefs(A)) reg.attachEvidence(A, r);
    expect(reg.status(B, 'usage-file').evidence).toEqual([]);
    expect(reg.status(A, 'usage-file').evidence.every((e) => e.tenantId === A)).toBe(true);
  });
  it('evidence for another tenant, or for a connection the tenant does not have, is refused', () => {
    const reg = openConnectionsRegistry(ON, memoryConnectionStore());
    reg.register(A, 'usage-file', connector());
    reg.register(B, 'b-only', connector());
    expect(code(() => reg.attachEvidence(A, ref(B, 'sync_run')))).toBe('TENANT_MISMATCH');
    expect(code(() => reg.attachEvidence(A, ref(A, 'sync_run', 'b-only')))).toBe('NOT_FOUND');
    expect(reg.status(B, 'b-only').evidence).toEqual([]);
  });
  it('every call needs a canonical tenant UUID; results are copies, so a caller cannot reach into the store', () => {
    const reg = openConnectionsRegistry(ON, memoryConnectionStore());
    for (const t of ['', 'tenant-a', A.toUpperCase() + 'x', '*']) {
      expect(code(() => reg.register(t, 'usage-file', connector())), t).toBe('TENANT_INVALID');
      expect(code(() => reg.list(t)), t).toBe('TENANT_INVALID');
    }
    reg.register(A, 'usage-file', connector());
    const kept = ref(A, 'health_probe');
    reg.attachEvidence(A, kept);
    const s = reg.status(A, 'usage-file');
    s.evidence.push(ref(A, 'sync_run'));
    s.evidence[0].locator = 'evidence/tampered.json';
    (s as { tenantId: string }).tenantId = B;
    expect(reg.status(A, 'usage-file')).toMatchObject({ tenantId: A, evidence: [kept] });
    expect(reg.list(B)).toEqual([]);
  });
});

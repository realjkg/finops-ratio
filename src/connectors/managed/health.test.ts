// M0a: four-stage health (auth, scope, data, contract) and the honest connector
// state ladder. "connected" only when all four pass; a later stage counts only
// after the earlier ones passed; "live verified" only with a live evidence record.
import { describe, expect, it } from 'vitest';
import { LIVE_STATUS, PRE_ROLLOUT_STATUS } from './evidence/package';
import { connectorState, probeManaged, type HealthReport } from './health';
import type { ManagedRetriever, ProbeStages } from './runtime';

const SECRET = 'SYNTHETIC-token-abcdef';
const retriever = (stages: ProbeStages | (() => Promise<ProbeStages>)): ManagedRetriever => ({
  describe: () => ({ connector: 'fake', sourceKind: 'focus-export', schemaVersion: '1.0', dataset: 'SYNTHETIC' }),
  probe: typeof stages === 'function' ? stages : async () => stages,
  listDeliveries: async () => [],
  open: async () => {
    throw new Error('not used');
  },
});
const pass = { ok: true, detail: 'ok' } as const;

describe('probeManaged', () => {
  it('token OK plus listing 403: scope false, auth-verified, not connected', async () => {
    const r = await probeManaged(retriever({ auth: pass, scope: { ok: false, code: 'HTTP_403', detail: 'listing refused' }, data: pass, contract: pass }), { secrets: [] });
    expect(r.connected).toBe(false);
    expect(r.state).toBe('auth-verified');
    expect(r.stages.scope).toEqual({ ok: false, code: 'HTTP_403', detail: 'listing refused' });
    // Later stages never count after a failed one, whatever the retriever claims.
    expect(r.stages.data).toEqual({ ok: null, detail: 'not run: an earlier stage did not pass' });
    expect(r.stages.contract.ok).toBeNull();
  });

  it('all four stages: source-access-verified and connected', async () => {
    const r = await probeManaged(retriever({ auth: pass, scope: pass, data: pass, contract: pass }), { secrets: [] });
    expect(r).toMatchObject({ state: 'source-access-verified', connected: true });
  });

  it('data or contract failing is degraded; auth failing or a missing stage is configured-not-verified / not run', async () => {
    expect((await probeManaged(retriever({ auth: pass, scope: pass, data: { ok: false, code: 'NO_DATA' }, contract: pass }), { secrets: [] })).state).toBe('degraded');
    const c = await probeManaged(retriever({ auth: pass, scope: pass, data: pass, contract: { ok: false, code: 'SCHEMA_CHANGED' } }), { secrets: [] });
    expect(c).toMatchObject({ state: 'degraded', connected: false });
    expect((await probeManaged(retriever({ auth: { ok: false, code: 'AUTH' } }), { secrets: [] })).state).toBe('configured-not-verified');
    const missing = await probeManaged(retriever({ auth: pass, scope: pass, data: pass }), { secrets: [] });
    expect(missing).toMatchObject({ state: 'degraded', connected: false });
    expect(missing.stages.contract).toEqual({ ok: null, detail: 'not reported by the connector' });
  });

  it('a probe that throws is a failed auth stage with fixed text; secrets never reach details', async () => {
    const r = await probeManaged(retriever(async () => {
      throw new Error(`upstream said ${SECRET}`);
    }), { secrets: [SECRET] });
    expect(r.state).toBe('configured-not-verified');
    expect(r.stages.auth).toEqual({ ok: false, code: 'PROBE_FAILED', detail: 'the connector probe failed' });
    const d = await probeManaged(retriever({ auth: pass, scope: { ok: false, code: 'X', detail: `denied for ${SECRET}` } }), { secrets: [SECRET] });
    expect(JSON.stringify(d)).not.toContain(SECRET);
  });
});

describe('connectorState', () => {
  const verified: HealthReport = { state: 'source-access-verified', connected: true, stages: { auth: pass, scope: pass, data: pass, contract: pass } };
  const run = { status: 'succeeded' as const, extraction: 'complete' as const, mappingValidated: true, reconciled: true };

  it('walks the ladder only as far as the evidence goes', () => {
    expect(connectorState({ configured: false })).toBe('not-configured');
    expect(connectorState({ configured: true })).toBe('configured-not-verified');
    expect(connectorState({ configured: true, health: { ...verified, state: 'auth-verified', connected: false } })).toBe('auth-verified');
    expect(connectorState({ configured: true, health: verified })).toBe('source-access-verified');
    expect(connectorState({ configured: true, health: verified, lastRun: { ...run, extraction: 'incomplete' } })).toBe('source-access-verified');
    expect(connectorState({ configured: true, health: verified, lastRun: { ...run, mappingValidated: false, reconciled: false } })).toBe('extraction-completed');
    expect(connectorState({ configured: true, health: verified, lastRun: { ...run, reconciled: false } })).toBe('mapping-validated');
    expect(connectorState({ configured: true, health: verified, lastRun: run })).toBe('reconciliation-passed');
    expect(connectorState({ configured: true, health: verified, lastRun: { ...run, status: 'failed' } })).toBe('failed');
  });

  it('live verified needs a live evidence record; simulated never upgrades', () => {
    expect(connectorState({ configured: true, health: verified, lastRun: run, evidenceStatus: PRE_ROLLOUT_STATUS })).toBe('reconciliation-passed');
    expect(connectorState({ configured: true, health: verified, lastRun: run, evidenceStatus: LIVE_STATUS })).toBe('live-verified');
    expect(connectorState({ configured: true, simulated: true, health: verified, lastRun: run, evidenceStatus: LIVE_STATUS })).toBe('simulated');
  });
});

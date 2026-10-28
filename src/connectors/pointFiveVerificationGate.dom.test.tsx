// @vitest-environment happy-dom
// M2: the connector walk opens a session only when a verification-bearing
// health check says `source-access-verified`; reachable && authed alone is not
// enough. `degraded` shows as degraded (no ingest), anything less is an error.
// Health objects are SYNTHETIC; no network.
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CostSourceClient, SourceHealth } from '@/costsource';
import { sourcesForEnv } from '@/costsource/seed';
import { useStore } from '@/store/useStore';
import { ConnectorCard } from './ConnectorCard';
import { sessionStateForHealth } from './ingestLanding';

vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, pathname: '/', isReady: true, push: async () => true, replace: async () => true }) }));

const P5 = sourcesForEnv({}).find((s) => s.id === 'pointfive-live')!;
beforeEach(() => useStore.setState({ connectorSessions: {}, ingestRuns: {}, connectorBusy: null }));

const health = (extra: Record<string, unknown>): SourceHealth =>
  ({ sourceId: P5.id, sourceVersion: '1.0', canonicalVersion: '1.4', checkedAt: '2026-06-01T00:00:00.000Z', detail: 'SYNTHETIC detail', ...extra }) as SourceHealth;
const clientWith = (h: SourceHealth) =>
  ({ mode: 'live', healthCheck: async () => h, fetchCostRows: async () => Promise.reject(new Error('no')), fetchFindings: async () => [], listSources: async () => [] }) as unknown as CostSourceClient;

describe('connect opens only on source-access-verified', () => {
  it.each([
    ['source-access-verified', true, 'open'],
    ['degraded', true, 'degraded'],
    ['auth-verified', true, 'error'],
    ['configured-not-verified', false, 'error'],
    ['not-configured', false, 'error'],
  ] as const)('verification %s (reachable && authed = %s) → session %s', async (verification, ok, state) => {
    const h = health({ reachable: ok, authed: ok, verification });
    expect(sessionStateForHealth(h)).toBe(state);
    await useStore.getState().connectConnector(P5.id, clientWith(h));
    const s = useStore.getState().connectorSessions[P5.id];
    expect(s.state).toBe(state);
    if (state !== 'open') expect(s.error).toBe('SYNTHETIC detail');
  });

  it('reachable && authed is not enough when the verification is not source-access-verified', async () => {
    await useStore.getState().connectConnector(P5.id, clientWith(health({ reachable: true, authed: true, verification: 'auth-verified' })));
    expect(useStore.getState().connectorSessions[P5.id].state).not.toBe('open');
  });

  it('a health check without a verification field keeps the reachable && authed rule (sandbox sources)', () => {
    expect(sessionStateForHealth(health({ reachable: true, authed: true }))).toBe('open');
    expect(sessionStateForHealth(health({ reachable: true, authed: false }))).toBe('error');
  });

  it('source-access-verified with reachable or authed false does not open', () => {
    expect(sessionStateForHealth(health({ reachable: false, authed: true, verification: 'source-access-verified' }))).toBe('error');
  });

  it('the card shows a degraded session as degraded, with Retry and no Ingest', async () => {
    await useStore.getState().connectConnector(P5.id, clientWith(health({ reachable: true, authed: true, verification: 'degraded' })));
    const session = useStore.getState().connectorSessions[P5.id];
    const html = renderToStaticMarkup(<ConnectorCard source={P5} session={session} onConnect={() => {}} onIngest={() => {}} />);
    expect(html).toMatch(/Degraded/);
    expect(html).toContain('SYNTHETIC detail');
    expect(html).toContain('Retry connect');
    expect(html).not.toMatch(/Ingest now/);
    // An ingest request on a degraded session is refused by the store too.
    await useStore.getState().runConnectorIngest(P5.id, P5.name, clientWith(health({})));
    expect(useStore.getState().ingestRuns[P5.id]).toBeUndefined();
  });
});

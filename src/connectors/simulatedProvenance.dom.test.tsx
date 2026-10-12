// @vitest-environment happy-dom
// A simulated run carries its label to every surface that shows landed provenance, and the store maps
// ONLY a genuine LiveDataAuthError to `locked` (connect and ingest); any other error keeps Retry.
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it } from 'vitest';
import { AttributionPage } from '@/attribution/AttributionPage';
import { WorkloadCard } from '@/components/workload/WorkloadCard';
import { LiveDataAuthError, type CostSourceClient } from '@/costsource';
import { SimulatedConnectorClient } from '@/costsource/SimulatedConnectorClient';
import { sourcesForEnv } from '@/costsource/seed';
import { FindingsPage } from '@/findings/FindingsPage';
import { useStore } from '@/store/useStore';
import { ConnectorCard } from './ConnectorCard';

const P5 = sourcesForEnv({}).find((s) => s.id === 'pointfive-live')!;
const AWS = sourcesForEnv({}).find((s) => s.id === 'aws-data-exports')!;
beforeEach(() => useStore.setState({ connectorSessions: {}, ingestRuns: {}, connectorBusy: null, simulation: null }));

async function simulatedRun() {
  const sim = new SimulatedConnectorClient();
  await useStore.getState().connectConnector(P5.id, sim);
  await useStore.getState().runConnectorIngest(P5.id, P5.name, sim);
  return useStore.getState().ingestRuns[P5.id];
}

it('the run itself is marked simulated, so Findings, Attribution and the workload card all say so', async () => {
  const run = await simulatedRun();
  expect(run.sourceName).toBe(`${P5.name} (simulated)`);
  expect(renderToStaticMarkup(<FindingsPage />)).toContain(`${P5.name} (simulated)`);
  expect(renderToStaticMarkup(<AttributionPage />)).toContain(`${P5.name} (simulated)`);
  const workload = useStore.getState().workloads[0];
  const card = <WorkloadCard workload={workload} selected={false} secondaryMode={'value' as never} onSelect={() => {}} landedVia={{ sourceName: run.sourceName, at: run.at }} />;
  expect(renderToStaticMarkup(card)).toMatch(/landed via (<!-- -->)?PointFive.* \(simulated\)/);
});

const failing = (err: Error, at: 'health' | 'rows') =>
  ({
    healthCheck: async () => (at === 'health' ? Promise.reject(err) : { reachable: true, authed: true }),
    fetchCostRows: async () => Promise.reject(err),
    fetchFindings: async () => [],
  }) as unknown as CostSourceClient;

it('a plain Error stays an error with Retry; only LiveDataAuthError locks (connect and ingest)', async () => {
  await useStore.getState().connectConnector(AWS.id, failing(new Error('upstream down'), 'health'));
  const plain = useStore.getState().connectorSessions[AWS.id];
  expect([plain.state, plain.error]).toEqual(['error', 'upstream down']);
  expect(renderToStaticMarkup(<ConnectorCard source={AWS} session={plain} onConnect={() => {}} />)).toContain('Retry connect');

  await useStore.getState().connectConnector(AWS.id, failing(new LiveDataAuthError(), 'rows'));
  expect(useStore.getState().connectorSessions[AWS.id].state).toBe('open');
  await useStore.getState().runConnectorIngest(AWS.id, AWS.name, failing(new LiveDataAuthError(), 'rows'));
  expect(useStore.getState().connectorSessions[AWS.id].state).toBe('locked');
  await useStore.getState().connectConnector(AWS.id, failing(new Error('upstream down'), 'health'));
  await useStore.getState().connectConnector(AWS.id, failing(new Error('ok'), 'rows'));
  await useStore.getState().runConnectorIngest(AWS.id, AWS.name, failing(new Error('rows failed'), 'rows'));
  expect(useStore.getState().connectorSessions[AWS.id].state).toBe('error');
});

it('documented-format cards say what is verified and what is not', () => {
  const html = renderToStaticMarkup(<ConnectorCard source={AWS} onConnect={() => {}} simulation={{ verified: true, format: 'x' }} />);
  expect(html).toContain('column names verified; values and encodings not');
});

// Contract: the simulated connector client (anonymous demo path) returns exactly what the REAL
// parse -> coerce -> normalize path makes of the documented-format fixture files, checked against an
// independent oracle (the fixture's own BilledCost cells). Illustrative payloads stay labeled unverified.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isSimulatedSource, SIMULATED_FIXTURES, SimulatedConnectorClient } from './SimulatedConnectorClient';
import { AWS_FOCUS_1_0_CSV, AZURE_FOCUS_1_0_CSV } from './simulatedFixtures';
import { landingSummary } from '@/connectors/ingestLanding';
import { normalizeRows } from './normalize';
import { OFFLINE_SANDBOX_SOURCE_IDS } from './sandboxSources';
import { sourcesForEnv } from './seed';
import { rowsFromExportText, rowsFromRecords } from './transports/focusExport';
import { bqRowsToRecords } from './transports/gcpBigQueryTransport';

const file = (name: string) =>
  readFileSync(path.resolve(__dirname, '../../fixtures/connector-formats', name), 'utf8').replace(/^#.*\n/gm, '');
const fetchSpy = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchSpy));
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled(); // no network call, ever
  vi.unstubAllGlobals();
});

const client = new SimulatedConnectorClient();
const ANY = { start: '2030-01-01T00:00:00Z', end: '2030-02-01T00:00:00Z' }; // the fixture's own window wins
const SEPT = { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' };
const OCT = { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' };
// Independent oracle: BilledCost cells read with a plain split (the column sits before any quoted field).
const csvCosts = (text: string) => {
  const [head, ...lines] = text.trim().split('\n');
  const i = head.split(',').indexOf('BilledCost');
  return lines.map((l) => Number(l.split(',')[i]));
};
const gcpJson = () => JSON.parse(file('gcp-bigquery-jobs-query.json'));

it('covers exactly the non-sandbox connector ids', () => {
  const live = sourcesForEnv({}).map((s) => s.id).filter((id) => !OFFLINE_SANDBOX_SOURCE_IDS.has(id));
  expect(live.sort()).toEqual(['aws-data-exports', 'azure-cost-management', 'gcp-bigquery-focus', 'kubernetes', 'nutanix', 'pointfive-live']);
  expect(Object.keys(SIMULATED_FIXTURES).sort()).toEqual(live);
  expect([...OFFLINE_SANDBOX_SOURCE_IDS].some(isSimulatedSource)).toBe(false);
});

it('bundles the C1 documented-format CSVs byte for byte', () => {
  expect(AWS_FOCUS_1_0_CSV).toBe(file('aws-focus-1.0.csv'));
  expect(AZURE_FOCUS_1_0_CSV).toBe(file('azure-focus-1.0.csv'));
});

it.each([
  ['aws-data-exports', () => rowsFromExportText(file('aws-focus-1.0.csv'), SEPT, 'oracle'), () => csvCosts(file('aws-focus-1.0.csv'))],
  ['azure-cost-management', () => rowsFromExportText(file('azure-focus-1.0.csv'), OCT, 'oracle'), () => csvCosts(file('azure-focus-1.0.csv'))],
  [
    'gcp-bigquery-focus',
    () => rowsFromRecords(bqRowsToRecords(gcpJson()), SEPT, 'oracle', { allowEpochSeconds: true }),
    () => gcpJson().rows.map((r: { f: { v: string }[] }) => Number(r.f[0].v)),
  ],
])('%s: rows equal the real normalization of the fixture file', async (id, raws, costs) => {
  const expected = normalizeRows(raws(), id, '1.0');
  const result = await client.fetchCostRows(id, ANY);
  expect(result.rows).toEqual(expected.rows);
  expect(result.backfilledColumns).toEqual(expected.backfilledColumns);
  expect(result.rows.map((r) => r.BilledCost)).toEqual(costs());
  expect(result.rows.length).toBeGreaterThan(1);
  expect(new Set(result.rows.map((r) => r.x_RatioSourceId))).toEqual(new Set([id]));
  expect(SIMULATED_FIXTURES[id].verified).toBe(true);
  expect(await client.fetchFindings(id)).toEqual([]);
});

// Oracle: the payload values in the connector research report (sections 5.1-B, 5.2-B/C/D, Nutanix 5.3-a).
it.each([
  ['kubernetes', [3.7, 8.35], []],
  ['nutanix', [41.25, 18.9], []],
  ['pointfive-live', [412.18], [182.5, 410, -95.2]],
])('%s: illustrative payload goes through the real adapter and stays unverified', async (id, costs, findingAmounts) => {
  const result = await client.fetchCostRows(id, ANY);
  expect(result.rows.map((r) => r.BilledCost)).toEqual(costs);
  expect(new Set(result.rows.map((r) => r.x_RatioSourceId))).toEqual(new Set([id]));
  const findings = await client.fetchFindings(id);
  expect(findings.map((f) => f.estimatedMonthlySavings || f.observedSpendDelta)).toEqual(findingAmounts);
  expect(SIMULATED_FIXTURES[id].verified).toBe(false);
});

it('health is a simulated pass for every id and says so', async () => {
  for (const id of Object.keys(SIMULATED_FIXTURES)) {
    const health = await client.healthCheck(id);
    expect([health.sourceId, health.reachable, health.authed]).toEqual([id, true, true]);
    expect(health.detail).toMatch(/^Simulated .*no network call/);
  }
  await expect(client.healthCheck('pointfive-sandbox')).rejects.toThrow(/not a simulated connector/);
});

it('no simulated row or finding resolves to a Ratio workload (they land honestly unresolved)', async () => {
  for (const id of Object.keys(SIMULATED_FIXTURES)) {
    const result = await client.fetchCostRows(id, ANY);
    const findings = await client.fetchFindings(id);
    expect(result.rows.map((r) => r.x_RatioWorkloadId ?? null).filter(Boolean)).toEqual([]);
    expect(findings.map((f) => f.workloadId).filter(Boolean)).toEqual([]);
    expect(landingSummary({ sourceId: id, sourceName: id, at: '', result, findings }).workloadsResolved).toBe(0);
  }
});

it('every anomaly title states the direction its observedSpendDelta sign has (negative = drop)', async () => {
  const anomalies = (await client.fetchFindings('pointfive-live')).filter((f) => f.type === 'anomaly');
  expect(anomalies.length).toBeGreaterThan(0);
  for (const a of anomalies) {
    const text = `${a.category} ${a.title}`.toLowerCase();
    expect([/spike|increase|rise/.test(text), /drop|decrease|fall/.test(text)]).toEqual([a.observedSpendDelta > 0, a.observedSpendDelta < 0]);
  }
});

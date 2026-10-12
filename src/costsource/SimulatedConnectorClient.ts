// SimulatedConnectorClient: the anonymous demo path for the LIVE connector ids. The browser holds no
// API token, so the live routes refuse these ids (intended policy). Instead of a 401 and a Retry
// loop, each card runs bundled fixture data through the REAL adapters (CloudConnectorAdapter /
// PointFiveLiveAdapter: parse, coerce, normalize) with only the transport stubbed. It never calls
// fetch: the stub transports read constants, and PointFive's OAuth fetch is a rejecting stub.
// AWS / Azure / GCP use the documented-format samples; Kubernetes, Nutanix and PointFive use
// illustrative payloads whose formats are NOT verified against the vendor.
import gcpBigQueryResponse from '../../fixtures/connector-formats/gcp-bigquery-jobs-query.json';
import { CloudConnectorAdapter } from './CloudConnectorAdapter';
import type { CostFinding, CostRowsResult, CostSourceClient, CostSourceDescriptor, CostWindow, SourceHealth } from './CostSourceClient';
import { findConnectorSpec } from './focusExportConnectors';
import type { RawSourceRow } from './focusRows';
import { PointFiveLiveAdapter } from './PointFiveLiveAdapter';
import { POINTFIVE_LIVE_FLAG_ENV, POINTFIVE_LIVE_SOURCE_ID } from './pointfiveConfig';
import { sourcesForEnv } from './seed';
import * as data from './simulatedFixtures';
import { rowsFromExportText, rowsFromRecords } from './transports/focusExport';
import { bqRowsToRecords } from './transports/gcpBigQueryTransport';

export const SIMULATED_UNVERIFIED_LABEL = 'illustrative, format not verified';
export const SIMULATED_VERIFIED_NOTE = 'documented-format sample: column names verified; values and encodings not';
export const SIMULATED_LIVE_NOTE = 'Live connection requires the authenticated API';

export interface SimulatedFixture {
  /** true: a documented-format sample export (C1); false: illustrative, format not verified. */
  verified: boolean;
  format: string;
  /** The fixture's own billing window: rows outside the caller's window would otherwise vanish. */
  window: CostWindow;
  /** FOCUS-export transports only; PointFive's stub reads its MCP payloads directly. */
  rows?: (window: CostWindow) => RawSourceRow[];
}

const SEPT = { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' };
const OCT = { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' };
const text = (body: string, label: string) => (w: CostWindow) => rowsFromExportText(body, w, `simulated ${label}`);

export const SIMULATED_FIXTURES: Record<string, SimulatedFixture> = {
  'aws-data-exports': { verified: true, format: 'AWS Data Exports FOCUS 1.0 CSV sample', window: SEPT, rows: text(data.AWS_FOCUS_1_0_CSV, 'AWS export') },
  'azure-cost-management': { verified: true, format: 'Azure Cost Management FOCUS 1.0 CSV sample', window: OCT, rows: text(data.AZURE_FOCUS_1_0_CSV, 'Azure export') },
  'gcp-bigquery-focus': {
    verified: true,
    format: 'GCP BigQuery jobs.query FOCUS 1.0 response sample',
    window: SEPT,
    rows: (w) => rowsFromRecords(bqRowsToRecords(gcpBigQueryResponse as unknown as Parameters<typeof bqRowsToRecords>[0]), w, 'simulated GCP query', { allowEpochSeconds: true }),
  },
  kubernetes: { verified: false, format: 'OpenCost allocation mapped to FOCUS 1.0 JSON', window: OCT, rows: text(JSON.stringify(data.KUBERNETES_FOCUS_ROWS), 'Kubernetes endpoint') },
  nutanix: { verified: false, format: 'assumed FOCUS 1.0 CSV', window: OCT, rows: text(data.NUTANIX_FOCUS_CSV, 'Nutanix endpoint') },
  [POINTFIVE_LIVE_SOURCE_ID]: { verified: false, format: 'assumed PointFive MCP tool results', window: OCT },
};

export function isSimulatedSource(sourceId: string): boolean {
  return Object.prototype.hasOwnProperty.call(SIMULATED_FIXTURES, sourceId);
}

function fixtureFor(sourceId: string): SimulatedFixture {
  if (!isSimulatedSource(sourceId)) throw new Error(`'${sourceId}' is not a simulated connector`);
  return SIMULATED_FIXTURES[sourceId];
}

const noNetwork = async (): Promise<Response> => {
  throw new Error('simulated connector: no network');
};

/** The real adapter for a source id, with the transport stubbed over the fixture. */
function adapterFor(sourceId: string): CloudConnectorAdapter | PointFiveLiveAdapter {
  const fx = fixtureFor(sourceId);
  if (sourceId === POINTFIVE_LIVE_SOURCE_ID) {
    const env = { [POINTFIVE_LIVE_FLAG_ENV]: 'true', POINTFIVE_OAUTH_CLIENT_ID: 'simulated', POINTFIVE_OAUTH_CLIENT_SECRET: 'simulated', POINTFIVE_OAUTH_TOKEN_URL: 'simulated' };
    return new PointFiveLiveAdapter({
      env,
      httpFetch: noNetwork,
      transportFactory: () => ({
        ping: async () => true,
        fetchBillingRows: async () => data.POINTFIVE_BILLING_ROWS as unknown as RawSourceRow[],
        listOpportunities: async () => data.POINTFIVE_OPPORTUNITIES,
        listAnomalies: async () => data.POINTFIVE_ANOMALIES,
      }),
    });
  }
  const spec = findConnectorSpec(sourceId)!;
  const env = Object.fromEntries(Object.values(spec.requiredEnv).map((name) => [name, 'simulated']));
  return new CloudConnectorAdapter(spec, { env, transportFactory: () => ({ ping: async () => true, fetchExportRows: async (w) => fx.rows?.(w) ?? [] }) });
}

export class SimulatedConnectorClient implements CostSourceClient {
  readonly mode = 'mock' as const;
  /** Marks landed runs so every provenance surface labels them simulated. */
  readonly simulated = true;

  async listSources(): Promise<CostSourceDescriptor[]> {
    return sourcesForEnv({}).filter((s) => isSimulatedSource(s.id));
  }

  /** Rows for the fixture's own window (the requested window is ignored: fixtures are fixed in time). */
  async fetchCostRows(sourceId: string, _window?: CostWindow): Promise<CostRowsResult> {
    return adapterFor(sourceId).fetchCostRows(fixtureFor(sourceId).window);
  }

  async fetchFindings(sourceId: string): Promise<CostFinding[]> {
    const adapter = adapterFor(sourceId);
    return adapter instanceof PointFiveLiveAdapter ? adapter.fetchFindings() : [];
  }

  async healthCheck(sourceId: string): Promise<SourceHealth> {
    const fx = fixtureFor(sourceId);
    const health = await adapterFor(sourceId).healthCheck();
    const label = fx.verified ? SIMULATED_VERIFIED_NOTE : SIMULATED_UNVERIFIED_LABEL;
    return { ...health, detail: `Simulated connection: ${fx.format} (${label}); no network call, no credentials.` };
  }
}

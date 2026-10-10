// In-memory mock — no network. Serves the offline seed through the same
// CostSourceClient interface the live adapter will implement. Mirrors
// MockFinioClient / MockTokenomicsClient: small delays make loading states
// visible; everything runs over bundled seed data.
import type {
  CostSourceClient,
  CostSourceDescriptor,
  CostRowsResult,
  CostFinding,
  SourceHealth,
  CostWindow,
} from './CostSourceClient';
import { CANONICAL_FOCUS_VERSION } from './focusVersions';
import { COST_SOURCES, findSource, findingsFor, rawRowsForVersion } from './seed';
import { normalizeRows } from './normalize';
import { PointFiveLiveAdapter } from './PointFiveLiveAdapter';
import { POINTFIVE_LIVE_SOURCE_ID } from './pointfiveConfig';
import { ServiceNowAdapter, SERVICENOW_SANDBOX_SOURCE_ID } from './ServiceNowAdapter';
import { CloudConnectorAdapter } from './CloudConnectorAdapter';
import { findConnectorSpec } from './focusExportConnectors';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve a source descriptor or throw a typed error the demo surfaces. */
function requireSource(sourceId: string): CostSourceDescriptor {
  const src = findSource(sourceId);
  if (!src) throw new Error(`Unknown cost source '${sourceId}'`);
  return src;
}

export class MockCostSourceClient implements CostSourceClient {
  readonly mode = 'mock' as const;

  async listSources(): Promise<CostSourceDescriptor[]> {
    await delay(120);
    return COST_SOURCES.map((s) => ({ ...s }));
  }

  async fetchCostRows(sourceId: string, window: CostWindow): Promise<CostRowsResult> {
    await delay(180);
    // The live PointFive source dispatches to its own adapter. Default build:
    // flag OFF → the adapter throws an honest "not configured" error, no network.
    if (sourceId === POINTFIVE_LIVE_SOURCE_ID) {
      return new PointFiveLiveAdapter().fetchCostRows(window);
    }
    // Config-driven connectors dispatch to the shared FOCUS-export adapter,
    // which goes live through the connector's transport once its env is set.
    // Not configured → an honest "not configured" error and no network call; a
    // live failure is thrown, never papered over with seed data.
    const connectorSpec = findConnectorSpec(sourceId);
    if (connectorSpec) {
      return new CloudConnectorAdapter(connectorSpec).fetchCostRows(window);
    }
    const src = requireSource(sourceId);
    if (!src.configured) {
      throw new Error(`Source '${sourceId}' is not configured — live credentials required (PR E)`);
    }
    if (!src.capabilities.includes('costRows')) {
      throw new Error(`Source '${sourceId}' does not provide cost rows`);
    }
    // Synthetic ServiceNow dispatches to its own adapter (CMDB/ITBM allocation
    // shape) — same normalization shim, its own row emitter.
    if (sourceId === SERVICENOW_SANDBOX_SOURCE_ID) {
      return ServiceNowAdapter.ingest(ServiceNowAdapter.seedRows(), src.focusVersion, sourceId, window);
    }
    const { rows, backfilledColumns, draftColumnsBackfilled } = normalizeRows(
      rawRowsForVersion(src.focusVersion),
      src.id,
      src.focusVersion,
    );
    return {
      sourceId,
      sourceVersion: src.focusVersion,
      canonicalVersion: CANONICAL_FOCUS_VERSION,
      backfilledColumns,
      draftColumnsBackfilled,
      window,
      generatedAt: new Date().toISOString(),
      rows,
    };
  }

  async fetchFindings(sourceId: string): Promise<CostFinding[]> {
    await delay(150);
    if (sourceId === POINTFIVE_LIVE_SOURCE_ID) {
      return new PointFiveLiveAdapter().fetchFindings();
    }
    const src = requireSource(sourceId);
    if (!src.configured || !src.capabilities.includes('findings')) return [];
    return findingsFor(src.id);
  }

  async healthCheck(sourceId: string): Promise<SourceHealth> {
    await delay(80);
    if (sourceId === POINTFIVE_LIVE_SOURCE_ID) {
      return new PointFiveLiveAdapter().healthCheck();
    }
    if (sourceId === SERVICENOW_SANDBOX_SOURCE_ID) {
      return ServiceNowAdapter.healthCheck(sourceId);
    }
    const connectorSpec = findConnectorSpec(sourceId);
    if (connectorSpec) {
      return new CloudConnectorAdapter(connectorSpec).healthCheck();
    }
    const src = requireSource(sourceId);
    return {
      sourceId,
      reachable: src.configured,
      authed: src.configured,
      sourceVersion: src.focusVersion,
      canonicalVersion: CANONICAL_FOCUS_VERSION,
      checkedAt: new Date().toISOString(),
      detail: src.configured
        ? 'Sandbox adapter reachable; serving offline seed data.'
        : 'Specified but not configured — live credentials required (ships dark).',
    };
  }
}

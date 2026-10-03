// PointFiveLiveAdapter (PR E) — the live PointFive source for the cost-ingest
// seam. Source #3 behind the same contract as PR #13's mock client and PR #15's
// FocusFileAdapter: fetchCostRows / fetchFindings / healthCheck.
//
// SHIPS DARK. The COSTSOURCE_POINTFIVE_LIVE flag is OFF by default and no real
// PointFive credentials exist yet, so the adapter resolves to `disabled`:
//   - healthCheck() returns an honest "not authed / ships dark" state
//   - fetchFindings() returns [] (inert)
//   - fetchCostRows() throws a typed "not configured" error
// and crucially makes ZERO network calls in any of these paths. Only the
// `configured` state — flag on AND OAuth credentials present — ever builds a
// transport and reaches the network.
//
// The adapter is source-specific only in auth, fetch, and identity resolution:
// PointFive's FOCUS export goes through the EXISTING version-negotiation shim
// (`normalizeRows`, reused not reimplemented) up to the v1.4 canonical model,
// and Opportunities/Anomalies map onto the seam's findings shape. Everything
// downstream — value ratio, forecast, gates, views — is unchanged.

import type {
  CostFinding,
  CostRowsResult,
  CostSourceDescriptor,
  CostWindow,
  SourceHealth,
} from './CostSourceClient';
import { CANONICAL_FOCUS_VERSION } from './focusVersions';
import { normalizeRows } from './normalize';
import { assertValidWindow, validateFocusRecords } from './transports/focusExport';
import { redactErrorText } from './transports/redact';
import { resolveWorkloadId } from './seed';
import {
  POINTFIVE_FOCUS_VERSION,
  POINTFIVE_LIVE_SOURCE_ID,
  pointFiveLiveDescriptor,
  pointFiveStatusNote,
  resolvePointFiveStatus,
  type PointFiveCredentials,
  type PointFiveStatus,
} from './pointfiveConfig';
import { PointFiveOAuthClient, type HttpFetch } from './PointFiveOAuthClient';
import {
  SsePointFiveMcpClient,
  type PointFiveAnomaly,
  type PointFiveMcpClient,
  type PointFiveMcpClientFactory,
  type PointFiveOpportunity,
} from './PointFiveMcpTransport';

/** Map a PointFive Opportunity onto the seam's findings shape. */
export function mapOpportunityToFinding(
  opp: PointFiveOpportunity,
  sourceId: string,
): CostFinding {
  return {
    id: opp.id,
    sourceId,
    type: 'opportunity',
    category: opp.category,
    title: opp.title,
    resourceId: opp.resourceId,
    workloadId: resolveWorkloadId(opp.resourceId),
    estimatedMonthlySavings: opp.estimatedMonthlySavings,
    observedSpendDelta: 0,
    severity: opp.severity,
    status: 'open',
    detectedAt: opp.detectedAt,
  };
}

/** Map a PointFive Anomaly onto the seam's findings shape. */
export function mapAnomalyToFinding(anomaly: PointFiveAnomaly, sourceId: string): CostFinding {
  return {
    id: anomaly.id,
    sourceId,
    type: 'anomaly',
    category: anomaly.category,
    title: anomaly.title,
    resourceId: anomaly.resourceId,
    workloadId: resolveWorkloadId(anomaly.resourceId),
    estimatedMonthlySavings: 0,
    observedSpendDelta: anomaly.observedSpendDelta,
    severity: anomaly.severity,
    status: 'open',
    detectedAt: anomaly.detectedAt,
  };
}

/** Injectable dependencies — all defaulted; tests override env + transport. */
export interface PointFiveLiveAdapterDeps {
  env?: Record<string, string | undefined>;
  httpFetch?: HttpFetch;
  transportFactory?: PointFiveMcpClientFactory;
  now?: () => number;
}

// Default OAuth transport over the global fetch. Only ever invoked on the
// configured path; the dark build never reaches it.
const defaultHttpFetch: HttpFetch = (input, init) => fetch(input, init);
const defaultTransportFactory: PointFiveMcpClientFactory = (creds, oauth) =>
  new SsePointFiveMcpClient(creds, oauth);

export class PointFiveLiveAdapter {
  private readonly status: PointFiveStatus;
  private readonly httpFetch: HttpFetch;
  private readonly transportFactory: PointFiveMcpClientFactory;
  private readonly now: () => number;

  constructor(deps: PointFiveLiveAdapterDeps = {}) {
    this.status = resolvePointFiveStatus(deps.env ?? process.env);
    this.httpFetch = deps.httpFetch ?? defaultHttpFetch;
    this.transportFactory = deps.transportFactory ?? defaultTransportFactory;
    this.now = deps.now ?? Date.now;
  }

  /** Descriptor for `listSources()` — `configured` reflects the live status. */
  describe(): CostSourceDescriptor {
    return pointFiveLiveDescriptor(this.status);
  }

  /** True only when flag is on and OAuth credentials are present. */
  get isConfigured(): boolean {
    return this.status.state === 'configured';
  }

  async healthCheck(): Promise<SourceHealth> {
    const base = {
      sourceId: POINTFIVE_LIVE_SOURCE_ID,
      sourceVersion: POINTFIVE_FOCUS_VERSION,
      canonicalVersion: CANONICAL_FOCUS_VERSION,
      checkedAt: new Date().toISOString(),
    };

    // Dark / unconfigured: honest state, no network call.
    if (this.status.state !== 'configured') {
      return { ...base, reachable: false, authed: false, detail: pointFiveStatusNote(this.status) };
    }

    try {
      const reachable = await this.buildTransport(this.status.credentials).ping();
      return {
        ...base,
        reachable,
        authed: reachable,
        detail: reachable
          ? 'PointFive MCP reachable; OAuth 2.1 authenticated.'
          : 'PointFive MCP did not respond to the health probe.',
      };
    } catch (err) {
      // Never hang, never crash: a live failure becomes an honest health state.
      return {
        ...base,
        reachable: false,
        authed: false,
        detail: `PointFive MCP health check failed: ${redactErrorText(err)}`,
      };
    }
  }

  async fetchCostRows(window: CostWindow): Promise<CostRowsResult> {
    const credentials = this.requireConfigured('fetch cost rows');
    assertValidWindow(window);
    let billing: Record<string, unknown>[];
    try {
      billing = (await this.buildTransport(credentials).fetchBillingRows(window)) as unknown as Record<
        string,
        unknown
      >[];
    } catch (err) {
      throw new Error(redactErrorText(err));
    }
    // Same validator as the FOCUS-export transports: an invalid row throws
    // `pointfive-live: invalid FOCUS row N: <reason>` — never silently normalized.
    const validated = validateFocusRecords(billing, POINTFIVE_LIVE_SOURCE_ID);
    // Reuse the existing version-negotiation shim: PointFive's FOCUS v1.0 export
    // is upgraded to the v1.4 canonical model and given Ratio's value context.
    const { rows, backfilledColumns } = normalizeRows(
      validated,
      POINTFIVE_LIVE_SOURCE_ID,
      POINTFIVE_FOCUS_VERSION,
    );
    return {
      sourceId: POINTFIVE_LIVE_SOURCE_ID,
      sourceVersion: POINTFIVE_FOCUS_VERSION,
      canonicalVersion: CANONICAL_FOCUS_VERSION,
      backfilledColumns,
      window,
      generatedAt: new Date().toISOString(),
      rows,
    };
  }

  async fetchFindings(): Promise<CostFinding[]> {
    // Inert when dark: no transport, no network, just an empty finding set.
    if (this.status.state !== 'configured') return [];
    const client = this.buildTransport(this.status.credentials);
    let opportunities: PointFiveOpportunity[];
    let anomalies: PointFiveAnomaly[];
    try {
      [opportunities, anomalies] = await Promise.all([client.listOpportunities(), client.listAnomalies()]);
    } catch (err) {
      throw new Error(redactErrorText(err));
    }
    return [
      ...opportunities.map((o) => mapOpportunityToFinding(o, POINTFIVE_LIVE_SOURCE_ID)),
      ...anomalies.map((a) => mapAnomalyToFinding(a, POINTFIVE_LIVE_SOURCE_ID)),
    ];
  }

  // --- internals ---------------------------------------------------------

  private buildTransport(credentials: PointFiveCredentials): PointFiveMcpClient {
    const oauth = new PointFiveOAuthClient(credentials, this.httpFetch, this.now);
    return this.transportFactory(credentials, oauth);
  }

  private requireConfigured(action: string): PointFiveCredentials {
    if (this.status.state !== 'configured') {
      throw new Error(
        `PointFive live source not configured (${this.status.state}) — cannot ${action}; ` +
          'ships dark until COSTSOURCE_POINTFIVE_LIVE is on and OAuth credentials are set.',
      );
    }
    return this.status.credentials;
  }
}


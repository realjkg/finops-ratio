// Tests for PointFiveLiveAdapter (PR E) — the live PointFive source, shipping
// DARK behind the COSTSOURCE_POINTFIVE_LIVE flag.
//
// Coverage:
//   1. resolvePointFiveStatus — disabled / unconfigured / configured branches
//   2. Flag-OFF inert path — dark health, empty findings, throwing fetchCostRows,
//      and ZERO network: neither the transport factory nor httpFetch is called
//   3. Unconfigured healthCheck — flag ON, creds missing → honest not-authed state
//   4. FOCUS v1.0 → v1.4 mapping via the reused version shim (configured path)
//   5. Opportunities/Anomalies → findings mapping (pure mappers + via adapter)
//   6. Configured healthCheck → reachable via the mocked transport
//
// The MCP transport is always mocked — no real network call in tests or CI.

import { describe, it, expect, vi } from 'vitest';
import {
  PointFiveLiveAdapter,
  mapOpportunityToFinding,
  mapAnomalyToFinding,
} from './PointFiveLiveAdapter';
import {
  resolvePointFiveStatus,
  isPointFiveLiveEnabled,
  POINTFIVE_LIVE_SOURCE_ID,
  DEFAULT_POINTFIVE_MCP_URL_VERIFIED,
  pointFiveStatusNote,
} from './pointfiveConfig';
import type {
  PointFiveMcpClient,
  PointFiveOpportunity,
  PointFiveAnomaly,
  PointFiveFocusRow,
} from './PointFiveMcpTransport';
import { rawRowsForVersion, resourceIdFor } from './seed';

const WINDOW = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };

const CONFIGURED_ENV = {
  COSTSOURCE_POINTFIVE_LIVE: 'true',
  POINTFIVE_OAUTH_CLIENT_ID: 'client-id',
  POINTFIVE_OAUTH_CLIENT_SECRET: 'client-secret',
  POINTFIVE_OAUTH_TOKEN_URL: 'https://auth.example/oauth/token',
};

/** A fake MCP transport returning seed-derived PointFive payloads. */
function makeMockTransport(overrides: Partial<PointFiveMcpClient> = {}): PointFiveMcpClient {
  return {
    ping: async () => true,
    fetchBillingRows: async (): Promise<PointFiveFocusRow[]> => rawRowsForVersion('1.0'),
    listOpportunities: async (): Promise<PointFiveOpportunity[]> => [],
    listAnomalies: async (): Promise<PointFiveAnomaly[]> => [],
    ...overrides,
  };
}

const SAMPLE_OPP: PointFiveOpportunity = {
  id: 'pf-opp-1',
  resourceId: resourceIdFor('wl-support'),
  category: 'rightsizing',
  title: 'Idle GPU on support agent',
  estimatedMonthlySavings: 1200,
  severity: 'warning',
  detectedAt: '2026-06-20T00:00:00.000Z',
};

const SAMPLE_ANOMALY: PointFiveAnomaly = {
  id: 'pf-anom-1',
  resourceId: resourceIdFor('wl-support'),
  category: 'spend_spike',
  title: 'Support agent spend spike',
  observedSpendDelta: 800,
  severity: 'critical',
  detectedAt: '2026-06-21T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// 1. Status resolution (pure)
// ---------------------------------------------------------------------------

describe('resolvePointFiveStatus', () => {
  it('is disabled when the flag is absent (ships dark by default)', () => {
    expect(resolvePointFiveStatus({}).state).toBe('disabled');
    expect(isPointFiveLiveEnabled({})).toBe(false);
  });

  it('is disabled for a falsey flag value', () => {
    expect(resolvePointFiveStatus({ COSTSOURCE_POINTFIVE_LIVE: 'false' }).state).toBe('disabled');
    expect(resolvePointFiveStatus({ COSTSOURCE_POINTFIVE_LIVE: '0' }).state).toBe('disabled');
  });

  it('is unconfigured when the flag is ON but OAuth credentials are missing', () => {
    const status = resolvePointFiveStatus({ COSTSOURCE_POINTFIVE_LIVE: 'true' });
    expect(status.state).toBe('unconfigured');
    if (status.state === 'unconfigured') {
      expect(status.missing).toContain('POINTFIVE_OAUTH_CLIENT_ID');
      expect(status.missing).toContain('POINTFIVE_OAUTH_CLIENT_SECRET');
      expect(status.missing).toContain('POINTFIVE_OAUTH_TOKEN_URL');
    }
  });

  it('is configured when the flag is ON and all OAuth credentials are present', () => {
    const status = resolvePointFiveStatus(CONFIGURED_ENV);
    expect(status.state).toBe('configured');
    if (status.state === 'configured') {
      expect(status.credentials.oauthClientId).toBe('client-id');
      expect(status.credentials.mcpUrl).toBe('https://mcp.pointfive.co/sse'); // ASSUMED default
    }
  });

  it('labels the default endpoint ASSUMED and unverified, and drops the label for an explicit endpoint', () => {
    expect(DEFAULT_POINTFIVE_MCP_URL_VERIFIED).toBe(false);
    const dflt = pointFiveStatusNote(resolvePointFiveStatus(CONFIGURED_ENV));
    expect(dflt).toMatch(/Streamable HTTP/);
    expect(dflt).toMatch(/ASSUMED default \(unverified\)/);
    expect(dflt).toContain('POINTFIVE_MCP_URL');
    expect(dflt).not.toMatch(/MCP SSE/);
    const explicit = pointFiveStatusNote(resolvePointFiveStatus({ ...CONFIGURED_ENV, POINTFIVE_MCP_URL: 'https://mcp.example.invalid/mcp' }));
    expect(explicit).not.toMatch(/ASSUMED/);
    expect(pointFiveStatusNote({ state: 'disabled' })).not.toMatch(/MCP SSE/);
  });
});

// ---------------------------------------------------------------------------
// 2. Flag-OFF inert path — dark, and provably no network
// ---------------------------------------------------------------------------

describe('PointFiveLiveAdapter — flag OFF (ships dark)', () => {
  it('healthCheck reports not reachable / not authed and makes no network call', async () => {
    const transportFactory = vi.fn(() => makeMockTransport());
    const httpFetch = vi.fn(() => {
      throw new Error('network call attempted in dark mode');
    });
    const adapter = new PointFiveLiveAdapter({ env: {}, transportFactory, httpFetch });

    const health = await adapter.healthCheck();
    expect(health.sourceId).toBe(POINTFIVE_LIVE_SOURCE_ID);
    expect(health.reachable).toBe(false);
    expect(health.authed).toBe(false);
    expect(health.canonicalVersion).toBe('1.4');
    expect(health.detail).toMatch(/ships dark/i);
    expect(transportFactory).not.toHaveBeenCalled();
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('fetchFindings returns an empty set with no network call', async () => {
    const transportFactory = vi.fn(() => makeMockTransport());
    const adapter = new PointFiveLiveAdapter({ env: {}, transportFactory });
    expect(await adapter.fetchFindings()).toEqual([]);
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('fetchCostRows throws a typed not-configured error with no network call', async () => {
    const transportFactory = vi.fn(() => makeMockTransport());
    const adapter = new PointFiveLiveAdapter({ env: {}, transportFactory });
    await expect(adapter.fetchCostRows(WINDOW)).rejects.toThrow(/not configured/i);
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('describe() marks the source unconfigured (dark) for listSources', () => {
    const descriptor = new PointFiveLiveAdapter({ env: {} }).describe();
    expect(descriptor.id).toBe(POINTFIVE_LIVE_SOURCE_ID);
    expect(descriptor.configured).toBe(false);
    expect(descriptor.capabilities).toContain('costRows');
    expect(descriptor.capabilities).toContain('findings');
  });
});

// ---------------------------------------------------------------------------
// 3. Unconfigured (flag ON, creds missing)
// ---------------------------------------------------------------------------

describe('PointFiveLiveAdapter — flag ON but unconfigured', () => {
  it('healthCheck is honest about missing credentials and makes no network call', async () => {
    const transportFactory = vi.fn(() => makeMockTransport());
    const adapter = new PointFiveLiveAdapter({
      env: { COSTSOURCE_POINTFIVE_LIVE: 'true' },
      transportFactory,
    });
    const health = await adapter.healthCheck();
    expect(health.reachable).toBe(false);
    expect(health.authed).toBe(false);
    expect(health.detail).toMatch(/credentials missing/i);
    expect(transportFactory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. FOCUS v1.0 → v1.4 mapping via the reused shim (configured path)
// ---------------------------------------------------------------------------

describe('PointFiveLiveAdapter — fetchCostRows (configured)', () => {
  it('normalizes PointFive FOCUS v1.0 billing rows up to the v1.4 canonical model', async () => {
    const transportFactory = vi.fn(() => makeMockTransport());
    const adapter = new PointFiveLiveAdapter({ env: CONFIGURED_ENV, transportFactory });

    const result = await adapter.fetchCostRows(WINDOW);
    expect(result.sourceId).toBe(POINTFIVE_LIVE_SOURCE_ID);
    expect(result.sourceVersion).toBe('1.0');
    expect(result.canonicalVersion).toBe('1.4');
    expect(result.backfilledColumns).toEqual(['ListCost', 'ContractedCost', 'ConsumedQuantity', 'ConsumedUnit', 'CommitmentDiscountStatus', 'InvoiceIssuerName', 'ServiceSubcategory', 'SkuMeter', 'CapacityReservationId', 'CapacityReservationStatus', 'PricingCurrency']); // every column the v1.0 rows lack
    expect(result.rows.length).toBeGreaterThan(0);
    expect(transportFactory).toHaveBeenCalledTimes(1);

    const [row] = result.rows;
    // Backfilled canonical columns present (never missing).
    expect(typeof row.ListCost).toBe('number');
    expect(typeof row.ServiceSubcategory).toBe('string');
    expect(row.CapacityReservationId === null || typeof row.CapacityReservationId === 'string').toBe(
      true,
    );
    // Ratio value denominator attached (R4) and source attribution stamped.
    expect(row.x_RatioValueRatio).toBeGreaterThanOrEqual(0);
    expect(row.x_RatioSourceId).toBe(POINTFIVE_LIVE_SOURCE_ID);
    expect(row.x_RatioSourceVersion).toBe('1.0');
  });
});

// ---------------------------------------------------------------------------
// 5. Opportunities / Anomalies → findings mapping
// ---------------------------------------------------------------------------

describe('PointFive findings mapping', () => {
  it('mapOpportunityToFinding produces an opportunity finding and resolves the workload', () => {
    const finding = mapOpportunityToFinding(SAMPLE_OPP, POINTFIVE_LIVE_SOURCE_ID);
    expect(finding.type).toBe('opportunity');
    expect(finding.estimatedMonthlySavings).toBe(1200);
    expect(finding.observedSpendDelta).toBe(0);
    expect(finding.workloadId).toBe('wl-support');
    expect(finding.sourceId).toBe(POINTFIVE_LIVE_SOURCE_ID);
    expect(finding.status).toBe('open');
  });

  it('mapAnomalyToFinding produces an anomaly finding with the observed spend delta', () => {
    const finding = mapAnomalyToFinding(SAMPLE_ANOMALY, POINTFIVE_LIVE_SOURCE_ID);
    expect(finding.type).toBe('anomaly');
    expect(finding.observedSpendDelta).toBe(800);
    expect(finding.estimatedMonthlySavings).toBe(0);
    expect(finding.severity).toBe('critical');
  });

  it('leaves workloadId null when a finding resource does not resolve to a workload', () => {
    const finding = mapOpportunityToFinding(
      { ...SAMPLE_OPP, resourceId: 'arn:unknown:resource' },
      POINTFIVE_LIVE_SOURCE_ID,
    );
    expect(finding.workloadId).toBeNull();
  });

  it('fetchFindings combines Opportunities and Anomalies from the transport', async () => {
    const transportFactory = vi.fn(() =>
      makeMockTransport({
        listOpportunities: async () => [SAMPLE_OPP],
        listAnomalies: async () => [SAMPLE_ANOMALY],
      }),
    );
    const adapter = new PointFiveLiveAdapter({ env: CONFIGURED_ENV, transportFactory });
    const findings = await adapter.fetchFindings();
    expect(findings.map((f) => f.type)).toEqual(['opportunity', 'anomaly']);
    expect(findings[0].id).toBe('pf-opp-1');
    expect(findings[1].id).toBe('pf-anom-1');
  });
});

// ---------------------------------------------------------------------------
// 6. Configured healthCheck
// ---------------------------------------------------------------------------

describe('PointFiveLiveAdapter — healthCheck (configured)', () => {
  it('is reachable + authed when the transport pings successfully', async () => {
    const transportFactory = vi.fn(() => makeMockTransport({ ping: async () => true }));
    const adapter = new PointFiveLiveAdapter({ env: CONFIGURED_ENV, transportFactory });
    const health = await adapter.healthCheck();
    expect(health.reachable).toBe(true);
    expect(health.authed).toBe(true);
    expect(transportFactory).toHaveBeenCalledTimes(1);
    // A ping-only transport proves an MCP session at most: never source access.
    expect(health.verification).toBe('auth-verified');
    expect(health.detail).not.toMatch(/MCP reachable|connected/i);
  });

  it('degrades to an honest unreachable state when the transport throws', async () => {
    const transportFactory = vi.fn(() =>
      makeMockTransport({
        ping: async () => {
          throw new Error('SSE connection refused');
        },
      }),
    );
    const adapter = new PointFiveLiveAdapter({ env: CONFIGURED_ENV, transportFactory });
    const health = await adapter.healthCheck();
    expect(health.reachable).toBe(false);
    expect(health.authed).toBe(false);
    expect(health.detail).toMatch(/health check failed/i);
  });
});


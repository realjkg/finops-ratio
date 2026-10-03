// Tests for CloudConnectorAdapter — the shared FOCUS-export adapter behind every
// config-driven connector (cloud trio + Kubernetes + Nutanix + generic endpoint).
//
// Coverage:
//   1. Not-configured path (available, and kill-switched) — honest health,
//      throwing fetchCostRows, and provably ZERO network: the transport
//      factory is never called
//   2. Partially configured health — honest about what is missing
//   3. FOCUS v1.0 → v1.4 normalization via the reused shim (configured path),
//      with the correct backfilledColumns and Ratio value attached (R4)
//   4. Configured health — reachable via a mocked transport; honest failure
//      when the transport throws
//   5. Default transport is the spec's LIVE transport — exercised end to end
//      with a stubbed global fetch, so no request leaves the process
//
// No real network call in tests or CI.

import { afterEach, describe, it, expect, vi } from 'vitest';
import { CloudConnectorAdapter, type FocusExportTransport } from './CloudConnectorAdapter';
import {
  AZURE_CONNECTOR_SPEC,
  AWS_CONNECTOR_SPEC,
  GCP_CONNECTOR_SPEC,
  AZURE_SOURCE_ID,
} from './cloudConnectorConfig';
import { KUBERNETES_CONNECTOR_SPEC } from './kubernetesConfig';
import { NUTANIX_CONNECTOR_SPEC } from './nutanixConfig';
import { FOCUS_ENDPOINT_CONNECTOR_SPEC } from './focusEndpointConfig';
import type { ConnectorSpec } from './connectorConfig';
import { columnsAddedAfter } from './focusVersions';
import { rawRowsForVersion } from './seed';

const WINDOW = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };

const CONFIGURED_ENV: Record<string, Record<string, string>> = {
  [AZURE_CONNECTOR_SPEC.id]: {
    COSTSOURCE_AZURE_LIVE: 'true',
    AZURE_FOCUS_EXPORT_URL: 'https://example.blob.core.windows.net/focus',
    AZURE_FOCUS_SAS: 'sv=2024-01-01&sig=abc',
  },
  [AWS_CONNECTOR_SPEC.id]: {
    COSTSOURCE_AWS_LIVE: 'true',
    AWS_FOCUS_EXPORT_BUCKET: 'ratio-focus-exports',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'secret',
  },
  [GCP_CONNECTOR_SPEC.id]: {
    COSTSOURCE_GCP_LIVE: 'true',
    GCP_FOCUS_BQ_DATASET: 'billing.focus_export',
    GCP_PROJECT_ID: 'ratio-prod',
    GOOGLE_APPLICATION_CREDENTIALS: '/secrets/gcp.json',
  },
  [KUBERNETES_CONNECTOR_SPEC.id]: {
    COSTSOURCE_KUBERNETES_LIVE: 'true',
    KUBERNETES_FOCUS_ENDPOINT: 'http://opencost.kube-system.svc/focus',
  },
  [NUTANIX_CONNECTOR_SPEC.id]: {
    COSTSOURCE_NUTANIX_LIVE: 'true',
    NUTANIX_ENDPOINT: 'https://ncm.example/api/cost',
    NUTANIX_API_KEY: 'ntnx-key',
  },
  [FOCUS_ENDPOINT_CONNECTOR_SPEC.id]: {
    FOCUS_ENDPOINT_URL: 'https://billing.internal.example/focus?from={start}',
    FOCUS_ENDPOINT_TOKEN: 'internal-token',
  },
};

/** A fake transport returning seed-derived FOCUS v1.0 export rows. */
function makeMockTransport(overrides: Partial<FocusExportTransport> = {}): FocusExportTransport {
  return {
    ping: async () => true,
    fetchExportRows: async () => rawRowsForVersion('1.0'),
    ...overrides,
  };
}

const SPECS: ConnectorSpec[] = [
  AZURE_CONNECTOR_SPEC,
  AWS_CONNECTOR_SPEC,
  GCP_CONNECTOR_SPEC,
  KUBERNETES_CONNECTOR_SPEC,
  NUTANIX_CONNECTOR_SPEC,
  FOCUS_ENDPOINT_CONNECTOR_SPEC,
];

// ---------------------------------------------------------------------------
// 1. Not configured — honest, and provably no network
// ---------------------------------------------------------------------------

describe.each(SPECS)('CloudConnectorAdapter [$id] — not configured (available)', (spec) => {
  it('healthCheck is not reachable / not authed and makes no network call', async () => {
    const transportFactory = vi.fn(() => makeMockTransport());
    const health = await new CloudConnectorAdapter(spec, { env: {}, transportFactory }).healthCheck();
    expect(health.sourceId).toBe(spec.id);
    expect(health.reachable).toBe(false);
    expect(health.authed).toBe(false);
    expect(health.canonicalVersion).toBe('1.4');
    expect(health.detail).toMatch(/ready to connect/i);
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('kill-switch keeps a fully configured connector off the network', async () => {
    const transportFactory = vi.fn(() => makeMockTransport());
    const adapter = new CloudConnectorAdapter(spec, {
      env: { ...CONFIGURED_ENV[spec.id], [spec.flagEnv]: 'false' },
      transportFactory,
    });
    expect((await adapter.healthCheck()).detail).toMatch(/disabled/i);
    await expect(adapter.fetchCostRows(WINDOW)).rejects.toThrow(/not configured \(disabled\)/i);
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('fetchCostRows throws a typed not-configured error with no network call', async () => {
    const transportFactory = vi.fn(() => makeMockTransport());
    const adapter = new CloudConnectorAdapter(spec, { env: {}, transportFactory });
    await expect(adapter.fetchCostRows(WINDOW)).rejects.toThrow(/not configured/i);
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('describe() marks the source available for listSources', () => {
    const descriptor = new CloudConnectorAdapter(spec, { env: {} }).describe();
    expect(descriptor.id).toBe(spec.id);
    expect(descriptor.configured).toBe(false);
    expect(descriptor.connection).toBe('available');
    expect(descriptor.capabilities).toContain('costRows');
  });
});

// ---------------------------------------------------------------------------
// 2. Partially configured
// ---------------------------------------------------------------------------

describe('CloudConnectorAdapter — flag ON but unconfigured', () => {
  it('healthCheck is honest about missing credentials and makes no network call', async () => {
    const transportFactory = vi.fn(() => makeMockTransport());
    const adapter = new CloudConnectorAdapter(AZURE_CONNECTOR_SPEC, {
      env: { COSTSOURCE_AZURE_LIVE: 'true' },
      transportFactory,
    });
    const health = await adapter.healthCheck();
    expect(health.reachable).toBe(false);
    expect(health.authed).toBe(false);
    expect(health.detail).toMatch(/still missing AZURE_FOCUS_EXPORT_URL, AZURE_FOCUS_SAS/);
    expect(transportFactory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. FOCUS v1.0 → v1.4 normalization via the reused shim (configured path)
// ---------------------------------------------------------------------------

describe.each(SPECS)('CloudConnectorAdapter [$id] — fetchCostRows (configured)', (spec) => {
  it('normalizes the FOCUS v1.0 export up to the v1.4 canonical model', async () => {
    const transportFactory = vi.fn(() => makeMockTransport());
    const adapter = new CloudConnectorAdapter(spec, {
      env: CONFIGURED_ENV[spec.id],
      transportFactory,
    });

    const result = await adapter.fetchCostRows(WINDOW);
    expect(result.sourceId).toBe(spec.id);
    expect(result.sourceVersion).toBe('1.0');
    expect(result.canonicalVersion).toBe('1.4');
    expect(result.backfilledColumns).toEqual(columnsAddedAfter('1.0'));
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
    expect(row.x_RatioSourceId).toBe(spec.id);
    expect(row.x_RatioSourceVersion).toBe('1.0');
  });
});

// ---------------------------------------------------------------------------
// 4. Configured health
// ---------------------------------------------------------------------------

describe('CloudConnectorAdapter — healthCheck (configured)', () => {
  it('is reachable + authed when the transport pings successfully', async () => {
    const transportFactory = vi.fn(() => makeMockTransport({ ping: async () => true }));
    const adapter = new CloudConnectorAdapter(AZURE_CONNECTOR_SPEC, {
      env: CONFIGURED_ENV[AZURE_SOURCE_ID],
      transportFactory,
    });
    const health = await adapter.healthCheck();
    expect(health.reachable).toBe(true);
    expect(health.authed).toBe(true);
    expect(transportFactory).toHaveBeenCalledTimes(1);
  });

  it('degrades to an honest unreachable state when the transport throws', async () => {
    const transportFactory = vi.fn(() =>
      makeMockTransport({
        ping: async () => {
          throw new Error('endpoint refused');
        },
      }),
    );
    const adapter = new CloudConnectorAdapter(AZURE_CONNECTOR_SPEC, {
      env: CONFIGURED_ENV[AZURE_SOURCE_ID],
      transportFactory,
    });
    const health = await adapter.healthCheck();
    expect(health.reachable).toBe(false);
    expect(health.authed).toBe(false);
    expect(health.detail).toMatch(/health check failed/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Default transport is the live one (stubbed fetch — nothing leaves the process)
// ---------------------------------------------------------------------------

const FOCUS_CSV = [
  'BilledCost,EffectiveCost,BillingCurrency,ChargePeriodStart,ChargePeriodEnd,ProviderName,ServiceName,ResourceId',
  '120.5,110,USD,2026-06-03T00:00:00Z,2026-06-04T00:00:00Z,Microsoft,Azure OpenAI,arn:ratio:workload/wl-001',
  '9.99,9.99,USD,2026-05-30T00:00:00Z,2026-05-31T00:00:00Z,Microsoft,Storage,/subs/x/storage',
].join('\n');

describe('CloudConnectorAdapter — default live transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the configured endpoint with its credential and normalizes the export', async () => {
    const fetchMock = vi.fn(async () => new Response(FOCUS_CSV, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudConnectorAdapter(FOCUS_ENDPOINT_CONNECTOR_SPEC, {
      env: CONFIGURED_ENV[FOCUS_ENDPOINT_CONNECTOR_SPEC.id],
    });
    const result = await adapter.fetchCostRows(WINDOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://billing.internal.example/focus?from=${encodeURIComponent(WINDOW.start)}`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer internal-token');

    // Only the in-window row survives; it is upgraded to v1.4 and valued (R4).
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].BilledCost).toBe(120.5);
    expect(result.rows[0].ListCost).toBe(120.5); // backfilled by the shim
    expect(result.rows[0].x_RatioWorkloadId).toBe('wl-001');
    expect(result.backfilledColumns).toEqual(columnsAddedAfter('1.0'));
  });

  it('reports an honest health failure when the live source rejects the credential', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
    const health = await new CloudConnectorAdapter(NUTANIX_CONNECTOR_SPEC, {
      env: CONFIGURED_ENV[NUTANIX_CONNECTOR_SPEC.id],
    }).healthCheck();
    expect(health.reachable).toBe(false);
    expect(health.detail).toMatch(/health check failed: .*403/);
  });
});

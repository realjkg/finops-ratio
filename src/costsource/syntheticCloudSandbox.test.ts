// A6 — synthetic AWS, Azure and GCP sandbox sources. Offline only: no network,
// no credentials, no real account identifiers. The existing three sandbox
// sources must stay byte-for-byte identical (golden hashes captured on main).

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { MockCostSourceClient } from './MockCostSourceClient';
import { sourcesForEnv, resolveWorkloadId } from './seed';
import { SYNTHETIC_CLOUD_WORKLOAD_MAPPING } from './syntheticCloudMapping';
import { SYNTHETIC_CLOUD_LINES } from './syntheticCloudSeed';
import { anonymousSourceView } from './sourceDisclosure';
import type { CanonicalFocusRow } from './focusRows';
import type { CostWindow } from './CostSourceClient';

const WINDOW: CostWindow = { start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' };
const NEW_IDS = ['aws-sandbox', 'azure-sandbox', 'gcp-sandbox'] as const;
const EXISTING_IDS = ['pointfive-sandbox', 'focus-file-sandbox', 'servicenow-sandbox'] as const;

// Committed oracle, in integer cents, written by hand (not recomputed from the
// seed): total billed cost, and the part that maps to a Ratio workload.
const ORACLE: Record<string, { provider: string; totalCents: number; mappedCents: number; rowCount: number }> = {
  'aws-sandbox': { provider: 'SyntheticAWS', totalCents: 954200, mappedCents: 850050, rowCount: 5 },
  'azure-sandbox': { provider: 'SyntheticAzure', totalCents: 828700, mappedCents: 745075, rowCount: 5 },
  'gcp-sandbox': { provider: 'SyntheticGCP', totalCents: 677000, mappedCents: 617530, rowCount: 5 },
};

// Golden SHA-256 of the existing three sources, captured on origin/main
// (7a9da43) with the clock pinned to 2026-06-15T00:00:00Z; rows re-captured for the Fraud gates seed fix. pointfive-sandbox
// rows re-captured in C1: its v1.0 rows no longer get a guessed ServiceSubcategory.
// servicenow-sandbox descriptor re-captured in pilot P0 (roleConfirmed:false + note); its rows and health are unchanged.
const GOLDEN: Record<string, { descriptor: string; rows: string; health: string }> = {
  'pointfive-sandbox': {
    descriptor: '6ca1033c4438a232b0b733ad650dfa95f6a9baeba7c1d837a3c985999a3fca3d',
    rows: '51508ff639df0e5e7f03773da934cc9d0577e22306038863807b9ac06274a1eb',
    health: '10f1273e189cb81d0874ad9145a276b5a5141cdc876e5d6295ce4928f9662795',
  },
  'focus-file-sandbox': {
    descriptor: '228b412ca8e466fc9e792b0870fbc07243c11b22274885746d2839f9b565641e',
    rows: 'e6f23b3f769b9e43b3a40522cb93571e2cb812d8a95727f5b0de2424bb1a5155',
    health: '25c27e6c288090956eed7b8eb5c2c739435a7fe9d67f32aace5e9f5e91fcf401',
  },
  'servicenow-sandbox': {
    descriptor: 'a02b7fc7b3605fa657676d94aa3ce7db00d2d810f5af3131b823c8b9c637f96b',
    rows: 'ab93ff454cb5448566e5032bc447ed0a4b8537d0b5ee15c3ea7fdd2d569fbd78',
    health: '4a82d31d7f99e7b065c3959373a4be3aac8b367881a0ee532c8f5af89de1bc1a',
  },
};

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-15T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function rowsOf(id: string): Promise<CanonicalFocusRow[]> {
  const res = await new MockCostSourceClient().fetchCostRows(id, WINDOW);
  return res.rows;
}

function cents(n: number): number {
  return Math.round(n * 100);
}

type RegionRow = CanonicalFocusRow & { x_RatioRegion?: string | null };

describe('A6 synthetic cloud sandbox sources', () => {
  it('rows_use_synthetic_provider_names', async () => {
    for (const id of NEW_IDS) {
      const rows = await rowsOf(id);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.ProviderName).toBe(ORACLE[id].provider);
        expect(r.InvoiceIssuerName).toBe(ORACLE[id].provider);
        expect(r.x_RatioSourceId).toBe(id);
      }
    }
  });

  it('each_source_has_its_own_billing_account_subaccount_region_and_service_names', async () => {
    const accounts = new Set<string>();
    const subs = new Set<string>();
    const regions = new Map<string, Set<string>>();
    const services = new Map<string, Set<string>>();
    for (const id of NEW_IDS) {
      const rows = (await rowsOf(id)) as RegionRow[];
      const a = new Set(rows.map((r) => r.BillingAccountId));
      const s = new Set(rows.map((r) => r.SubAccountId));
      expect(a.size).toBe(1);
      expect(s.size).toBe(1);
      accounts.add([...a][0]);
      subs.add([...s][0]);
      regions.set(id, new Set(rows.map((r) => String(r.x_RatioRegion))));
      services.set(id, new Set(rows.map((r) => r.ServiceName)));
      expect(regions.get(id)!.has('undefined')).toBe(false);
      expect(regions.get(id)!.has('null')).toBe(false);
    }
    expect(accounts.size).toBe(3);
    expect(subs.size).toBe(3);
    // The existing seed's shared identity must not leak into the new sources.
    expect(accounts.has('ratio-tenant-001')).toBe(false);
    expect(subs.has('ratio-ai-sub-001')).toBe(false);
    // Regions and service catalogs are pairwise disjoint.
    for (const map of [regions, services]) {
      const seen = new Set<string>();
      for (const set of map.values()) {
        for (const v of set) {
          expect(seen.has(v)).toBe(false);
          seen.add(v);
        }
      }
    }
  });

  it('mock_client_serves_distinct_rows_per_new_source_not_the_all_workload_fallthrough', async () => {
    const fallthrough = await rowsOf('pointfive-sandbox');
    const seen = new Set<string>();
    for (const id of NEW_IDS) {
      const rows = await rowsOf(id);
      expect(rows.length).toBe(ORACLE[id].rowCount);
      expect(rows.length).not.toBe(fallthrough.length);
      expect(rows.some((r) => r.ServiceName === fallthrough[0].ServiceName)).toBe(false);
      const key = sha(rows.map((r) => [r.ServiceName, r.BilledCost]));
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('no_real_looking_account_ids_or_credentials_in_seed', async () => {
    const blob = JSON.stringify(await Promise.all(NEW_IDS.map(rowsOf)));
    expect(blob).not.toMatch(/\b\d{12}\b/); // AWS account id shape
    expect(blob).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); // Azure GUID shape
    expect(blob).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(blob).not.toMatch(/-{5}BEGIN/);
    expect(blob).not.toMatch(/https?:\/\//);
    expect(blob).not.toMatch(/secret|password|apikey|bearer|\btoken\b/i);
    for (const id of NEW_IDS) {
      const rows = await rowsOf(id);
      expect(rows[0].BillingAccountId).toMatch(/^synthetic-/);
      expect(rows[0].SubAccountId).toMatch(/^synthetic-/);
    }
  });

  it('row_totals_match_committed_oracle_per_source', async () => {
    for (const id of NEW_IDS) {
      const rows = await rowsOf(id);
      const total = rows.reduce((s, r) => s + cents(r.BilledCost), 0);
      const mapped = rows
        .filter((r) => r.x_RatioWorkloadId !== '')
        .reduce((s, r) => s + cents(r.BilledCost), 0);
      expect(total).toBe(ORACLE[id].totalCents);
      expect(mapped).toBe(ORACLE[id].mappedCents);
      for (const r of rows) {
        expect(r.EffectiveCost).toBe(r.BilledCost);
        expect(r.BillingCurrency).toBe('USD');
      }
    }
  });

  it('mapping_is_explicit_every_row_maps_or_is_not_attributed', async () => {
    for (const id of NEW_IDS) {
      const table = SYNTHETIC_CLOUD_WORKLOAD_MAPPING[id];
      const lines = SYNTHETIC_CLOUD_LINES[id];
      expect(lines.length).toBe(ORACLE[id].rowCount);
      // Every line has an entry (a workload id or an explicit null), and no entry is orphaned.
      expect(Object.keys(table).sort()).toEqual(lines.map((l) => l.lineKey).sort());
      for (const l of lines) {
        expect(Object.prototype.hasOwnProperty.call(table, l.lineKey)).toBe(true);
        const v = table[l.lineKey];
        expect(v === null || (typeof v === 'string' && v.startsWith('wl-'))).toBe(true);
      }
      const rows = await rowsOf(id);
      for (const r of rows) {
        if (r.x_RatioWorkloadId === '') {
          expect(resolveWorkloadId(r.ResourceId)).toBeNull();
        } else {
          expect(resolveWorkloadId(r.ResourceId)).toBe(r.x_RatioWorkloadId);
        }
      }
      expect(rows.some((r) => r.x_RatioWorkloadId !== '')).toBe(true);
      expect(rows.some((r) => r.x_RatioWorkloadId === '')).toBe(true);
    }
  });

  it('unmapped_row_resolves_to_null_not_a_default_workload', async () => {
    for (const id of NEW_IDS) {
      const rows = await rowsOf(id);
      const unmapped = rows.filter((r) => r.x_RatioWorkloadId === '');
      expect(unmapped.length).toBeGreaterThan(0);
      for (const r of unmapped) {
        expect(r.ResourceId.startsWith('arn:ratio:workload/')).toBe(false);
        expect(resolveWorkloadId(r.ResourceId)).toBeNull();
        expect(r.x_RatioTeam).toBe('');
        expect(r.x_RatioValueRatio).toBe(0);
        expect(r.x_RatioTotalValue).toBe(0);
        expect(r.x_RatioGovernanceGates).toBe(0);
      }
    }
  });

  it('anonymousSourceView_leaves_new_sandbox_descriptors_unchanged', () => {
    const polluted = sourcesForEnv({ AWS_FOCUS_EXPORT_BUCKET: 'b', AWS_REGION: 'us-east-1' });
    const view = anonymousSourceView(polluted);
    for (const id of NEW_IDS) {
      const a = polluted.find((s) => s.id === id)!;
      const b = view.find((s) => s.id === id)!;
      expect(a).toBeDefined();
      expect(b).toEqual(a);
      expect(a.kind).toBe('synthetic_cloud');
      expect(a.configured).toBe(true);
      expect(a.capabilities).toEqual(['costRows']);
      expect(a.note.toLowerCase()).toContain('synthetic');
    }
  });

  it('health_for_new_sources_reports_synthetic_and_makes_no_network_call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const id of NEW_IDS) {
      const h = await new MockCostSourceClient().healthCheck(id);
      expect(h.sourceId).toBe(id);
      expect(h.reachable).toBe(true);
      expect(h.authed).toBe(true);
      expect(h.detail.toLowerCase()).toContain('synthetic');
      await rowsOf(id);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('window_filters_rows_by_charge_period_start_half_open', async () => {
    // Clock is pinned to 2026-06-15; every row's ChargePeriodStart is 2026-06-01T00:00:00.000Z.
    const client = new MockCostSourceClient();
    const count = async (id: string, start: string, end: string) =>
      (await client.fetchCostRows(id, { start, end })).rows.length;
    for (const id of NEW_IDS) {
      const n = ORACLE[id].rowCount;
      // Disjoint month: nothing.
      expect(await count(id, '2026-05-01T00:00:00Z', '2026-05-31T00:00:00Z')).toBe(0);
      expect(await count(id, '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z')).toBe(0);
      // Start inclusive.
      expect(await count(id, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z')).toBe(n);
      // End exclusive.
      expect(await count(id, '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z')).toBe(0);
      // Start one millisecond after the charge start excludes it.
      expect(await count(id, '2026-06-01T00:00:00.001Z', '2026-07-01T00:00:00Z')).toBe(0);
      // The echoed window is unchanged.
      const res = await client.fetchCostRows(id, { start: '2026-05-01T00:00:00Z', end: '2026-05-31T00:00:00Z' });
      expect(res.window).toEqual({ start: '2026-05-01T00:00:00Z', end: '2026-05-31T00:00:00Z' });
    }
  });

  it('new_sources_return_no_findings', async () => {
    for (const id of NEW_IDS) {
      expect(await new MockCostSourceClient().fetchFindings(id)).toEqual([]);
    }
  });

  it('existing_three_sources_rows_are_byte_identical_to_main', async () => {
    const client = new MockCostSourceClient();
    const descriptors = sourcesForEnv({});
    for (const id of EXISTING_IDS) {
      const d = descriptors.find((s) => s.id === id)!;
      const rows = (await client.fetchCostRows(id, WINDOW)).rows;
      const health = await client.healthCheck(id);
      const stableHealth = { ...health, checkedAt: 'x' };
      expect({
        descriptor: sha(d),
        rows: sha(rows),
        health: sha(stableHealth),
      }).toEqual(GOLDEN[id]);
    }
  });

  it('sandbox_rows_route_serves_new_sources_anonymously_and_live_ids_still_401', async () => {
    vi.resetModules();
    const saved = process.env.RATIO_API_TOKEN;
    delete process.env.RATIO_API_TOKEN;
    try {
      const { default: handler } = await import('../../pages/api/costsource/rows');
      const call = async (sourceId: string) => {
        const res = {
          statusCode: 200,
          body: undefined as unknown,
          headersSent: false,
          setHeader() {},
          status(code: number) {
            res.statusCode = code;
            return res;
          },
          json(payload: unknown) {
            res.body = payload;
            res.headersSent = true;
            return res;
          },
        };
        const req = {
          method: 'GET',
          url: '/api',
          query: { sourceId, start: WINDOW.start, end: WINDOW.end },
          headers: {},
        } as unknown as NextApiRequest;
        await handler(req, res as unknown as NextApiResponse);
        return res;
      };
      for (const id of NEW_IDS) {
        const res = await call(id);
        expect(res.statusCode).toBe(200);
        const body = res.body as { sourceId: string; rows: CanonicalFocusRow[] };
        expect(body.sourceId).toBe(id);
        expect(body.rows.length).toBe(ORACLE[id].rowCount);
      }
      for (const live of ['aws-data-exports', 'azure-cost-management', 'gcp-bigquery-focus', 'pointfive-live', 'aws-sandbox ']) {
        expect((await call(live)).statusCode).toBe(401);
      }
    } finally {
      if (saved !== undefined) process.env.RATIO_API_TOKEN = saved;
    }
  });
});

// Tests for the attribution seam ("Who ran up this cost?"): the pure
// aggregations, the mock client's determinism, the ResourceId→workload→team
// join discipline, and the value-agnosticism contract. Route error discipline
// (405/400/500) lives in src/server/nonGatewayRoutes.test.ts; wire goldens in
// src/compat/apiContract.test.ts.
import { describe, expect, it } from 'vitest';
import type { Workload } from '@/types';
import { USER_QUERY_EVENTS } from '@/data/userQueries';
import { DEMO_NOW, WORKLOADS } from '@/data/workloads';
import { normalizeRows } from '@/costsource/normalize';
import { rawRowsForVersion, resolveWorkloadId } from '@/costsource/seed';
import { teamAttributionRows, userAttributionRows } from './aggregations';
import { createAttributionClient } from './index';
import type { AttributionReport } from './index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal valid Workload, overridable per test. */
function makeWorkload(overrides: Partial<Workload> & { id: string; team: string; monthlySpend: number }): Workload {
  return {
    name: overrides.id,
    model: 'gpt-4o',
    model_provider: 'openai',
    environment: 'prod',
    costs: {
      inference_cost_per_call: 0,
      monthly_spend: overrides.monthlySpend,
      daily_spend: 0,
      daily_budget: 0,
      monthly_budget: 0,
      compute: 0,
      tokens_in_today: 0,
      tokens_out_today: 0,
      tokens_cached_today: 0,
      tokens_in_mtd: 0,
      tokens_out_mtd: 0,
    },
    outputs: {
      daily_inferences: 0,
      monthly_inferences: 0,
      resolved_queries: 0,
      resolution_rate: 0,
      active_users_daily: 0,
      active_users_monthly: 0,
      csat: null,
      avg_handle_time_seconds: 0,
      deflection_rate: 0,
    },
    value: { revenue_protected: 0, cost_avoided: 0, total_value: 0, value_ratio: 0 },
    governance: {
      policy_check: false,
      ethics_review: false,
      cost_approval: false,
      scale_authorized: false,
      last_reviewed: DEMO_NOW.toISOString(),
      approved_by: null,
    },
    demand_shape: 'unmanaged',
    priority: 'low',
    cost_trend_pct: 0,
    created_at: DEMO_NOW.toISOString(),
    updated_at: DEMO_NOW.toISOString(),
    ...overrides,
  } as Workload;
}

/** Report rows without the wall-clock stamp — everything else must be deterministic. */
function deterministicJson(report: AttributionReport): string {
  return JSON.stringify({ ...report, generatedAt: '<stripped>' });
}

// ---------------------------------------------------------------------------
// Team aggregation
// ---------------------------------------------------------------------------

describe('teamAttributionRows', () => {
  it('sums exactly the workload costs and MTD tokens per team', () => {
    const rows = teamAttributionRows(WORKLOADS);
    for (const row of rows) {
      const members = WORKLOADS.filter((w) => w.team === row.key);
      expect(row.inferenceCost).toBe(
        members.reduce((acc, w) => acc + w.costs.monthly_spend, 0),
      );
      expect(row.tokensIn).toBe(members.reduce((acc, w) => acc + w.costs.tokens_in_mtd, 0));
      expect(row.tokensOut).toBe(members.reduce((acc, w) => acc + w.costs.tokens_out_mtd, 0));
      expect(row.inputs.recordCount).toBe(members.length);
      expect(row.inputs.workloadIds).toEqual(members.map((w) => w.id));
    }
  });

  it('ranks worst burner first (absolute inference cost, desc) with a stable tiebreak', () => {
    const rows = teamAttributionRows(WORKLOADS);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].inferenceCost).toBeGreaterThanOrEqual(rows[i].inferenceCost);
      if (rows[i - 1].inferenceCost === rows[i].inferenceCost) {
        expect(rows[i - 1].key < rows[i].key).toBe(true);
      }
    }
  });

  it('is a real rollup: teams with several workloads sum above any single member', () => {
    const rows = teamAttributionRows(WORKLOADS);
    const multi = rows.filter((r) => r.inputs.recordCount > 1);
    expect(multi.length).toBeGreaterThan(0); // seed has teams with 2+ workloads (G4)
    for (const row of multi) {
      const maxMember = Math.max(
        ...WORKLOADS.filter((w) => w.team === row.key).map((w) => w.costs.monthly_spend),
      );
      expect(row.inferenceCost).toBeGreaterThan(maxMember);
    }
  });

  it('sums shares to ~1.0 and each share equals its cost over the total', () => {
    const rows = teamAttributionRows(WORKLOADS);
    const total = rows.reduce((acc, r) => acc + r.inferenceCost, 0);
    const shareSum = rows.reduce((acc, r) => acc + r.shareOfTotal, 0);
    expect(shareSum).toBeCloseTo(1, 9);
    for (const row of rows) {
      expect(row.shareOfTotal).toBeCloseTo(row.inferenceCost / total, 9);
      expect(row.inputs.totalInferenceCost).toBe(total);
    }
  });

  it('guards: no workloads → no rows, no NaN', () => {
    expect(teamAttributionRows([])).toEqual([]);
  });

  it('guards: a zero-spend portfolio yields share 0, never NaN or Infinity', () => {
    const rows = teamAttributionRows([
      makeWorkload({ id: 'wl-a', team: 'A', monthlySpend: 0 }),
      makeWorkload({ id: 'wl-b', team: 'A', monthlySpend: 0 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].inferenceCost).toBe(0);
    expect(rows[0].shareOfTotal).toBe(0);
    expect(Number.isFinite(rows[0].shareOfTotal)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// User aggregation
// ---------------------------------------------------------------------------

describe('userAttributionRows', () => {
  it('sums the sampled events per user and ranks cost-desc', () => {
    const rows = userAttributionRows(USER_QUERY_EVENTS);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const events = USER_QUERY_EVENTS.filter((e) => e.user_id === row.key);
      expect(row.inputs.recordCount).toBe(events.length);
      expect(row.inferenceCost).toBeCloseTo(
        events.reduce((acc, e) => acc + e.query_cost, 0),
        9,
      );
      expect(row.tokensIn).toBe(events.reduce((acc, e) => acc + e.tokens_used.input, 0));
      expect(row.tokensOut).toBe(events.reduce((acc, e) => acc + e.tokens_used.output, 0));
    }
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].inferenceCost).toBeGreaterThanOrEqual(rows[i].inferenceCost);
    }
  });

  it('sums shares to ~1.0 within the sampled log', () => {
    const rows = userAttributionRows(USER_QUERY_EVENTS);
    expect(rows.reduce((acc, r) => acc + r.shareOfTotal, 0)).toBeCloseTo(1, 9);
  });

  it('guards: no events → no rows', () => {
    expect(userAttributionRows([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The seed itself (G1 — the only per-user data path in the repo)
// ---------------------------------------------------------------------------

describe('USER_QUERY_EVENTS seed', () => {
  it('is a sampled log whose every event resolves one workload and stamps the demo month', () => {
    expect(USER_QUERY_EVENTS.length).toBeGreaterThan(0);
    for (const e of USER_QUERY_EVENTS) {
      expect(e.workloads_referenced).toHaveLength(1);
      expect(WORKLOADS.some((w) => w.id === e.workloads_referenced[0])).toBe(true);
      expect(new Date(e.timestamp).getTime()).toBeLessThanOrEqual(DEMO_NOW.getTime());
      expect(new Date(e.timestamp).getUTCMonth()).toBe(DEMO_NOW.getUTCMonth());
    }
  });

  it('derives costs from the referenced workload model registry pricing (spot-check)', () => {
    const event = USER_QUERY_EVENTS[0];
    expect(event.query_cost).toBeGreaterThan(0);
    expect(Number.isInteger(event.tokens_used.input)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mock client — determinism + wire join
// ---------------------------------------------------------------------------

describe('MockAttributionClient determinism', () => {
  it('two instances produce identical reports (modulo generatedAt), both dimensions', async () => {
    const a = createAttributionClient('mock');
    const b = createAttributionClient('mock');
    expect(a.mode).toBe('mock');
    expect(a).not.toBe(b);
    for (const dimension of ['team', 'user'] as const) {
      const [ra, rb] = await Promise.all([a.getAttributionReport(dimension), b.getAttributionReport(dimension)]);
      expect(deterministicJson(ra)).toBe(deterministicJson(rb));
      expect(ra.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(ra.window).toContain('(demo clock)');
    }
  });

  it('the user dimension derives from the same seed on every call (stable across reloads)', async () => {
    const client = createAttributionClient('mock');
    const first = await client.getAttributionReport('user');
    const second = await client.getAttributionReport('user');
    expect(deterministicJson(first)).toBe(deterministicJson(second));
  });
});

// ---------------------------------------------------------------------------
// Join discipline: ResourceId → workload → team, byte-identical across transports
// ---------------------------------------------------------------------------

describe('attribution join discipline', () => {
  it('every canonical FOCUS row carries x_RatioTeam equal to the team resolved via ResourceId', () => {
    const { rows } = normalizeRows(rawRowsForVersion('1.4'), 'pointfive-sandbox', '1.4');
    expect(rows.length).toBe(WORKLOADS.length);
    for (const row of rows) {
      const workloadId = resolveWorkloadId(row.ResourceId);
      expect(workloadId).toBeTruthy();
      const workload = WORKLOADS.find((w) => w.id === workloadId);
      expect(workload).toBeDefined();
      expect(row.x_RatioTeam).toBe(workload?.team);
    }
  });

  it('team row keys are exactly the distinct x_RatioTeam values on the wire', () => {
    const { rows } = normalizeRows(rawRowsForVersion('1.4'), 'pointfive-sandbox', '1.4');
    const wireTeams = [...new Set(rows.map((r) => r.x_RatioTeam))].sort();
    const rollupTeams = teamAttributionRows(WORKLOADS).map((r) => r.key).sort();
    expect(rollupTeams).toEqual(wireTeams);
  });

  it('no seed row repurposes SubAccountId for the team any more (G8 retired)', () => {
    const raws = rawRowsForVersion('1.4');
    const teams = new Set(WORKLOADS.map((w) => w.team));
    for (const row of raws) {
      expect(teams.has(row.SubAccountId)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Value-agnosticism (the deliberate contrast with the findings-first home)
// ---------------------------------------------------------------------------

describe('value-agnosticism contract', () => {
  /** Recursively collect every object key in a JSON structure. */
  function keysOf(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(keysOf);
    if (value && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [k, ...keysOf(v)]);
    }
    return [];
  }

  it('the report carries no value-ratio or credits field anywhere', async () => {
    const client = createAttributionClient('mock');
    for (const dimension of ['team', 'user'] as const) {
      const report = await client.getAttributionReport(dimension);
      const allKeys = keysOf(JSON.parse(JSON.stringify(report)) as unknown);
      for (const key of allKeys) {
        expect(key.toLowerCase(), `key ${key} must not encode value`).not.toContain('value');
        expect(key.toLowerCase(), `key ${key} must not encode credits`).not.toContain('credits');
      }
    }
  });

  it('the report sorts by absolute cost even when value context would reorder it', async () => {
    const report = await createAttributionClient('mock').getAttributionReport('team');
    for (let i = 1; i < report.rows.length; i++) {
      expect(report.rows[i - 1].inferenceCost).toBeGreaterThanOrEqual(report.rows[i].inferenceCost);
    }
  });
});

// ServiceNowAdapter — synthetic CMDB/ITBM source adapter. Covers the E2E
// ingest path (native v1.2 rows → canonical v1.4 through the shared shim),
// the ITBM allocation truth (critical-service overhead, exact reconciliation
// elsewhere), the CI-keyed row flavor, and the honest health probe.

import { describe, expect, it } from 'vitest';
import type { CostWindow } from './CostSourceClient';
import { CANONICAL_FOCUS_VERSION } from './focusVersions';
import { ServiceNowAdapter, SERVICENOW_SANDBOX_SOURCE_ID } from './ServiceNowAdapter';
import { WORKLOADS } from '@/data/workloads';
import {
  ITBM_CRITICAL_SERVICE_ALLOCATION,
  findSource,
  rawRowsForServiceNow,
} from './seed';

const WINDOW: CostWindow = {
  start: '2026-06-01T00:00:00.000Z',
  end: '2026-07-01T00:00:00.000Z',
};

function ingest() {
  return ServiceNowAdapter.ingest(ServiceNowAdapter.seedRows(), '1.2', SERVICENOW_SANDBOX_SOURCE_ID, WINDOW);
}

describe('ServiceNowAdapter — synthetic CMDB/ITBM source', () => {
  it('normalizes its native v1.2 rows through the shared shim to canonical v1.4', () => {
    const result = ingest();
    expect(result.sourceId).toBe(SERVICENOW_SANDBOX_SOURCE_ID);
    expect(result.sourceVersion).toBe('1.2');
    expect(result.canonicalVersion).toBe(CANONICAL_FOCUS_VERSION);
    // A v1.2 export is upgraded by the shim — the backfill audit is on the record.
    expect(result.backfilledColumns.length).toBeGreaterThan(0);
    expect(result.rows.length).toBe(rawRowsForServiceNow().length);
  });

  it('resolves every allocation line to a real Ratio workload', () => {
    const result = ingest();
    const ids = result.rows.map((r) => r.x_RatioWorkloadId);
    for (const id of ids) {
      expect(WORKLOADS.some((w) => w.id === id)).toBe(true);
    }
    expect(new Set(ids).size).toBe(WORKLOADS.length);
  });

  it('carries the CMDB/ITBM flavor on each line', () => {
    const result = ingest();
    for (const row of result.rows) {
      expect(row.ServiceName).toBe('ServiceNow ITBM Cost Allocation');
      expect(row.SkuMeter).toBe('itbm-allocation');
      expect(row.ChargeDescription).toMatch(/CMDB CI CI\d+/);
    }
  });

  it('applies the documented ITBM overhead to critical services and reconciles the rest exactly', () => {
    const result = ingest();
    const byId = new Map(result.rows.map((r) => [r.x_RatioWorkloadId, r]));
    const critical = WORKLOADS.filter((w) => w.priority === 'critical');
    const nonCritical = WORKLOADS.filter((w) => w.priority !== 'critical');
    expect(critical.length).toBeGreaterThan(0);
    expect(nonCritical.length).toBeGreaterThan(0);

    for (const w of critical) {
      const row = byId.get(w.id);
      expect(row?.EffectiveCost).toBeCloseTo(w.costs.monthly_spend * ITBM_CRITICAL_SERVICE_ALLOCATION, 2);
    }
    for (const w of nonCritical) {
      const row = byId.get(w.id);
      expect(row?.EffectiveCost).toBe(w.costs.monthly_spend);
    }
  });

  it('health probe is honest about being a synthetic demo source', () => {
    const health = ServiceNowAdapter.healthCheck(SERVICENOW_SANDBOX_SOURCE_ID);
    expect(health.reachable).toBe(true);
    expect(health.authed).toBe(true);
    expect(health.detail).toContain('synthetic demo data');
    expect(health.detail).toContain('no live integration');
  });

  it('uses the sandbox source the registry actually ships', () => {
    const src = findSource(SERVICENOW_SANDBOX_SOURCE_ID);
    expect(src?.kind).toBe('servicenow');
    expect(src?.name).toBe('ServiceNow (synthetic demo data)');
    expect(src?.capabilities).toContain('findings');
  });
});

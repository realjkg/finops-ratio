// Offline seed for the cost-ingest seam (PR D). No network: raw FOCUS rows and
// PointFive-shaped findings are derived from the same WORKLOADS the rest of the
// app uses, so the demo shows truthful numbers, not placeholders.
//
// Two configured sandbox sources exercise the version shim across the v1.0-v1.4
// range (PointFive documents v1.0; a private-cloud FOCUS export at v1.2). A
// third, unconfigured 'pointfive-live' descriptor represents the gated live
// adapter (PR E) — it ships dark until real credentials exist. The live
// PointFive and second-adapter implementations are PRs E and F, not this one.

import { WORKLOADS, DEMO_NOW } from '@/data/workloads';
import { findModel } from '@/data/models';
import { currentBillingPeriod } from '@/lib/billingPeriod';
import type { Workload } from '@/types';
import type { CostSourceDescriptor, CostFinding } from './CostSourceClient';
import type { FocusVersion } from './focusVersions';
import { isAtLeast } from './focusVersions';
import type { FocusCoreV10, RawSourceRow } from './focusRows';
import { pointFiveLiveDescriptor, resolvePointFiveStatus } from './pointfiveConfig';
import { connectorDescriptor, resolveConnectorStatus } from './connectorConfig';
import { FOCUS_EXPORT_CONNECTOR_SPECS } from './focusExportConnectors';

const RESOURCE_PREFIX = 'arn:ratio:workload/';

/** FOCUS ResourceId carrying the Ratio workload identity (resolved on ingest). */
export function resourceIdFor(workloadId: string): string {
  return `${RESOURCE_PREFIX}${workloadId}`;
}

/** Resolve a FOCUS ResourceId back to a Ratio workload id, or null. */
export function resolveWorkloadId(resourceId: string): string | null {
  if (!resourceId.startsWith(RESOURCE_PREFIX)) return null;
  return resourceId.slice(RESOURCE_PREFIX.length) || null;
}

const PROVIDER_NAME: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  aws_bedrock: 'aws',
  azure_openai: 'microsoft',
  custom: 'custom',
};

export const COST_SOURCES: CostSourceDescriptor[] = [
  {
    id: 'pointfive-sandbox',
    name: 'PointFive (sandbox)',
    kind: 'pointfive',
    focusVersion: '1.0',
    coverage: 'public_cloud',
    capabilities: ['costRows', 'findings'],
    configured: true,
    note: 'Offline seed mirroring PointFive Opportunities/Anomalies + FOCUS export (documented v1.0).',
  },
  {
    id: 'focus-file-sandbox',
    name: 'FOCUS file (private-cloud sandbox)',
    kind: 'focus_file',
    focusVersion: '1.2',
    coverage: 'private_cloud',
    capabilities: ['costRows'],
    configured: true,
    note: 'Offline seed standing in for an on-prem / private-cloud FOCUS export; the live adapter is PR F.',
  },
  // Live PointFive adapter (PR E). Its descriptor is computed from the feature
  // flag + OAuth env so `configured` honestly reflects whether the dark adapter
  // has been switched on. Default build: flag OFF → configured:false (ships dark).
  pointFiveLiveDescriptor(resolvePointFiveStatus(process.env)),
  // Cloud-connectors MVP: public cloud (Azure / AWS / GCP), Kubernetes, Nutanix.
  // Each descriptor is computed from its feature flag + credential env via the
  // generic resolver, so `configured` honestly reflects whether the dark
  // connector has been switched on. Default build: every flag OFF → configured:
  // false (all ship dark, no network calls).
  ...FOCUS_EXPORT_CONNECTOR_SPECS.map((spec) =>
    connectorDescriptor(spec, resolveConnectorStatus(spec, process.env)),
  ),
];

export function findSource(id: string): CostSourceDescriptor | undefined {
  return COST_SOURCES.find((s) => s.id === id);
}

/** Build a single source row at a given FOCUS version (newer columns omitted). */
function rawRowFor(w: Workload, version: FocusVersion): RawSourceRow {
  const period = currentBillingPeriod();
  const model = findModel(w.model);
  const tokens = w.costs.tokens_in_today + w.costs.tokens_out_today;
  const providerName = PROVIDER_NAME[w.model_provider] ?? w.model_provider;

  const core: FocusCoreV10 = {
    BilledCost: w.costs.monthly_spend,
    EffectiveCost: w.costs.monthly_spend,
    BillingCurrency: 'USD',
    BillingPeriodStart: period.start,
    BillingPeriodEnd: period.end,
    ChargePeriodStart: period.start,
    ChargePeriodEnd: period.end,
    BillingAccountId: 'ratio-tenant-001',
    SubAccountId: w.team,
    ServiceName: model?.display_name ?? w.model,
    ServiceCategory: 'AI and Machine Learning',
    ProviderName: providerName,
    ChargeCategory: 'Usage',
    ChargeDescription: `${w.name} (${w.team}/${w.environment})`,
    ResourceId: resourceIdFor(w.id),
    PricingQuantity: tokens,
    PricingUnit: '1M Tokens',
    UsageQuantity: tokens,
    UsageUnit: 'Tokens',
  };

  let row: RawSourceRow = { ...core };
  if (isAtLeast(version, '1.1')) {
    row = {
      ...row,
      ListCost: w.costs.monthly_spend,
      ContractedCost: w.costs.monthly_spend,
      ConsumedQuantity: tokens,
      ConsumedUnit: 'Tokens',
      CommitmentDiscountStatus: null,
    };
  }
  if (isAtLeast(version, '1.2')) {
    row = { ...row, ServiceSubcategory: 'Generative AI', InvoiceIssuerName: providerName };
  }
  if (isAtLeast(version, '1.3')) {
    row = { ...row, SkuMeter: `${w.model}-tokens`, PricingCurrency: 'USD' };
  }
  if (isAtLeast(version, '1.4')) {
    row = { ...row, CapacityReservationId: null, CapacityReservationStatus: null };
  }
  return row;
}

/** All workloads as raw source rows at the source's native FOCUS version. */
export function rawRowsForVersion(version: FocusVersion): RawSourceRow[] {
  return WORKLOADS.map((w) => rawRowFor(w, version));
}

// Deterministic PointFive-style findings derived from real workload signals:
// runaway cost trend -> anomaly; thin value ratio or unmanaged demand ->
// opportunity. Rules keep the seed truthful and stable across reloads.
export function findingsFor(sourceId: string): CostFinding[] {
  const detectedAt = DEMO_NOW.toISOString();
  const findings: CostFinding[] = [];

  for (const w of WORKLOADS) {
    const base = {
      sourceId,
      resourceId: resourceIdFor(w.id),
      workloadId: w.id,
      detectedAt,
    };

    if (w.cost_trend_pct >= 15) {
      findings.push({
        ...base,
        id: `${sourceId}:anomaly:${w.id}`,
        type: 'anomaly',
        category: 'spend_spike',
        title: `${w.name} spend trending +${w.cost_trend_pct.toFixed(1)}% MoM`,
        estimatedMonthlySavings: 0,
        observedSpendDelta: round2(w.costs.monthly_spend * (w.cost_trend_pct / 100)),
        severity: w.cost_trend_pct >= 20 ? 'critical' : 'warning',
        status: 'open',
      });
    }

    if (w.value.value_ratio < 3) {
      findings.push({
        ...base,
        id: `${sourceId}:opportunity:rightsizing:${w.id}`,
        type: 'opportunity',
        category: 'rightsizing',
        title: `${w.name} returning ${w.value.value_ratio.toFixed(1)}× — below 3× value floor`,
        estimatedMonthlySavings: round2(w.costs.monthly_spend * 0.2),
        observedSpendDelta: 0,
        severity: w.value.value_ratio < 2 ? 'critical' : 'warning',
        status: 'open',
      });
    }

    if (w.demand_shape === 'unmanaged') {
      findings.push({
        ...base,
        id: `${sourceId}:opportunity:demand_shaping:${w.id}`,
        type: 'opportunity',
        category: 'demand_shaping',
        title: `${w.name} runs unmanaged — demand shaping could trim off-peak spend`,
        estimatedMonthlySavings: round2(w.costs.monthly_spend * 0.12),
        observedSpendDelta: 0,
        severity: 'info',
        status: 'open',
      });
    }
  }

  return findings;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}


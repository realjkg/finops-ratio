// Emitter for the synthetic AWS, Azure and GCP sandbox sources (card A6).
//
// Everything here is invented: provider names are SyntheticAWS / SyntheticAzure
// / SyntheticGCP, account identifiers are obviously fake strings, and there is
// no network, credential or real account data. Each source has its own billing
// account, sub-account, regions and ServiceName catalog. Rows go through the
// same normalization shim as every other source.

import { currentBillingPeriod } from '@/lib/billingPeriod';
import type { CostRowsResult, CostWindow, SourceHealth } from './CostSourceClient';
import { CANONICAL_FOCUS_VERSION } from './focusVersions';
import type { RawSourceRow } from './focusRows';
import { normalizeRows } from './normalize';
import { resourceIdFor } from './seed';
import { mappedWorkloadId } from './syntheticCloudMapping';
import {
  AWS_SANDBOX_SOURCE_ID,
  AZURE_SANDBOX_SOURCE_ID,
  GCP_SANDBOX_SOURCE_ID,
  SYNTHETIC_CLOUD_DESCRIPTORS,
  isSyntheticCloudSource,
} from './sandboxSources';

export interface SyntheticLine {
  /** Stable key into the explicit workload mapping table. */
  lineKey: string;
  serviceName: string;
  serviceCategory: string;
  serviceSubcategory: string;
  region: string;
  /** Billed cost in USD (a fixed literal; the committed oracle sums these). */
  cost: number;
  quantity: number;
  unit: string;
  skuMeter: string;
}

interface SyntheticAccount {
  providerName: string;
  billingAccountId: string;
  subAccountId: string;
}

const ACCOUNTS: Record<string, SyntheticAccount> = {
  [AWS_SANDBOX_SOURCE_ID]: {
    providerName: 'SyntheticAWS',
    billingAccountId: 'synthetic-aws-billing-0001',
    subAccountId: 'synthetic-aws-linked-0001',
  },
  [AZURE_SANDBOX_SOURCE_ID]: {
    providerName: 'SyntheticAzure',
    billingAccountId: 'synthetic-azure-billing-0001',
    subAccountId: 'synthetic-azure-subscription-0001',
  },
  [GCP_SANDBOX_SOURCE_ID]: {
    providerName: 'SyntheticGCP',
    billingAccountId: 'synthetic-gcp-billing-0001',
    subAccountId: 'synthetic-gcp-project-0001',
  },
};

export const SYNTHETIC_CLOUD_LINES: Readonly<Record<string, readonly SyntheticLine[]>> = {
  [AWS_SANDBOX_SOURCE_ID]: [
    { lineKey: 'bedrock-inference', serviceName: 'Synthetic Bedrock Inference', serviceCategory: 'AI and Machine Learning', serviceSubcategory: 'Generative AI', region: 'us-east-1', cost: 5400.0, quantity: 640000000, unit: 'Tokens', skuMeter: 'synthetic-bedrock-tokens' },
    { lineKey: 'ec2-compute', serviceName: 'Synthetic EC2 Compute', serviceCategory: 'Compute', serviceSubcategory: 'Virtual Machines', region: 'us-east-1', cost: 3100.5, quantity: 21600, unit: 'Hours', skuMeter: 'synthetic-ec2-hours' },
    { lineKey: 's3-storage', serviceName: 'Synthetic S3 Storage', serviceCategory: 'Storage', serviceSubcategory: 'Object Storage', region: 'us-west-2', cost: 640.25, quantity: 28000, unit: 'GB-Months', skuMeter: 'synthetic-s3-gb-months' },
    { lineKey: 'cloudwatch-logs', serviceName: 'Synthetic CloudWatch Logs', serviceCategory: 'Management and Governance', serviceSubcategory: 'Observability', region: 'us-west-2', cost: 212.4, quantity: 4200, unit: 'GB', skuMeter: 'synthetic-cloudwatch-gb' },
    { lineKey: 'nat-egress', serviceName: 'Synthetic NAT Egress', serviceCategory: 'Networking', serviceSubcategory: 'Network Egress', region: 'us-east-1', cost: 188.85, quantity: 3900, unit: 'GB', skuMeter: 'synthetic-nat-gb' },
  ],
  [AZURE_SANDBOX_SOURCE_ID]: [
    { lineKey: 'openai-inference', serviceName: 'Synthetic Azure OpenAI Inference', serviceCategory: 'AI and Machine Learning', serviceSubcategory: 'Generative AI', region: 'eastus2', cost: 4800.0, quantity: 510000000, unit: 'Tokens', skuMeter: 'synthetic-aoai-tokens' },
    { lineKey: 'vm-compute', serviceName: 'Synthetic Virtual Machines', serviceCategory: 'Compute', serviceSubcategory: 'Virtual Machines', region: 'eastus2', cost: 2650.75, quantity: 18200, unit: 'Hours', skuMeter: 'synthetic-vm-hours' },
    { lineKey: 'blob-storage', serviceName: 'Synthetic Blob Storage', serviceCategory: 'Storage', serviceSubcategory: 'Object Storage', region: 'westeurope', cost: 410.1, quantity: 19500, unit: 'GB-Months', skuMeter: 'synthetic-blob-gb-months' },
    { lineKey: 'log-analytics', serviceName: 'Synthetic Log Analytics', serviceCategory: 'Management and Governance', serviceSubcategory: 'Observability', region: 'westeurope', cost: 305.55, quantity: 2600, unit: 'GB', skuMeter: 'synthetic-loganalytics-gb' },
    { lineKey: 'bandwidth-egress', serviceName: 'Synthetic Bandwidth', serviceCategory: 'Networking', serviceSubcategory: 'Network Egress', region: 'eastus2', cost: 120.6, quantity: 1500, unit: 'GB', skuMeter: 'synthetic-bandwidth-gb' },
  ],
  [GCP_SANDBOX_SOURCE_ID]: [
    { lineKey: 'vertex-prediction', serviceName: 'Synthetic Vertex AI Prediction', serviceCategory: 'AI and Machine Learning', serviceSubcategory: 'Generative AI', region: 'us-central1', cost: 3900.0, quantity: 420000000, unit: 'Tokens', skuMeter: 'synthetic-vertex-tokens' },
    { lineKey: 'gce-compute', serviceName: 'Synthetic Compute Engine', serviceCategory: 'Compute', serviceSubcategory: 'Virtual Machines', region: 'us-central1', cost: 2275.3, quantity: 15400, unit: 'Hours', skuMeter: 'synthetic-gce-hours' },
    { lineKey: 'gcs-storage', serviceName: 'Synthetic Cloud Storage', serviceCategory: 'Storage', serviceSubcategory: 'Object Storage', region: 'europe-west4', cost: 355.45, quantity: 16800, unit: 'GB-Months', skuMeter: 'synthetic-gcs-gb-months' },
    { lineKey: 'cloud-logging', serviceName: 'Synthetic Cloud Logging', serviceCategory: 'Management and Governance', serviceSubcategory: 'Observability', region: 'europe-west4', cost: 140.2, quantity: 1900, unit: 'GB', skuMeter: 'synthetic-logging-gb' },
    { lineKey: 'network-egress', serviceName: 'Synthetic Network Egress', serviceCategory: 'Networking', serviceSubcategory: 'Network Egress', region: 'us-central1', cost: 99.05, quantity: 1100, unit: 'GB', skuMeter: 'synthetic-egress-gb' },
  ],
};

type SyntheticRawRow = RawSourceRow & { x_RatioRegion: string };

/** Raw FOCUS v1.4 rows for one synthetic source. Throws for any other id. */
export function syntheticCloudRawRows(sourceId: string): SyntheticRawRow[] {
  const account = ACCOUNTS[sourceId];
  const lines = SYNTHETIC_CLOUD_LINES[sourceId];
  if (!account || !lines) throw new Error(`Unknown synthetic cloud source '${sourceId}'`);
  const period = currentBillingPeriod();
  return lines.map((l) => {
    const workloadId = mappedWorkloadId(sourceId, l.lineKey);
    return {
      BilledCost: l.cost,
      EffectiveCost: l.cost,
      ListCost: l.cost,
      ContractedCost: l.cost,
      BillingCurrency: 'USD',
      PricingCurrency: 'USD',
      BillingPeriodStart: period.start,
      BillingPeriodEnd: period.end,
      ChargePeriodStart: period.start,
      ChargePeriodEnd: period.end,
      BillingAccountId: account.billingAccountId,
      SubAccountId: account.subAccountId,
      ServiceName: l.serviceName,
      ServiceCategory: l.serviceCategory,
      ServiceSubcategory: l.serviceSubcategory,
      ProviderName: account.providerName,
      InvoiceIssuerName: account.providerName,
      ChargeCategory: 'Usage',
      ChargeDescription: `${l.serviceName} (${l.region}, synthetic)`,
      // Mapped lines carry the Ratio workload identity; everything else keeps a
      // synthetic id outside the workload prefix and stays "not attributed".
      ResourceId: workloadId ? resourceIdFor(workloadId) : `synthetic:${sourceId}/${l.lineKey}`,
      PricingQuantity: l.quantity,
      PricingUnit: l.unit,
      UsageQuantity: l.quantity,
      UsageUnit: l.unit,
      ConsumedQuantity: l.quantity,
      ConsumedUnit: l.unit,
      SkuMeter: l.skuMeter,
      CommitmentDiscountStatus: null,
      CapacityReservationId: null,
      CapacityReservationStatus: null,
      x_RatioRegion: l.region,
    };
  });
}

/** Normalized rows for one synthetic source, through the shared version shim. */
export function syntheticCloudRows(sourceId: string, window: CostWindow): CostRowsResult {
  const descriptor = SYNTHETIC_CLOUD_DESCRIPTORS.find((d) => d.id === sourceId);
  if (!descriptor) throw new Error(`Unknown synthetic cloud source '${sourceId}'`);
  const { rows, backfilledColumns, draftColumnsBackfilled } = normalizeRows(
    syntheticCloudRawRows(sourceId),
    sourceId,
    descriptor.focusVersion,
  );
  return {
    sourceId,
    sourceVersion: descriptor.focusVersion,
    canonicalVersion: CANONICAL_FOCUS_VERSION,
    backfilledColumns,
    draftColumnsBackfilled,
    window,
    generatedAt: new Date().toISOString(),
    rows,
  };
}

/** Health probe: always reachable, honest that the data is synthetic, no network. */
export function syntheticCloudHealth(sourceId: string): SourceHealth {
  const descriptor = SYNTHETIC_CLOUD_DESCRIPTORS.find((d) => d.id === sourceId);
  return {
    sourceId,
    reachable: Boolean(descriptor),
    authed: Boolean(descriptor),
    sourceVersion: descriptor?.focusVersion ?? CANONICAL_FOCUS_VERSION,
    canonicalVersion: CANONICAL_FOCUS_VERSION,
    checkedAt: new Date().toISOString(),
    detail: descriptor
      ? `${descriptor.name}: synthetic offline seed; no live cloud integration and no network call.`
      : `Unknown synthetic cloud source '${sourceId}'.`,
  };
}

export { isSyntheticCloudSource };

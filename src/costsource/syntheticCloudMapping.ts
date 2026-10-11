// Explicit workload mapping for the synthetic cloud sandbox sources.
//
// Every seeded line item has an entry here: either a Ratio workload id, or
// `null` meaning "not attributed". There is no default and no fallback: a
// line mapped to null (or missing) gets a ResourceId outside the
// `arn:ratio:workload/` prefix, so `resolveWorkloadId` returns null and
// normalization yields an empty `x_RatioWorkloadId` (unknown, not hidden).
// Other views follow this table or show "not attributed".

import { AWS_SANDBOX_SOURCE_ID, AZURE_SANDBOX_SOURCE_ID, GCP_SANDBOX_SOURCE_ID } from './sandboxSources';

export type SyntheticWorkloadMapping = Readonly<Record<string, string | null>>;

export const SYNTHETIC_CLOUD_WORKLOAD_MAPPING: Readonly<Record<string, SyntheticWorkloadMapping>> = {
  [AWS_SANDBOX_SOURCE_ID]: {
    'bedrock-inference': 'wl-support',
    'ec2-compute': 'wl-infrabot',
    's3-storage': null,
    'cloudwatch-logs': null,
    'nat-egress': null,
  },
  [AZURE_SANDBOX_SOURCE_ID]: {
    'openai-inference': 'wl-sales',
    'vm-compute': 'wl-fraud',
    'blob-storage': null,
    'log-analytics': null,
    'bandwidth-egress': null,
  },
  [GCP_SANDBOX_SOURCE_ID]: {
    'vertex-prediction': 'wl-knowledge',
    'gce-compute': 'wl-codereview',
    'gcs-storage': null,
    'cloud-logging': null,
    'network-egress': null,
  },
};

/** The mapped workload id, or null for "not attributed" (also for an unknown line). */
export function mappedWorkloadId(sourceId: string, lineKey: string): string | null {
  const table = SYNTHETIC_CLOUD_WORKLOAD_MAPPING[sourceId];
  if (!table || !Object.prototype.hasOwnProperty.call(table, lineKey)) return null;
  return table[lineKey];
}

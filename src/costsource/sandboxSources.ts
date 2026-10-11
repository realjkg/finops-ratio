// The offline sandbox sources: bundled seed data, no credentials, no network.
// They are the ONLY sources served anonymously by the live-data routes.
// Client-safe (no server imports), so the UI can decide which actions to offer.

import type { CostSourceDescriptor } from './CostSourceClient';

export const AWS_SANDBOX_SOURCE_ID = 'aws-sandbox';
export const AZURE_SANDBOX_SOURCE_ID = 'azure-sandbox';
export const GCP_SANDBOX_SOURCE_ID = 'gcp-sandbox';

/** The three synthetic public-cloud sandbox sources (kind `synthetic_cloud`). */
export const SYNTHETIC_CLOUD_SOURCE_IDS: readonly string[] = [
  AWS_SANDBOX_SOURCE_ID,
  AZURE_SANDBOX_SOURCE_ID,
  GCP_SANDBOX_SOURCE_ID,
];

export function isSyntheticCloudSource(sourceId: string): boolean {
  return SYNTHETIC_CLOUD_SOURCE_IDS.includes(sourceId);
}

export const OFFLINE_SANDBOX_SOURCE_IDS: ReadonlySet<string> = new Set([
  'pointfive-sandbox',
  'focus-file-sandbox',
  'servicenow-sandbox',
  ...SYNTHETIC_CLOUD_SOURCE_IDS,
]);

export function isOfflineSandboxSource(sourceId: string): boolean {
  return OFFLINE_SANDBOX_SOURCE_IDS.has(sourceId);
}

/**
 * Descriptors of the synthetic cloud sandboxes. Static: no env is read, so
 * `sourcesForEnv` stays pure. Cost rows only (no findings capability).
 */
export const SYNTHETIC_CLOUD_DESCRIPTORS: readonly CostSourceDescriptor[] = [
  {
    id: AWS_SANDBOX_SOURCE_ID,
    name: 'AWS (synthetic sandbox)',
    kind: 'synthetic_cloud',
    focusVersion: '1.4',
    coverage: 'public_cloud',
    capabilities: ['costRows'],
    configured: true,
    note: 'Synthetic AWS-shaped FOCUS rows (provider SyntheticAWS); offline seed, not a live AWS integration.',
  },
  {
    id: AZURE_SANDBOX_SOURCE_ID,
    name: 'Azure (synthetic sandbox)',
    kind: 'synthetic_cloud',
    focusVersion: '1.4',
    coverage: 'public_cloud',
    capabilities: ['costRows'],
    configured: true,
    note: 'Synthetic Azure-shaped FOCUS rows (provider SyntheticAzure); offline seed, not a live Azure integration.',
  },
  {
    id: GCP_SANDBOX_SOURCE_ID,
    name: 'GCP (synthetic sandbox)',
    kind: 'synthetic_cloud',
    focusVersion: '1.4',
    coverage: 'public_cloud',
    capabilities: ['costRows'],
    configured: true,
    note: 'Synthetic GCP-shaped FOCUS rows (provider SyntheticGCP); offline seed, not a live GCP integration.',
  },
];

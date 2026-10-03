// Tests for the config-driven connector resolvers (cloud trio + Kubernetes +
// Nutanix), all built on the generic
// `resolveConnectorStatus` helper.
//
// Coverage:
//   1. Kill-switch parsing — unset = auto, truthy = on, falsey = off
//   2. Per-connector resolvers — disabled / available / unconfigured /
//      configured branches, pure over an env record; credential-driven
//      activation with no flag; the anchor rule for host-injected credentials
//   3. Descriptor honesty — `configured` / `connection` / `setup` track status
//   4. Seed registration — every connector is registered `available` in a
//      default build without breaking the existing three sources
//
// All pure — no process.env, no network.

import { describe, it, expect } from 'vitest';
import { connectorFlag, isConnectorEnabled } from './connectorConfig';
import {
  AZURE_CONNECTOR_SPEC,
  AWS_CONNECTOR_SPEC,
  GCP_CONNECTOR_SPEC,
  AZURE_SOURCE_ID,
  AWS_SOURCE_ID,
  GCP_SOURCE_ID,
  resolveAzureStatus,
  resolveAwsStatus,
  resolveGcpStatus,
  azureDescriptor,
  awsDescriptor,
  gcpDescriptor,
} from './cloudConnectorConfig';
import {
  KUBERNETES_CONNECTOR_SPEC,
  KUBERNETES_SOURCE_ID,
  resolveKubernetesStatus,
  kubernetesDescriptor,
} from './kubernetesConfig';
import {
  NUTANIX_CONNECTOR_SPEC,
  NUTANIX_SOURCE_ID,
  resolveNutanixStatus,
  nutanixDescriptor,
} from './nutanixConfig';
import { FOCUS_EXPORT_CONNECTOR_SPECS, findConnectorSpec } from './focusExportConnectors';
import { COST_SOURCES } from './seed';

const CONFIGURED_ENV: Record<string, Record<string, string>> = {
  [AZURE_SOURCE_ID]: {
    COSTSOURCE_AZURE_LIVE: 'true',
    AZURE_FOCUS_EXPORT_URL: 'https://example.blob.core.windows.net/focus',
    AZURE_FOCUS_SAS: 'sv=2024-01-01&sig=abc',
  },
  [AWS_SOURCE_ID]: {
    COSTSOURCE_AWS_LIVE: 'true',
    AWS_FOCUS_EXPORT_BUCKET: 'ratio-focus-exports',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'secret',
  },
  [GCP_SOURCE_ID]: {
    COSTSOURCE_GCP_LIVE: 'true',
    GCP_FOCUS_BQ_DATASET: 'billing.focus_export',
    GCP_PROJECT_ID: 'ratio-prod',
    GOOGLE_APPLICATION_CREDENTIALS: '/secrets/gcp.json',
  },
  [KUBERNETES_SOURCE_ID]: {
    COSTSOURCE_KUBERNETES_LIVE: 'true',
    KUBERNETES_FOCUS_ENDPOINT: 'http://opencost.kube-system.svc/focus',
  },
  [NUTANIX_SOURCE_ID]: {
    COSTSOURCE_NUTANIX_LIVE: 'true',
    NUTANIX_ENDPOINT: 'https://ncm.example/api/cost',
    NUTANIX_API_KEY: 'ntnx-key',
  },
};

// ---------------------------------------------------------------------------
// 1. Generic flag parsing
// ---------------------------------------------------------------------------

describe('connector kill-switch', () => {
  it('is auto (enabled) when the flag is unset or empty', () => {
    expect(connectorFlag(AZURE_CONNECTOR_SPEC, {})).toBe('auto');
    expect(connectorFlag(AZURE_CONNECTOR_SPEC, { COSTSOURCE_AZURE_LIVE: '' })).toBe('auto');
    expect(isConnectorEnabled(AZURE_CONNECTOR_SPEC, {})).toBe(true);
  });

  it('is ON for explicit truthy values', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' Yes ']) {
      expect(connectorFlag(AZURE_CONNECTOR_SPEC, { COSTSOURCE_AZURE_LIVE: v })).toBe('on');
      expect(isConnectorEnabled(AZURE_CONNECTOR_SPEC, { COSTSOURCE_AZURE_LIVE: v })).toBe(true);
    }
  });

  it('is OFF only for explicit falsey values', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE']) {
      expect(connectorFlag(AZURE_CONNECTOR_SPEC, { COSTSOURCE_AZURE_LIVE: v })).toBe('off');
      expect(isConnectorEnabled(AZURE_CONNECTOR_SPEC, { COSTSOURCE_AZURE_LIVE: v })).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Per-connector status resolution (disabled / unconfigured / configured)
// ---------------------------------------------------------------------------

const CASES = [
  { name: 'Azure', spec: AZURE_CONNECTOR_SPEC, resolve: resolveAzureStatus },
  { name: 'AWS', spec: AWS_CONNECTOR_SPEC, resolve: resolveAwsStatus },
  { name: 'GCP', spec: GCP_CONNECTOR_SPEC, resolve: resolveGcpStatus },
  { name: 'Kubernetes', spec: KUBERNETES_CONNECTOR_SPEC, resolve: resolveKubernetesStatus },
  { name: 'Nutanix', spec: NUTANIX_CONNECTOR_SPEC, resolve: resolveNutanixStatus },
] as const;

/** The configured env minus the kill-switch — activation must not need it. */
function withoutFlag(spec: { flagEnv: string; id: string }): Record<string, string> {
  const rest = { ...CONFIGURED_ENV[spec.id] };
  delete rest[spec.flagEnv];
  return rest;
}

describe.each(CASES)('$name connector status', ({ spec, resolve }) => {
  it('is available (ready to connect, no network) when nothing is set', () => {
    const status = resolve({});
    expect(status.state).toBe('available');
    if (status.state === 'available') {
      expect(status.missing).toEqual(Object.values(spec.requiredEnv));
    }
  });

  it('goes live from credentials alone — no feature flag needed', () => {
    expect(resolve(withoutFlag(spec)).state).toBe('configured');
  });

  it('is disabled by the kill-switch even when fully configured', () => {
    expect(resolve({ ...CONFIGURED_ENV[spec.id], [spec.flagEnv]: 'false' }).state).toBe('disabled');
  });

  it('is unconfigured when the flag is ON but credentials are missing', () => {
    const status = resolve({ [spec.flagEnv]: 'true' });
    expect(status.state).toBe('unconfigured');
    if (status.state === 'unconfigured') {
      // Every required env var is reported missing.
      for (const envName of Object.values(spec.requiredEnv)) {
        expect(status.missing).toContain(envName);
      }
    }
  });

  it('is configured when all credentials are present (flag ON too)', () => {
    const status = resolve(CONFIGURED_ENV[spec.id]);
    expect(status.state).toBe('configured');
    if (status.state === 'configured') {
      // Every logical credential key is resolved.
      for (const key of Object.keys(spec.requiredEnv)) {
        expect(status.credentials[key]).toBeTruthy();
      }
    }
  });

  it('is pure — resolving twice over the same env yields the same state', () => {
    expect(resolve(CONFIGURED_ENV[spec.id]).state).toBe(resolve(CONFIGURED_ENV[spec.id]).state);
  });
});

describe('anchor rule', () => {
  it('treats host-injected AWS credentials without a bucket as available, not partial', () => {
    // AWS Lambda injects these automatically; that alone is not "half set up".
    const status = resolveAwsStatus({
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA',
      AWS_SECRET_ACCESS_KEY: 'secret',
    });
    expect(status).toEqual({ state: 'available', missing: ['AWS_FOCUS_EXPORT_BUCKET'] });
  });

  it('reports a partial setup once the anchor is set', () => {
    const status = resolveAzureStatus({ AZURE_FOCUS_EXPORT_URL: 'https://a.blob.core.windows.net/c' });
    expect(status).toEqual({ state: 'unconfigured', missing: ['AZURE_FOCUS_SAS'] });
  });

  it('carries optional credentials through when present', () => {
    const status = resolveAwsStatus({
      ...CONFIGURED_ENV[AWS_SOURCE_ID],
      AWS_SESSION_TOKEN: 'tok',
      AWS_S3_ENDPOINT: 'https://minio.internal:9000',
    });
    expect(status.state).toBe('configured');
    if (status.state === 'configured') {
      expect(status.credentials.sessionToken).toBe('tok');
      expect(status.credentials.endpoint).toBe('https://minio.internal:9000');
      expect(status.credentials.prefix).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Descriptor honesty
// ---------------------------------------------------------------------------

describe('connector descriptors', () => {
  it('mark the source not configured when nothing is set', () => {
    expect(azureDescriptor(resolveAzureStatus({})).configured).toBe(false);
    expect(awsDescriptor(resolveAwsStatus({})).configured).toBe(false);
    expect(gcpDescriptor(resolveGcpStatus({})).configured).toBe(false);
    expect(kubernetesDescriptor(resolveKubernetesStatus({})).configured).toBe(false);
    expect(nutanixDescriptor(resolveNutanixStatus({})).configured).toBe(false);
  });

  it('flip to configured:true / connected when fully configured', () => {
    const d = azureDescriptor(resolveAzureStatus(CONFIGURED_ENV[AZURE_SOURCE_ID]));
    expect(d.configured).toBe(true);
    expect(d.connection).toBe('connected');
    expect(d.setup?.missingEnv).toEqual([]);
  });

  it('expose connection state and the env contract (names only, never values)', () => {
    const available = awsDescriptor(resolveAwsStatus({}));
    expect(available.connection).toBe('available');
    expect(available.setup?.requiredEnv).toContain('AWS_FOCUS_EXPORT_BUCKET');
    expect(available.setup?.optionalEnv).toContain('AWS_S3_ENDPOINT');
    expect(available.setup?.flagEnv).toBe('COSTSOURCE_AWS_LIVE');

    expect(azureDescriptor(resolveAzureStatus({ COSTSOURCE_AZURE_LIVE: 'true' })).connection).toBe(
      'incomplete',
    );
    expect(azureDescriptor(resolveAzureStatus({ COSTSOURCE_AZURE_LIVE: 'off' })).connection).toBe(
      'disabled',
    );

    const live = azureDescriptor(resolveAzureStatus(CONFIGURED_ENV[AZURE_SOURCE_ID]));
    expect(JSON.stringify(live)).not.toContain('sig=abc');
  });

  it('carry the expected kind / coverage / capabilities / version', () => {
    const azure = azureDescriptor(resolveAzureStatus({}));
    expect(azure.kind).toBe('cloud');
    expect(azure.coverage).toBe('public_cloud');
    expect(azure.focusVersion).toBe('1.0');
    expect(azure.capabilities).toEqual(['costRows']);

    expect(kubernetesDescriptor(resolveKubernetesStatus({})).coverage).toBe('private_cloud');
    expect(kubernetesDescriptor(resolveKubernetesStatus({})).kind).toBe('kubernetes');
    expect(nutanixDescriptor(resolveNutanixStatus({})).coverage).toBe('on_prem');
    expect(nutanixDescriptor(resolveNutanixStatus({})).kind).toBe('nutanix');
  });
});

// ---------------------------------------------------------------------------
// 4. Registry + seed wiring
// ---------------------------------------------------------------------------

describe('connector registry', () => {
  it('exposes all five FOCUS-export connectors and finds them by id', () => {
    expect(FOCUS_EXPORT_CONNECTOR_SPECS).toHaveLength(5);
    for (const id of [
      AZURE_SOURCE_ID,
      AWS_SOURCE_ID,
      GCP_SOURCE_ID,
      KUBERNETES_SOURCE_ID,
      NUTANIX_SOURCE_ID,
    ]) {
      expect(findConnectorSpec(id)?.id).toBe(id);
    }
    expect(findConnectorSpec('pointfive-live')).toBeUndefined();
  });

  it('registers every connector in the seed (available in a default build) without dropping the originals', () => {
    const ids = COST_SOURCES.map((s) => s.id);
    // Existing three sources are preserved.
    expect(ids).toContain('pointfive-sandbox');
    expect(ids).toContain('focus-file-sandbox');
    expect(ids).toContain('pointfive-live');
    // New connectors are registered.
    for (const id of [
      AZURE_SOURCE_ID,
      AWS_SOURCE_ID,
      GCP_SOURCE_ID,
      KUBERNETES_SOURCE_ID,
      NUTANIX_SOURCE_ID,
    ]) {
      const descriptor = COST_SOURCES.find((s) => s.id === id);
      expect(descriptor).toBeDefined();
      // Default build has no connector env set → available, not live.
      expect(descriptor?.configured).toBe(false);
      expect(descriptor?.connection).toBe('available');
    }
  });
});


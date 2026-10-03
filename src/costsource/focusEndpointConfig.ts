// Generic FOCUS endpoint connector — the catch-all for any source that can
// serve a FOCUS export over HTTPS: VMware / OpenStack showback, an internal
// billing service, a FinOps lakehouse API, another vendor's FOCUS feed. It is
// how Ratio reaches an on-prem, private-cloud, or public-cloud source that has
// no dedicated connector, with no code change.
//
// CREDENTIAL-DRIVEN like every connector: live once FOCUS_ENDPOINT_URL is set,
// `COSTSOURCE_FOCUS_ENDPOINT_LIVE=false` forces it off. The endpoint may return
// CSV / JSON / NDJSON (gzip OK) and may embed `{start}` / `{end}` placeholders.

import type { CostSourceDescriptor, SourceCoverage } from './CostSourceClient';
import type { FocusVersion } from './focusVersions';
import { FOCUS_VERSIONS } from './focusVersions';
import {
  connectorDescriptor,
  resolveConnectorStatus,
  type ConnectorSpec,
  type ConnectorStatus,
} from './connectorConfig';
import { createHttpFocusTransport } from './transports/httpFocusTransport';

type EnvRecord = Record<string, string | undefined>;

export const FOCUS_ENDPOINT_SOURCE_ID = 'focus-endpoint';
export const FOCUS_ENDPOINT_LIVE_FLAG_ENV = 'COSTSOURCE_FOCUS_ENDPOINT_LIVE';

/** Descriptive settings, read once at registration (not credentials). */
export const FOCUS_ENDPOINT_COVERAGE_ENV = 'FOCUS_ENDPOINT_COVERAGE';
export const FOCUS_ENDPOINT_VERSION_ENV = 'FOCUS_ENDPOINT_FOCUS_VERSION';
export const FOCUS_ENDPOINT_NAME_ENV = 'FOCUS_ENDPOINT_NAME';

const COVERAGES: readonly SourceCoverage[] = ['public_cloud', 'private_cloud', 'on_prem'];

/** Build the spec from env so coverage / version / name describe the real source. */
export function buildFocusEndpointSpec(env: EnvRecord): ConnectorSpec {
  const coverageRaw = env[FOCUS_ENDPOINT_COVERAGE_ENV]?.trim() as SourceCoverage | undefined;
  const versionRaw = env[FOCUS_ENDPOINT_VERSION_ENV]?.trim() as FocusVersion | undefined;
  const coverage = coverageRaw && COVERAGES.includes(coverageRaw) ? coverageRaw : 'on_prem';
  const focusVersion = versionRaw && FOCUS_VERSIONS.includes(versionRaw) ? versionRaw : '1.0';
  const label = env[FOCUS_ENDPOINT_NAME_ENV]?.trim();

  return {
    id: FOCUS_ENDPOINT_SOURCE_ID,
    name: label ? `${label} (FOCUS endpoint)` : 'FOCUS endpoint (any on-prem / private / public source)',
    kind: 'focus_endpoint',
    coverage,
    focusVersion,
    capabilities: ['costRows'],
    flagEnv: FOCUS_ENDPOINT_LIVE_FLAG_ENV,
    requiredEnv: {
      endpoint: 'FOCUS_ENDPOINT_URL',
    },
    optionalEnv: {
      token: 'FOCUS_ENDPOINT_TOKEN',
      authHeader: 'FOCUS_ENDPOINT_AUTH_HEADER',
    },
    liveSummary: 'Any HTTPS endpoint serving a FOCUS export (CSV / JSON / NDJSON)',
    transport: (c) =>
      createHttpFocusTransport({
        endpoint: c.endpoint,
        token: c.token,
        authHeader: c.authHeader,
        label: label ?? 'FOCUS endpoint',
      }),
  };
}

export const FOCUS_ENDPOINT_CONNECTOR_SPEC: ConnectorSpec = buildFocusEndpointSpec(
  typeof process === 'undefined' ? {} : process.env,
);

export function resolveFocusEndpointStatus(env: EnvRecord): ConnectorStatus {
  return resolveConnectorStatus(FOCUS_ENDPOINT_CONNECTOR_SPEC, env);
}

export function focusEndpointDescriptor(status: ConnectorStatus): CostSourceDescriptor {
  return connectorDescriptor(FOCUS_ENDPOINT_CONNECTOR_SPEC, status);
}

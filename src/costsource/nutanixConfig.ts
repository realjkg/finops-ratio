// Nutanix on-prem cost connector (Nutanix Cloud Manager cost governance export).
//
// Nutanix Cloud Manager (NCM) produces cost-governance / showback data for
// on-prem and private-cloud infrastructure. Once exported in FOCUS form it flows
// through Ratio's version shim like any other source — only the endpoint + API
// credential is connector-specific. CREDENTIAL-DRIVEN: live once endpoint + API
// key exist; `COSTSOURCE_NUTANIX_LIVE=false` forces it off. The key is sent in
// Nutanix's `X-ntnx-api-key` header.

import type { CostSourceDescriptor } from './CostSourceClient';
import {
  connectorDescriptor,
  resolveConnectorStatus,
  type ConnectorSpec,
  type ConnectorStatus,
} from './connectorConfig';
import { createHttpFocusTransport } from './transports/httpFocusTransport';

type EnvRecord = Record<string, string | undefined>;

/** Canonical source id across the seam. */
export const NUTANIX_SOURCE_ID = 'nutanix';

/** Kill-switch env var. Unset = auto (live once configured); `false` = off. */
export const NUTANIX_LIVE_FLAG_ENV = 'COSTSOURCE_NUTANIX_LIVE';

export const NUTANIX_CONNECTOR_SPEC: ConnectorSpec = {
  id: NUTANIX_SOURCE_ID,
  name: 'Nutanix Cloud Manager (cost governance FOCUS export)',
  kind: 'nutanix',
  coverage: 'on_prem',
  focusVersion: '1.0',
  capabilities: ['costRows'],
  flagEnv: NUTANIX_LIVE_FLAG_ENV,
  requiredEnv: {
    endpoint: 'NUTANIX_ENDPOINT',
    apiKey: 'NUTANIX_API_KEY',
  },
  liveSummary: 'Nutanix Cloud Manager cost governance export normalized to FOCUS',
  transport: (c) =>
    createHttpFocusTransport({
      endpoint: c.endpoint,
      token: c.apiKey,
      authHeader: 'X-ntnx-api-key',
      label: 'Nutanix Cloud Manager',
    }),
};

export function resolveNutanixStatus(env: EnvRecord): ConnectorStatus {
  return resolveConnectorStatus(NUTANIX_CONNECTOR_SPEC, env);
}

export function nutanixDescriptor(status: ConnectorStatus): CostSourceDescriptor {
  return connectorDescriptor(NUTANIX_CONNECTOR_SPEC, status);
}


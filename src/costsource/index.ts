// CostSource slice public API — mirrors src/finio/index.ts and src/tokenomics/index.ts.
// Callers only ever see the CostSourceClient interface and createCostSourceClient;
// concrete implementations are an internal detail.
import { LiveCostSourceClient } from './LiveCostSourceClient';
export { LiveDataAuthError, LIVE_DATA_AUTH_MESSAGE } from './LiveCostSourceClient';
import { MockCostSourceClient } from './MockCostSourceClient';
import type { CostSourceClient } from './CostSourceClient';

export type {
  CostSourceClient,
  CostSourceDescriptor,
  CostRowsResult,
  CostFinding,
  FindingType,
  FindingSeverity,
  FindingStatus,
  SourceHealth,
  SourceKind,
  SourceCoverage,
  SourceCapability,
  CostWindow,
  ConnectorConnection,
  ConnectorSetup,
} from './CostSourceClient';
export type {
  CanonicalFocusRow,
  CanonicalCostRow,
  RawSourceRow,
  RatioFocusExtensions,
} from './focusRows';
export type { FocusVersion } from './focusVersions';
export {
  CANONICAL_FOCUS_VERSION,
  FOCUS_VERSIONS,
  COLUMNS_BY_VERSION,
  columnsAddedAfter,
  isDraftVersion,
} from './focusVersions';
export type { ComposedRatioView } from './normalize';
export { composeRatioView } from './normalize';

// Source adapters — exported so callers can use them directly or the seam
// dispatches to them. Each adapter is source-specific (auth, fetch, identity);
// the engine and downstream views are unchanged regardless of which adapter
// produced the rows.
export { FocusFileAdapter } from './FocusFileAdapter';
export {
  PointFiveLiveAdapter,
  mapOpportunityToFinding,
  mapAnomalyToFinding,
} from './PointFiveLiveAdapter';
export type { PointFiveLiveAdapterDeps } from './PointFiveLiveAdapter';
export {
  POINTFIVE_LIVE_SOURCE_ID,
  POINTFIVE_LIVE_FLAG_ENV,
  DEFAULT_POINTFIVE_MCP_URL,
  isPointFiveLiveEnabled,
  resolvePointFiveStatus,
  pointFiveLiveDescriptor,
} from './pointfiveConfig';
export type { PointFiveStatus, PointFiveCredentials } from './pointfiveConfig';

// Config-driven FOCUS-export connectors (public cloud trio + Kubernetes +
// Nutanix) sharing one adapter, the generic
// connector-config helper, and the live transports in ./transports/. Each goes
// live as soon as its env is set. Only the adapter is source-specific.
export {
  connectorFlag,
  isConnectorEnabled,
  resolveConnectorStatus,
  connectorStatusNote,
  connectorDescriptor,
} from './connectorConfig';
export type { ConnectorSpec, ConnectorStatus } from './connectorConfig';
export { CloudConnectorAdapter } from './CloudConnectorAdapter';
export type {
  FocusExportTransport,
  FocusExportTransportFactory,
  CloudConnectorAdapterDeps,
} from './CloudConnectorAdapter';
export {
  AZURE_SOURCE_ID,
  AWS_SOURCE_ID,
  GCP_SOURCE_ID,
  AZURE_LIVE_FLAG_ENV,
  AWS_LIVE_FLAG_ENV,
  GCP_LIVE_FLAG_ENV,
  AZURE_CONNECTOR_SPEC,
  AWS_CONNECTOR_SPEC,
  GCP_CONNECTOR_SPEC,
  CLOUD_CONNECTOR_SPECS,
  resolveAzureStatus,
  resolveAwsStatus,
  resolveGcpStatus,
  azureDescriptor,
  awsDescriptor,
  gcpDescriptor,
} from './cloudConnectorConfig';
export {
  KUBERNETES_SOURCE_ID,
  KUBERNETES_LIVE_FLAG_ENV,
  KUBERNETES_CONNECTOR_SPEC,
  resolveKubernetesStatus,
  kubernetesDescriptor,
} from './kubernetesConfig';
export {
  NUTANIX_SOURCE_ID,
  NUTANIX_LIVE_FLAG_ENV,
  NUTANIX_CONNECTOR_SPEC,
  resolveNutanixStatus,
  nutanixDescriptor,
} from './nutanixConfig';
export { FOCUS_EXPORT_CONNECTOR_SPECS, findConnectorSpec } from './focusExportConnectors';
export { createHttpFocusTransport } from './transports/httpFocusTransport';
export { createAzureBlobTransport } from './transports/azureBlobTransport';
export { createAwsS3Transport } from './transports/awsS3Transport';
export { createGcpBigQueryTransport } from './transports/gcpBigQueryTransport';
export type {
  PointFiveMcpClient,
  PointFiveMcpClientFactory,
  PointFiveOpportunity,
  PointFiveAnomaly,
  PointFiveFocusRow,
} from './PointFiveMcpTransport';

/** Returns MockCostSourceClient by default; pass `'live'` to get the live client. */
export function createCostSourceClient(mode: 'mock' | 'live' = 'mock'): CostSourceClient {
  return mode === 'live' ? new LiveCostSourceClient() : new MockCostSourceClient();
}


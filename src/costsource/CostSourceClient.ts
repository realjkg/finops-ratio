// CostSourceClient seam (PR D) — the source-agnostic cost-ingest interface.
//
// Mirrors the repo's proven typed-client-seam pattern (HelloClient PR #8,
// FinioClient PR #9, TokenomicsClient PR #10): a typed interface, a mock that
// runs fully offline, a live impl behind Next.js API routes, and a demo page.
//
// PointFive is source #1, not the architecture. The engine only ever sees
// normalized canonical FOCUS rows — only the adapter (auth, fetch, identity)
// is source-specific. Live PointFive (OAuth 2.1 / MCP SSE) and a second
// private-cloud adapter are later PRs (E and F); this PR is mock only.

import type { FocusVersion } from './focusVersions';
import type { CanonicalFocusRow } from './focusRows';

/** Half-open time window for a cost query. */
export interface CostWindow {
  start: string; // ISO 8601, inclusive
  end: string; // ISO 8601, exclusive
}

export type SourceKind =
  | 'pointfive'
  | 'focus_file'
  | 'mock'
  | 'cloud' // public-cloud FOCUS export (Azure / AWS / GCP)
  | 'kubernetes' // OpenCost / Kubecost FOCUS export
  | 'nutanix'; // Nutanix Cloud Manager cost governance export
export type SourceCoverage = 'public_cloud' | 'private_cloud' | 'on_prem';
export type SourceCapability = 'costRows' | 'findings';

/** Connection state of a config-driven connector, as the UI presents it. */
export type ConnectorConnection = 'connected' | 'available' | 'incomplete' | 'disabled';

/** The env contract that connects a connector — names only, never values. */
export interface ConnectorSetup {
  flagEnv: string; // kill-switch; unset = auto
  requiredEnv: string[];
  optionalEnv: string[];
  missingEnv: string[];
}

/** A configured cost source (adapter), as returned by `listSources`. */
export interface CostSourceDescriptor {
  id: string;
  name: string;
  kind: SourceKind;
  focusVersion: FocusVersion; // the version this source natively exports
  coverage: SourceCoverage;
  capabilities: SourceCapability[];
  configured: boolean; // false = specified but missing credentials (e.g. live PointFive)
  note: string;
  /** Config-driven connectors only: connection state + the env that connects it. */
  connection?: ConnectorConnection;
  setup?: ConnectorSetup;
}

/** Result of `fetchCostRows`: normalized rows + an audit of the version upgrade. */
export interface CostRowsResult {
  sourceId: string;
  sourceVersion: FocusVersion; // version the source exported
  canonicalVersion: FocusVersion; // always the v1.4 canonical target
  backfilledColumns: string[]; // columns the shim added to reach canonical
  window: CostWindow;
  generatedAt: string; // ISO 8601
  rows: CanonicalFocusRow[];
}

export type FindingType = 'opportunity' | 'anomaly';
export type FindingSeverity = 'info' | 'warning' | 'critical';
export type FindingStatus = 'open' | 'acknowledged' | 'resolved';

/** A waste/opportunity or anomaly finding — mirrors PointFive DeepWaste shape. */
export interface CostFinding {
  id: string;
  sourceId: string;
  type: FindingType; // 'opportunity' (Opportunities) | 'anomaly' (Anomalies)
  category: string; // e.g. 'idle_resource', 'rightsizing', 'spend_spike'
  title: string;
  resourceId: string;
  workloadId: string | null; // resolved Ratio workload, if matched
  estimatedMonthlySavings: number; // opportunities (0 for anomalies)
  observedSpendDelta: number; // anomalies (0 for opportunities)
  severity: FindingSeverity;
  status: FindingStatus;
  detectedAt: string; // ISO 8601
}

/** Adapter reachability/auth probe result. */
export interface SourceHealth {
  sourceId: string;
  reachable: boolean;
  authed: boolean;
  sourceVersion: FocusVersion;
  canonicalVersion: FocusVersion;
  checkedAt: string; // ISO 8601
  detail: string;
}

export interface CostSourceClient {
  readonly mode: 'mock' | 'live';
  /** Which adapters are configured. */
  listSources(): Promise<CostSourceDescriptor[]>;
  /** Normalized FOCUS-shaped internal cost rows for a source + window. */
  fetchCostRows(sourceId: string, window: CostWindow): Promise<CostRowsResult>;
  /** Optional waste/opportunity findings (PointFive DeepWaste). */
  fetchFindings(sourceId: string): Promise<CostFinding[]>;
  /** Is the adapter reachable / authed? */
  healthCheck(sourceId: string): Promise<SourceHealth>;
}


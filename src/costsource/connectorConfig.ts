// Generic config-driven connector seam — the shared shape every FOCUS-export
// connector (public cloud, Kubernetes, Nutanix, generic endpoint) uses.
//
// Activation is CREDENTIAL-DRIVEN: a connector goes live as soon as its
// required env is present, with no separate opt-in. The feature flag is a
// kill-switch, not an on-switch:
//   - flag unset            → auto: live when configured, `available` otherwise
//   - flag truthy (1/true)  → on: same as auto, but missing env is reported as
//                             `unconfigured` (the operator asked for it)
//   - flag falsey (0/false) → off: `disabled`, never touches the network
//
// Every status is a pure function of an env record, so each branch is unit-
// testable without touching process.env or the network. `configured` is the
// ONLY state that ever permits a network call.
//
// Only the adapter (auth, fetch, identity) is source-specific. The engine, the
// version-negotiation shim, and the views are unchanged regardless of source.

import type {
  ConnectorConnection,
  CostSourceDescriptor,
  SourceCapability,
  SourceCoverage,
  SourceKind,
} from './CostSourceClient';
import type { FocusVersion } from './focusVersions';
import type { FocusExportTransportFactory } from './CloudConnectorAdapter';

type EnvRecord = Record<string, string | undefined>;

/**
 * Status of a connector — a discriminated union over the real-world states:
 *   - `disabled`     — kill-switch flag explicitly OFF.
 *   - `available`    — nothing configured yet; ready to connect (default).
 *   - `unconfigured` — partially configured; `missing` names what is left.
 *   - `configured`   — all required env present; live calls allowed.
 * Only `configured` ever permits a network call.
 */
export type ConnectorStatus =
  | { state: 'disabled' }
  | { state: 'available'; missing: string[] }
  | { state: 'unconfigured'; missing: string[] }
  | { state: 'configured'; credentials: Record<string, string> };

/** Static identity + env contract for a FOCUS-export connector. */
export interface ConnectorSpec {
  id: string;
  name: string;
  kind: SourceKind;
  coverage: SourceCoverage;
  focusVersion: FocusVersion; // the version this source natively exports
  capabilities: SourceCapability[];
  /** Kill-switch env var. Unset = auto (live once configured); falsey = off. */
  flagEnv: string;
  /**
   * Required env vars, keyed by logical credential name. The FIRST entry is the
   * anchor — the export location (URL, bucket, dataset, endpoint). Hosts often
   * inject generic cloud credentials (AWS_ACCESS_KEY_ID on Lambda, Google ADC on
   * GKE), so until the anchor is set a connector is `available`, not partial.
   */
  requiredEnv: Record<string, string>;
  /** Optional env vars the live transport reads when present. */
  optionalEnv?: Record<string, string>;
  /** One-line summary of what the live adapter does once configured. */
  liveSummary: string;
  /** Builds the live transport from resolved credentials. */
  transport: FocusExportTransportFactory;
}

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const FALSEY = new Set(['0', 'false', 'off', 'no']);

/** The kill-switch position: `auto` unless the flag is explicitly set. */
export function connectorFlag(spec: ConnectorSpec, env: EnvRecord): 'auto' | 'on' | 'off' {
  const v = env[spec.flagEnv]?.trim().toLowerCase();
  if (!v) return 'auto';
  if (FALSEY.has(v)) return 'off';
  if (TRUTHY.has(v)) return 'on';
  return 'auto';
}

/** True unless the connector's kill-switch is explicitly OFF. */
export function isConnectorEnabled(spec: ConnectorSpec, env: EnvRecord): boolean {
  return connectorFlag(spec, env) !== 'off';
}

/**
 * Resolve a connector's status from an env record. Pure — no process.env, no
 * I/O. A disabled connector short-circuits before any credential is read.
 */
export function resolveConnectorStatus(spec: ConnectorSpec, env: EnvRecord): ConnectorStatus {
  const flag = connectorFlag(spec, env);
  if (flag === 'off') return { state: 'disabled' };

  const missing: string[] = [];
  const credentials: Record<string, string> = {};
  for (const [key, envName] of Object.entries(spec.requiredEnv)) {
    const value = env[envName]?.trim();
    if (!value) missing.push(envName);
    else credentials[key] = value;
  }

  if (missing.length > 0) {
    const anchorEnv = Object.values(spec.requiredEnv)[0];
    const anchorMissing = missing.includes(anchorEnv);
    return flag === 'auto' && anchorMissing
      ? { state: 'available', missing }
      : { state: 'unconfigured', missing };
  }

  for (const [key, envName] of Object.entries(spec.optionalEnv ?? {})) {
    const value = env[envName]?.trim();
    if (value) credentials[key] = value;
  }
  return { state: 'configured', credentials };
}

/** Human-readable note for the source descriptor, per status. */
export function connectorStatusNote(spec: ConnectorSpec, status: ConnectorStatus): string {
  switch (status.state) {
    case 'disabled':
      return `${spec.liveSummary} — disabled by ${spec.flagEnv}; no network calls.`;
    case 'available':
      return `${spec.liveSummary} — ready to connect: set ${status.missing.join(', ')}.`;
    case 'unconfigured':
      return `${spec.liveSummary} — partially configured; still missing ${status.missing.join(', ')}. No network calls until complete.`;
    case 'configured':
      return `${spec.liveSummary} — live; fetches FOCUS v${spec.focusVersion} export rows and normalizes to canonical v1.4.`;
  }
}

const CONNECTION: Record<ConnectorStatus['state'], ConnectorConnection> = {
  disabled: 'disabled',
  available: 'available',
  unconfigured: 'incomplete',
  configured: 'connected',
};

/**
 * Build a connector's source descriptor from a status. `configured` is driven by
 * the resolved status, so `listSources()` honestly reflects whether a connector
 * is live — and `setup` tells the UI exactly which env vars connect it.
 */
export function connectorDescriptor(
  spec: ConnectorSpec,
  status: ConnectorStatus,
): CostSourceDescriptor {
  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    focusVersion: spec.focusVersion,
    coverage: spec.coverage,
    capabilities: spec.capabilities,
    configured: status.state === 'configured',
    note: connectorStatusNote(spec, status),
    connection: CONNECTION[status.state],
    setup: {
      flagEnv: spec.flagEnv,
      requiredEnv: Object.values(spec.requiredEnv),
      optionalEnv: Object.values(spec.optionalEnv ?? {}),
      missingEnv: 'missing' in status ? status.missing : [],
    },
  };
}

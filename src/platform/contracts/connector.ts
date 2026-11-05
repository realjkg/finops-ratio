// Connector declaration contract (ADR-0001 §6). It EXTENDS the M0a managed-connector framework
// (src/connectors/managed): connectors still register retrievers there; this declares what a connector supports and
// maps the M0a states onto the owner's status ladder. A step is never collapsed into "Connected".
import { arr, C, literal, obj, oneOf, opt, req, rule, validator } from './validate';
import { SCHEMA_VERSIONS } from './versions';

export const CONNECTION_LADDER = ['configured', 'authorized', 'retrieved', 'validated', 'reconciled'] as const;
export type LadderStep = (typeof CONNECTION_LADDER)[number];

/**
 * M0a `ConnectorState` (src/connectors/managed/health.ts) to the ladder. `live-verified` is `reconciled` plus a live
 * verification status; not-configured, degraded, failed and simulated are off the ladder and shown as themselves.
 * connector.test.ts proves at compile time that every M0a state is mapped.
 */
export const LADDER_FROM_MANAGED_STATE = {
  'not-configured': null, 'configured-not-verified': 'configured', 'auth-verified': 'authorized', 'source-access-verified': 'authorized',
  'extraction-completed': 'retrieved', 'mapping-validated': 'validated', 'reconciliation-passed': 'reconciled', 'live-verified': 'reconciled',
  degraded: null, failed: null, simulated: null,
} as const satisfies Record<string, LadderStep | null>;

export const CONNECTOR_CATEGORIES = ['model_provider_usage', 'cloud_billing', 'otel_events', 'identity_eligibility', 'gateway', 'license_utilization', 'a2a'] as const;
export const VERIFICATION = ['not_verified', 'pre_release_validated', 'live_verified'] as const;

export interface ConnectorDeclaration {
  schemaVersion: 'connector-declaration/1';
  connectorId: string;
  category: (typeof CONNECTOR_CATEGORIES)[number];
  /** Each operation names the contract schema version it emits. */
  operations: { name: string; emits: string }[];
  credentials: { kind: 'api_key' | 'oauth_client' | 'role_assumption' | 'oidc' | 'file_drop' | 'none'; permissions: string[] }[];
  granularity: 'request' | 'minute' | 'hour' | 'day' | 'month';
  pagination: 'cursor' | 'page' | 'file_manifest' | 'none';
  completeness: 'manifest_count' | 'cursor_exhaustion' | 'control_total' | 'none';
  refreshCadence: string;
  freshnessTarget?: string;
  dedup: { strategy: 'source_id' | 'content_hash' | 'composite_key'; keyFields: string[] };
  corrections: 'supersedes' | 'restated_period' | 'none';
  rateLimits: { strategy: 'retry_after' | 'fixed_backoff' | 'none'; maxRetries: number };
  privacy: 'aggregate' | 'pseudonymous' | 'personal_restricted';
  verification: { status: (typeof VERIFICATION)[number]; limitations: string[] };
}

export const validateConnectorDeclaration = validator<ConnectorDeclaration>(obj({
  schemaVersion: req(literal('connector-declaration/1')), connectorId: req(rule('connector id', (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(v))),
  category: req(oneOf(CONNECTOR_CATEGORIES)),
  operations: req(arr(obj({ name: req(C.id), emits: req(oneOf(SCHEMA_VERSIONS)) }), 1, 32)),
  credentials: req(arr(obj({ kind: req(oneOf(['api_key', 'oauth_client', 'role_assumption', 'oidc', 'file_drop', 'none'])), permissions: req(arr(C.id)) }), 1, 8)),
  granularity: req(oneOf(['request', 'minute', 'hour', 'day', 'month'])), pagination: req(oneOf(['cursor', 'page', 'file_manifest', 'none'])),
  completeness: req(oneOf(['manifest_count', 'cursor_exhaustion', 'control_total', 'none'])), refreshCadence: req(C.duration), freshnessTarget: opt(C.duration),
  dedup: req(obj({ strategy: req(oneOf(['source_id', 'content_hash', 'composite_key'])), keyFields: req(arr(C.id, 1, 16)) })),
  corrections: req(oneOf(['supersedes', 'restated_period', 'none'])),
  rateLimits: req(obj({ strategy: req(oneOf(['retry_after', 'fixed_backoff', 'none'])), maxRetries: req(C.count) })),
  privacy: req(oneOf(['aggregate', 'pseudonymous', 'personal_restricted'])),
  verification: req(obj({ status: req(oneOf(VERIFICATION)), limitations: req(arr(C.reason)) })),
} satisfies { [K in keyof Required<ConnectorDeclaration>]: unknown }), (d, p) => {
  if (d.verification.status !== 'live_verified' && d.verification.limitations.length === 0) p.push('$.verification.limitations: required until live verified');
});

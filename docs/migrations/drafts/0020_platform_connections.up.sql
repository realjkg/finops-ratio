-- ratio:phase expand
-- DRAFT 0020_platform_connections (ADR-0001 §12, slice A1). NOT a migration yet: the ledger
-- (docs/migrations/ledger.json) reserves 0020 for A1, and its guard (src/ingest/db/migrationLedger.test.ts, option a)
-- refuses any 0020+ migration while 0005-0019 are still reserved. Until the orchestrator merges or releases them, this
-- file is applied only to throwaway test databases (src/ingest/platform/connections.db.test.ts). Promotion is a
-- separate PR: move both files to src/ingest/db/migrations, mark 0020 merged in the ledger, add the generated
-- foundation manifest and the reviewed privileges (src/ingest/db/privilegeModel.ts).
--
--   * ratio.platform_connections: one row per (tenant, connection). The connector-declaration/1 document, the M0a
--     managed state (src/connectors/managed/health.ts ConnectorState) and the ladder step it maps to
--     (LADDER_FROM_MANAGED_STATE: configured, authorized, retrieved, validated, reconciled; the off-ladder states
--     not-configured, degraded, failed and simulated have no step), and the declaration's verification status.
--   * ratio.platform_evidence_refs: append-only references to the evidence behind a step (kind, locator, sha256).
--     The worker may insert and read them, never update or delete.
--
-- Invariants of 0001 kept: every row has tenant_id uuid NOT NULL and a schema_version; every foreign key includes
-- tenant_id; RLS is enabled and forced with the reviewed tenant_isolation shape; text and JSON refuse secret-looking
-- values. The runner wraps a migration in one transaction (no BEGIN/COMMIT here).

SET LOCAL ROLE ratio_owner;

CREATE TABLE ratio.platform_connections (
  tenant_id       uuid NOT NULL REFERENCES ratio.tenants (id),
  connection_id   text NOT NULL CHECK (connection_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  schema_version  text NOT NULL CHECK (schema_version = 'connector-declaration/1'),
  connector_id    text NOT NULL CHECK (connector_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  category        text NOT NULL CHECK (category IN ('model_provider_usage', 'cloud_billing', 'otel_events', 'identity_eligibility', 'gateway', 'license_utilization', 'a2a')),
  declaration     jsonb NOT NULL CHECK (
                    jsonb_typeof(declaration) = 'object'
                    AND declaration ->> 'schemaVersion' = schema_version
                    AND declaration ->> 'connectorId' = connector_id
                    AND declaration ->> 'category' = category
                    AND NOT ratio.jsonb_has_secret_like_value(declaration)
                  ),
  managed_state   text NOT NULL CHECK (managed_state IN ('not-configured', 'configured-not-verified', 'auth-verified', 'source-access-verified', 'extraction-completed', 'mapping-validated', 'reconciliation-passed', 'live-verified', 'degraded', 'failed', 'simulated')),
  ladder_step     text CHECK (ladder_step IS NOT DISTINCT FROM CASE managed_state
                    WHEN 'configured-not-verified' THEN 'configured'
                    WHEN 'auth-verified' THEN 'authorized'
                    WHEN 'source-access-verified' THEN 'authorized'
                    WHEN 'extraction-completed' THEN 'retrieved'
                    WHEN 'mapping-validated' THEN 'validated'
                    WHEN 'reconciliation-passed' THEN 'reconciled'
                    WHEN 'live-verified' THEN 'reconciled'
                  END),
  verification    text NOT NULL CHECK (verification IN ('not_verified', 'pre_release_validated', 'live_verified')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id)
);

CREATE TABLE ratio.platform_evidence_refs (
  tenant_id      uuid NOT NULL,
  ref_id         uuid NOT NULL,
  connection_id  text NOT NULL,
  schema_version text NOT NULL CHECK (schema_version = 'platform-evidence-ref/1'),
  kind           text NOT NULL CHECK (kind IN ('health_probe', 'sync_run', 'mapping_validation', 'reconciliation', 'connector_evidence_record')),
  locator        text NOT NULL CHECK (locator ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$' AND NOT ratio.text_looks_secret(locator)),
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, ref_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES ratio.platform_connections (tenant_id, connection_id)
);
CREATE INDEX platform_evidence_refs_by_connection ON ratio.platform_evidence_refs (tenant_id, connection_id);

-- Row-level security: enabled and forced, the reviewed tenant_isolation shape.
ALTER TABLE ratio.platform_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.platform_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.platform_connections
  USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());

ALTER TABLE ratio.platform_evidence_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.platform_evidence_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.platform_evidence_refs
  USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());

-- The worker owns all writes; evidence refs are append-only (no UPDATE or DELETE). No reader grant until a read API
-- slice reviews one.
GRANT SELECT, INSERT, UPDATE ON ratio.platform_connections TO ratio_worker;
GRANT SELECT, INSERT ON ratio.platform_evidence_refs TO ratio_worker;

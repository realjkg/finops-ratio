-- ratio:phase expand
-- DRAFT 0020_platform_connections (ADR-0001 §12, slice A1). NOT a migration yet: the ledger reserves 0020 for A1 and
-- its guard (src/ingest/db/migrationLedger.test.ts, option a) refuses any 0020+ while 0005-0019 are reserved, so this
-- file is applied only to throwaway test databases (src/ingest/platform/connections.db.test.ts). Promotion (a separate
-- PR): move both files to src/ingest/db/migrations, mark 0020 merged, add the foundation manifest and the reviewed
-- grants and triggers (src/ingest/db/privilegeModel.ts).
--   * ratio.platform_connections: one row per (tenant, connection): the connector-declaration/1 document (it never
--     claims verification; that is derived from evidence), the latest M0a state (ConnectorState) and its observation
--     time, the latest degraded or failed observation, and managed_ladder_step, the step LADDER_FROM_MANAGED_STATE maps
--     the state to (none off the ladder). That step is M0a's claim, NOT evidence-gated: a reader never sees it; a
--     future read API exposes only the evidence-gated step (owner default: a definer-rights view over the evidence
--     recorded after last_degraded_at), as src/ingest/platform/connections.ts computes it.
--   * ratio.platform_evidence_refs: append-only references to the evidence behind a step and the observation it
--     supports. UPDATE, DELETE and TRUNCATE are refused for every role; the key restricts deleting a connection.
-- 0001 invariants kept: tenant_id and schema_version on every row, tenant_id in every foreign key, RLS enabled and
-- forced (tenant_isolation), no secret-looking text or JSON. The runner wraps a migration in one transaction.

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
                    AND declaration #>> '{verification,status}' = 'not_verified'
                    AND NOT ratio.jsonb_has_secret_like_value(declaration)
                  ),
  managed_state   text NOT NULL CHECK (managed_state IN ('not-configured', 'configured-not-verified', 'auth-verified', 'source-access-verified', 'extraction-completed', 'mapping-validated', 'reconciliation-passed', 'live-verified', 'degraded', 'failed', 'simulated')),
  managed_ladder_step text CHECK (managed_ladder_step IS NOT DISTINCT FROM CASE managed_state
                    WHEN 'configured-not-verified' THEN 'configured'
                    WHEN 'auth-verified' THEN 'authorized'
                    WHEN 'source-access-verified' THEN 'authorized'
                    WHEN 'extraction-completed' THEN 'retrieved'
                    WHEN 'mapping-validated' THEN 'validated'
                    WHEN 'reconciliation-passed' THEN 'reconciled'
                    WHEN 'live-verified' THEN 'reconciled'
                  END),
  observed_at     timestamptz,
  last_degraded_at timestamptz CHECK (last_degraded_at IS NULL OR last_degraded_at <= observed_at),
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
  observed_at    timestamptz NOT NULL,
  observed_state text NOT NULL CHECK (observed_state IN ('configured-not-verified', 'auth-verified', 'source-access-verified', 'extraction-completed', 'mapping-validated', 'reconciliation-passed', 'live-verified')),
  recorded_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, ref_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES ratio.platform_connections (tenant_id, connection_id) ON UPDATE RESTRICT ON DELETE RESTRICT
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

-- Evidence is append-only for every role, including the owner and superusers (unless triggers are disabled).
-- ratio:allow-function append-only guard for platform evidence refs (UPDATE and DELETE refused)
CREATE FUNCTION ratio.tg_platform_evidence_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'RT001', MESSAGE = format('%s of ratio.%s is refused: evidence refs are append-only', TG_OP, TG_TABLE_NAME);
END
$fn$;
-- ratio:allow-function attaches the append-only guard
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON ratio.platform_evidence_refs
  FOR EACH ROW EXECUTE FUNCTION ratio.tg_platform_evidence_append_only();
-- ratio:allow-function attaches the refuse_truncate guard
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON ratio.platform_evidence_refs
  FOR EACH STATEMENT EXECUTE FUNCTION ratio.tg_refuse_truncate();
-- ratio:allow-function attaches the refuse_truncate guard
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON ratio.platform_connections
  FOR EACH STATEMENT EXECUTE FUNCTION ratio.tg_refuse_truncate();
REVOKE EXECUTE ON FUNCTION ratio.tg_platform_evidence_append_only() FROM PUBLIC;

-- The worker owns all writes; evidence refs are append-only (no UPDATE or DELETE). No reader grant until a read API
-- slice reviews one.
GRANT SELECT, INSERT, UPDATE ON ratio.platform_connections TO ratio_worker;
GRANT SELECT, INSERT ON ratio.platform_evidence_refs TO ratio_worker;

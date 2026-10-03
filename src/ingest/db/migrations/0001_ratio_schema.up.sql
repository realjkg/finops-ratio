-- ratio:phase expand
-- 0001_ratio_schema: schema `ratio`, its roles, row-level security and the
-- published-facts view. Creates only new objects (expand).
--
-- Invariants:
--   * money is unconstrained numeric (never float); timestamps are timestamptz;
--   * every tenant-owned row has tenant_id uuid NOT NULL, and every foreign key
--     is composite and includes tenant_id, so no row can reference another
--     tenant's row;
--   * RLS is ENABLED and FORCED on every table; the policy reads the
--     transaction-local setting ratio.tenant_id. Unset/empty => NULL => zero
--     rows visible and every write rejected;
--   * objects are owned by ratio_owner (not superuser, not BYPASSRLS), so FORCE
--     RLS also binds the owner — which is what makes the definer-rights view
--     cost_facts_published tenant-scoped for ratio_reader.
-- The runner wraps this file in one transaction (no BEGIN/COMMIT here).

-- 1. Roles: cluster-global, created idempotently and race-safe (two databases
--    in one cluster may migrate concurrently). NOLOGIN: deployment grants LOGIN.
DO $roles$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['ratio_owner', 'ratio_worker', 'ratio_reader'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', r);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL; -- created concurrently by another migration in this cluster
      END;
    END IF;
  END LOOP;

  -- Fail closed rather than silently altering pre-existing roles.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname IN ('ratio_owner', 'ratio_worker', 'ratio_reader') AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'ratio_owner/ratio_worker/ratio_reader must not be SUPERUSER or BYPASSRLS';
  END IF;
  IF pg_catalog.pg_has_role('ratio_worker', 'ratio_owner', 'MEMBER')
     OR pg_catalog.pg_has_role('ratio_reader', 'ratio_owner', 'MEMBER')
     OR pg_catalog.pg_has_role('ratio_reader', 'ratio_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ratio_worker/ratio_reader must not be members of a more privileged ratio role';
  END IF;
END
$roles$;

-- 2. Schema, owned by ratio_owner; everything below is created as ratio_owner.
CREATE SCHEMA ratio AUTHORIZATION ratio_owner;
SET LOCAL ROLE ratio_owner;
REVOKE ALL ON SCHEMA ratio FROM PUBLIC;
GRANT USAGE ON SCHEMA ratio TO ratio_worker, ratio_reader;

-- 3. Helpers.
-- Tenant of the current transaction. NULLIF: once set_config(..., true) has
-- been used in a session, the setting reads '' after the transaction ends.
CREATE FUNCTION ratio.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$ SELECT NULLIF(pg_catalog.current_setting('ratio.tenant_id', true), '')::uuid $fn$;

-- True when any key, at any depth, looks like it names a secret. Deliberately
-- broad (fail closed): non-secret config must avoid these substrings.
CREATE FUNCTION ratio.jsonb_has_secret_like_key(doc jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  WITH RECURSIVE walk(v) AS (
    SELECT doc
    UNION ALL
    SELECT child.value
    FROM walk w
    CROSS JOIN LATERAL (
      SELECT e.value FROM jsonb_each(CASE WHEN jsonb_typeof(w.v) = 'object' THEN w.v ELSE '{}'::jsonb END) AS e
      UNION ALL
      SELECT a.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.v) = 'array' THEN w.v ELSE '[]'::jsonb END) AS a
    ) AS child
  )
  SELECT EXISTS (
    SELECT 1
    FROM walk w
    CROSS JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(w.v) = 'object' THEN w.v ELSE '{}'::jsonb END) AS k(key)
    WHERE k.key ~* '(token|secret|key|passw|pwd|sas|sig|credential|auth|private)'
  )
$fn$;

-- 4. Tables.
CREATE TABLE ratio.tenants (
  id          uuid PRIMARY KEY,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Non-secret configuration only. There is deliberately no secrets column.
CREATE TABLE ratio.sources (
  tenant_id               uuid NOT NULL REFERENCES ratio.tenants (id),
  id                      uuid NOT NULL,
  source_key              text NOT NULL CHECK (source_key ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  kind                    text NOT NULL CHECK (kind IN ('focus_file', 'fake')),
  display_name            text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  coverage                text NOT NULL CHECK (coverage IN ('public_cloud', 'private_cloud', 'on_prem')),
  declared_focus_version  text CHECK (declared_focus_version ~ '^1\.[0-4]$'),
  enabled                 boolean NOT NULL DEFAULT true,
  config                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_key),
  CONSTRAINT sources_config_is_object CHECK (jsonb_typeof(config) = 'object'),
  CONSTRAINT sources_config_no_secrets CHECK (NOT ratio.jsonb_has_secret_like_key(config))
);

CREATE TABLE ratio.sync_runs (
  tenant_id         uuid NOT NULL,
  id                uuid NOT NULL,
  source_id         uuid NOT NULL,
  run_kind          text NOT NULL CHECK (run_kind IN ('scheduled', 'backfill', 'replay')),
  period_from       date,
  period_to         date,
  status            text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'abandoned')),
  lease_token       uuid,
  lease_expires_at  timestamptz,
  heartbeat_at      timestamptz,
  attempt           integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  error_code        text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  error_detail      text CHECK (length(error_detail) <= 4000), -- writer must redact
  stats             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(stats) = 'object'),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_id, id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES ratio.sources (tenant_id, id),
  CONSTRAINT sync_runs_period_pair CHECK ((period_from IS NULL) = (period_to IS NULL)),
  CONSTRAINT sync_runs_period_months CHECK (
    period_from IS NULL
    OR (extract(day FROM period_from) = 1 AND extract(day FROM period_to) = 1 AND period_from <= period_to)
  ),
  CONSTRAINT sync_runs_running_has_lease CHECK (
    status <> 'running' OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND finished_at IS NULL)
  ),
  CONSTRAINT sync_runs_terminal_finished CHECK (status = 'running' OR finished_at IS NOT NULL)
);
-- At most one active run per (tenant, source).
CREATE UNIQUE INDEX sync_runs_one_running_per_source ON ratio.sync_runs (tenant_id, source_id) WHERE status = 'running';

CREATE TABLE ratio.ingest_batches (
  tenant_id                 uuid NOT NULL,
  id                        uuid NOT NULL,
  source_id                 uuid NOT NULL,
  run_id                    uuid NOT NULL,
  billing_period            date NOT NULL CHECK (extract(day FROM billing_period) = 1),
  artifact_set_fingerprint  text NOT NULL CHECK (artifact_set_fingerprint ~ '^[0-9a-f]{64}$'),
  status                    text NOT NULL CHECK (status IN ('staged', 'published', 'superseded', 'quarantined')),
  row_count                 bigint NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  control_row_count         bigint CHECK (control_row_count >= 0),
  control_billed_total      numeric,
  loaded_billed_total       numeric NOT NULL DEFAULT 0,
  reconciliation            text NOT NULL DEFAULT 'unverified' CHECK (reconciliation IN ('reconciled', 'unverified', 'variance')),
  is_provisional            boolean NOT NULL,
  quarantine_reason         text CHECK (length(quarantine_reason) <= 2000),
  validation_error_count    bigint NOT NULL DEFAULT 0 CHECK (validation_error_count >= 0),
  created_at                timestamptz NOT NULL DEFAULT now(),
  published_at              timestamptz,
  superseded_at             timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_id, id),
  UNIQUE (tenant_id, source_id, billing_period, id),
  UNIQUE (tenant_id, source_id, billing_period, artifact_set_fingerprint),
  FOREIGN KEY (tenant_id, source_id, run_id) REFERENCES ratio.sync_runs (tenant_id, source_id, id),
  CONSTRAINT ingest_batches_published_at CHECK (status <> 'published' OR published_at IS NOT NULL),
  CONSTRAINT ingest_batches_superseded_at CHECK (status <> 'superseded' OR superseded_at IS NOT NULL),
  CONSTRAINT ingest_batches_quarantine_reason CHECK (status <> 'quarantined' OR quarantine_reason IS NOT NULL),
  CONSTRAINT ingest_batches_no_variance_published CHECK (NOT (status IN ('published', 'superseded') AND reconciliation = 'variance'))
);
-- At most one published batch per (tenant, source, billing period).
CREATE UNIQUE INDEX ingest_batches_one_published_per_period
  ON ratio.ingest_batches (tenant_id, source_id, billing_period) WHERE status = 'published';

-- Raw evidence: one row per source artifact, content-addressed by sha256.
-- The evidence key is fully determined by tenant/source/sha256, so no bucket
-- names, URLs, query strings or signatures can be stored here.
CREATE TABLE ratio.ingest_artifacts (
  tenant_id      uuid NOT NULL,
  source_id      uuid NOT NULL,
  batch_id       uuid NOT NULL,
  artifact_name  text NOT NULL CHECK (length(artifact_name) BETWEEN 1 AND 1024 AND artifact_name !~ '[?#]'),
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size      bigint NOT NULL CHECK (byte_size >= 0),
  row_count      bigint CHECK (row_count >= 0),
  evidence_key   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id, artifact_name),
  UNIQUE (tenant_id, batch_id, sha256),
  FOREIGN KEY (tenant_id, source_id, batch_id) REFERENCES ratio.ingest_batches (tenant_id, source_id, id),
  CONSTRAINT ingest_artifacts_evidence_key CHECK (
    evidence_key = 'evidence/' || tenant_id::text || '/' || source_id::text || '/' || sha256
  )
);

-- Inspectable quarantine detail: at most 1000 stored errors per batch (the
-- total is ingest_batches.validation_error_count).
CREATE TABLE ratio.ingest_validation_errors (
  tenant_id        uuid NOT NULL,
  batch_id         uuid NOT NULL,
  error_ordinal    integer NOT NULL CHECK (error_ordinal BETWEEN 1 AND 1000),
  artifact_sha256  text NOT NULL,
  row_ordinal      bigint CHECK (row_ordinal >= 0),
  column_name      text CHECK (length(column_name) <= 256),
  code             text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  message          text NOT NULL CHECK (length(message) <= 1000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id, error_ordinal),
  FOREIGN KEY (tenant_id, batch_id, artifact_sha256) REFERENCES ratio.ingest_artifacts (tenant_id, batch_id, sha256)
);

-- Row identity is (artifact sha256, row ordinal) — never a content hash, so two
-- identical legitimate line items are both kept.
CREATE TABLE ratio.cost_facts (
  tenant_id            uuid NOT NULL,
  batch_id             uuid NOT NULL,
  source_id            uuid NOT NULL,
  artifact_sha256      text NOT NULL,
  row_ordinal          bigint NOT NULL CHECK (row_ordinal >= 0),
  billing_period       date NOT NULL,
  charge_period_start  timestamptz NOT NULL,
  charge_period_end    timestamptz NOT NULL,
  billed_cost          numeric NOT NULL,
  effective_cost       numeric,
  list_cost            numeric,
  contracted_cost      numeric,
  billing_currency     text NOT NULL CHECK (billing_currency ~ '^[A-Z]{3}$'),
  provider_name        text,
  service_name         text,
  service_category     text,
  charge_category      text,
  resource_id          text,
  sub_account_id       text,
  billing_account_id   text,
  usage_quantity       numeric,
  usage_unit           text,
  pricing_quantity     numeric,
  pricing_unit         text,
  focus_version        text,
  extra_columns        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(extra_columns) = 'object'),
  PRIMARY KEY (tenant_id, batch_id, artifact_sha256, row_ordinal),
  FOREIGN KEY (tenant_id, source_id, billing_period, batch_id)
    REFERENCES ratio.ingest_batches (tenant_id, source_id, billing_period, id),
  FOREIGN KEY (tenant_id, batch_id, artifact_sha256) REFERENCES ratio.ingest_artifacts (tenant_id, batch_id, sha256),
  CONSTRAINT cost_facts_charge_period CHECK (charge_period_end >= charge_period_start)
);

-- THE pointer to the current batch of a (tenant, source, billing period).
CREATE TABLE ratio.period_publications (
  tenant_id            uuid NOT NULL,
  source_id            uuid NOT NULL,
  billing_period       date NOT NULL,
  batch_id             uuid NOT NULL,
  published_at         timestamptz NOT NULL DEFAULT now(),
  published_by_run_id  uuid NOT NULL,
  PRIMARY KEY (tenant_id, source_id, billing_period),
  UNIQUE (tenant_id, batch_id),
  FOREIGN KEY (tenant_id, source_id, billing_period, batch_id)
    REFERENCES ratio.ingest_batches (tenant_id, source_id, billing_period, id),
  FOREIGN KEY (tenant_id, source_id, published_by_run_id) REFERENCES ratio.sync_runs (tenant_id, source_id, id)
);

CREATE TABLE ratio.source_checkpoints (
  tenant_id    uuid NOT NULL,
  source_id    uuid NOT NULL,
  last_run_id  uuid,
  periods      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(periods) = 'object'),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES ratio.sources (tenant_id, id),
  FOREIGN KEY (tenant_id, source_id, last_run_id) REFERENCES ratio.sync_runs (tenant_id, source_id, id)
);

-- 5. Row-level security: enabled and forced on every table.
ALTER TABLE ratio.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.tenants
  USING (id = ratio.current_tenant_id()) WITH CHECK (id = ratio.current_tenant_id());

ALTER TABLE ratio.sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.sources
  USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());

ALTER TABLE ratio.sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.sync_runs
  USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());

ALTER TABLE ratio.ingest_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.ingest_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.ingest_batches
  USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());

ALTER TABLE ratio.ingest_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.ingest_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.ingest_artifacts
  USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());

ALTER TABLE ratio.ingest_validation_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.ingest_validation_errors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.ingest_validation_errors
  USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());

ALTER TABLE ratio.cost_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.cost_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.cost_facts
  USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());

ALTER TABLE ratio.period_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.period_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.period_publications
  USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());

ALTER TABLE ratio.source_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.source_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.source_checkpoints
  USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());

-- 6. The read path. Definer rights (owner ratio_owner, NOT security_invoker):
-- the reader is granted this view only, and FORCE RLS on the base tables still
-- filters by ratio.tenant_id because the owner is subject to it. The explicit
-- tenant predicate and the status = 'published' join are defence in depth.
CREATE VIEW ratio.cost_facts_published WITH (security_barrier = true) AS
SELECT
  cf.tenant_id,
  cf.source_id,
  cf.billing_period,
  cf.batch_id,
  cf.artifact_sha256,
  cf.row_ordinal,
  cf.charge_period_start,
  cf.charge_period_end,
  cf.billed_cost,
  cf.effective_cost,
  cf.list_cost,
  cf.contracted_cost,
  cf.billing_currency,
  cf.provider_name,
  cf.service_name,
  cf.service_category,
  cf.charge_category,
  cf.resource_id,
  cf.sub_account_id,
  cf.billing_account_id,
  cf.usage_quantity,
  cf.usage_unit,
  cf.pricing_quantity,
  cf.pricing_unit,
  cf.focus_version,
  cf.extra_columns,
  pp.published_at
FROM ratio.cost_facts cf
JOIN ratio.period_publications pp
  ON pp.tenant_id = cf.tenant_id
 AND pp.source_id = cf.source_id
 AND pp.billing_period = cf.billing_period
 AND pp.batch_id = cf.batch_id
JOIN ratio.ingest_batches b
  ON b.tenant_id = cf.tenant_id
 AND b.id = cf.batch_id
 AND b.status = 'published'
WHERE cf.tenant_id = ratio.current_tenant_id();

-- 7. Grants (least privilege). Nothing is granted to PUBLIC.
GRANT SELECT ON ratio.tenants, ratio.sources TO ratio_worker;
GRANT SELECT, INSERT, UPDATE ON ratio.sync_runs, ratio.period_publications, ratio.source_checkpoints TO ratio_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ratio.ingest_batches TO ratio_worker;
GRANT SELECT, INSERT, DELETE ON ratio.ingest_artifacts, ratio.ingest_validation_errors, ratio.cost_facts TO ratio_worker;
GRANT SELECT ON ratio.cost_facts_published TO ratio_worker;

-- The reader sees the published view and nothing else.
GRANT SELECT ON ratio.cost_facts_published TO ratio_reader;

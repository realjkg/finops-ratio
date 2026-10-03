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
--     cost_facts_published tenant-scoped for ratio_reader;
--   * facts, artifacts and validation errors are writable only while their
--     batch is `staged`; batches follow staged -> published | quarantined,
--     published <-> superseded; at every COMMIT each (tenant, source, period)
--     publication pointer names exactly its one `published` batch.
-- Amended in place before first release (challenger review of Slice 0); no
-- database outside dev/test has ever applied an earlier version of this file.
-- The runner wraps this file in one transaction (no BEGIN/COMMIT here).

-- 1. Roles: cluster-global, created idempotently and race-safe (two databases
--    in one cluster may migrate concurrently). NOLOGIN: deployment grants LOGIN.
-- ratio:allow-do creates the three roles only if missing (CREATE ROLE has no IF NOT EXISTS) and refuses dangerous pre-existing roles
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

  -- Fail closed (SQLSTATE RT010) rather than silently altering pre-existing roles.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname IN ('ratio_owner', 'ratio_worker', 'ratio_reader') AND (rolsuper OR rolbypassrls OR rolreplication)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'RT010',
      MESSAGE = 'ratio_owner/ratio_worker/ratio_reader must not be SUPERUSER, BYPASSRLS or REPLICATION';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname IN ('ratio_worker', 'ratio_reader') AND (rolcreaterole OR rolcreatedb)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'RT010', MESSAGE = 'ratio_worker/ratio_reader must not have CREATEROLE or CREATEDB';
  END IF;
  -- No ratio role may be a member of ANY role: that covers each other,
  -- pg_read_all_data / pg_write_all_data / pg_*_server_* and any superuser role.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.member
    WHERE r.rolname IN ('ratio_owner', 'ratio_worker', 'ratio_reader')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'RT010', MESSAGE = 'ratio_owner/ratio_worker/ratio_reader must not be members of any role';
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
-- SQL-standard body: parsed and bound when created, so a caller's search_path
-- or a temp object named `uuid` cannot change what it resolves to, and it
-- stays inlinable (no SET clause).
-- ratio:allow-function tenant helper used by every RLS policy and the view
CREATE FUNCTION ratio.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN NULLIF(pg_catalog.current_setting('ratio.tenant_id', true), '')::pg_catalog.uuid;

-- True when free text looks like it carries a credential: URL userinfo,
-- signed-URL parameters, AWS access key ids, bearer tokens. Fail closed.
-- ratio:allow-function secret-value guard used by CHECK constraints
CREATE FUNCTION ratio.text_looks_secret(t text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT t ~* '(://[^/@[:space:]]*@|sig=|signature=|akia[0-9a-z]{16}|asia[0-9a-z]{16}|bearer[[:space:]])'
$fn$;

-- True when any key, at any depth, looks like it names a secret. Deliberately
-- broad (fail closed): non-secret config must avoid these substrings.
-- ratio:allow-function secret-key guard used by CHECK constraints
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
    WHERE k.key ~* '(token|secret|key|pass|pw|sas|sig|credential|auth|private|bearer|cert|dsn|conn)'
  )
$fn$;

-- True when any string value, at any depth, looks secret (see text_looks_secret).
-- ratio:allow-function secret-value guard used by CHECK constraints
CREATE FUNCTION ratio.jsonb_has_secret_like_value(doc jsonb) RETURNS boolean
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
    SELECT 1 FROM walk w
    WHERE jsonb_typeof(w.v) = 'string' AND ratio.text_looks_secret(w.v #>> '{}')
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
  CONSTRAINT sources_config_no_secrets CHECK (NOT ratio.jsonb_has_secret_like_key(config)),
  CONSTRAINT sources_config_no_secret_values CHECK (NOT ratio.jsonb_has_secret_like_value(config))
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
  error_detail      text CHECK (length(error_detail) <= 4000 AND NOT ratio.text_looks_secret(error_detail)), -- writer must redact
  stats             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
                      jsonb_typeof(stats) = 'object'
                      AND NOT ratio.jsonb_has_secret_like_key(stats)
                      AND NOT ratio.jsonb_has_secret_like_value(stats)
                    ),
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
  control_billed_total      numeric CHECK (abs(control_billed_total) < 'Infinity'::numeric), -- also rejects NaN
  loaded_billed_total       numeric NOT NULL DEFAULT 0 CHECK (abs(loaded_billed_total) < 'Infinity'::numeric),
  reconciliation            text NOT NULL DEFAULT 'unverified' CHECK (reconciliation IN ('reconciled', 'unverified', 'variance')),
  is_provisional            boolean NOT NULL,
  quarantine_reason         text CHECK (length(quarantine_reason) <= 2000 AND NOT ratio.text_looks_secret(quarantine_reason)),
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
  CONSTRAINT ingest_batches_no_variance_published CHECK (NOT (status IN ('published', 'superseded') AND reconciliation = 'variance')),
  -- reconciled: at least one control, and every control present matches exactly.
  CONSTRAINT ingest_batches_reconciled_matches CHECK (
    reconciliation <> 'reconciled'
    OR (
      (control_row_count IS NOT NULL OR control_billed_total IS NOT NULL)
      AND (control_row_count IS NULL OR control_row_count = row_count)
      AND (control_billed_total IS NULL OR control_billed_total = loaded_billed_total)
    )
  ),
  CONSTRAINT ingest_batches_variance_has_control CHECK (
    reconciliation <> 'variance' OR control_row_count IS NOT NULL OR control_billed_total IS NOT NULL
  ),
  -- A published (or retained) batch is `unverified` exactly when it had no control.
  CONSTRAINT ingest_batches_published_reconciliation CHECK (
    status NOT IN ('published', 'superseded')
    OR (reconciliation = 'unverified') = (control_row_count IS NULL AND control_billed_total IS NULL)
  )
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
  artifact_name  text NOT NULL CHECK (
                   length(artifact_name) BETWEEN 1 AND 1024 AND artifact_name !~ '[?#]' AND NOT ratio.text_looks_secret(artifact_name)
                 ),
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
  message          text NOT NULL CHECK (length(message) <= 1000 AND NOT ratio.text_looks_secret(message)),
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
  -- abs(x) < 'Infinity' rejects Infinity, -Infinity and NaN (NaN sorts above Infinity).
  billed_cost          numeric NOT NULL CHECK (abs(billed_cost) < 'Infinity'::numeric),
  effective_cost       numeric CHECK (abs(effective_cost) < 'Infinity'::numeric),
  list_cost            numeric CHECK (abs(list_cost) < 'Infinity'::numeric),
  contracted_cost      numeric CHECK (abs(contracted_cost) < 'Infinity'::numeric),
  billing_currency     text NOT NULL CHECK (billing_currency ~ '^[A-Z]{3}$'),
  provider_name        text,
  service_name         text,
  service_category     text,
  charge_category      text,
  resource_id          text,
  sub_account_id       text,
  billing_account_id   text,
  usage_quantity       numeric CHECK (abs(usage_quantity) < 'Infinity'::numeric),
  usage_unit           text,
  pricing_quantity     numeric CHECK (abs(pricing_quantity) < 'Infinity'::numeric),
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

-- 5. Lifecycle and immutability, enforced by the database (applies to every
--    role, including the owner and superusers unless triggers are disabled).
--    SQLSTATEs: RT001 immutable child row / TRUNCATE, RT002 illegal batch
--    transition or frozen column, RT003 pointer/published-batch disagreement.

-- Facts, artifacts and validation errors may be written only while their batch
-- is `staged`. FOR SHARE on the batch row serializes against a concurrent
-- status change (publish/quarantine) of that batch.
-- ratio:allow-function staged-only immutability trigger function
CREATE FUNCTION ratio.tg_child_of_staged_batch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  st text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT b.status INTO st FROM ratio.ingest_batches b
     WHERE b.tenant_id = OLD.tenant_id AND b.id = OLD.batch_id
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'RT001',
        MESSAGE = format('%s row: parent batch %s not found (or not visible to this tenant)', TG_TABLE_NAME, OLD.batch_id);
    END IF;
    IF st <> 'staged' THEN
      RAISE EXCEPTION USING ERRCODE = 'RT001',
        MESSAGE = format('%s rows of a %s batch are immutable', TG_TABLE_NAME, st);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT b.status INTO st FROM ratio.ingest_batches b
     WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.batch_id
     FOR SHARE;
    -- Not found (missing, or another tenant's batch hidden by RLS): refuse here
    -- rather than trusting the FK / RLS that would run later.
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'RT001',
        MESSAGE = format('%s row: parent batch %s not found (or not visible to this tenant)', TG_TABLE_NAME, NEW.batch_id);
    END IF;
    IF st <> 'staged' THEN
      RAISE EXCEPTION USING ERRCODE = 'RT001',
        MESSAGE = format('cannot add %s rows to a %s batch', TG_TABLE_NAME, st);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;

-- Ingested data is retained: TRUNCATE (which bypasses row triggers) is refused.
-- ratio:allow-function TRUNCATE refusal trigger function
CREATE FUNCTION ratio.tg_refuse_truncate() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'RT001', MESSAGE = format('TRUNCATE of ratio.%s is refused', TG_TABLE_NAME);
END
$fn$;

-- Batch lifecycle: new batches are `staged`; only staged batches may be
-- deleted or have their data changed; allowed transitions are
-- staged -> published | quarantined, published -> superseded (replaced) and
-- superseded -> published (replay/rollback). Quarantined is terminal.
-- ratio:allow-function batch lifecycle trigger function
CREATE FUNCTION ratio.tg_batch_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'staged' THEN
      RAISE EXCEPTION USING ERRCODE = 'RT002', MESSAGE = format('a new batch must start staged, not %s', NEW.status);
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'staged' THEN
      RAISE EXCEPTION USING ERRCODE = 'RT002', MESSAGE = format('only staged batches can be deleted (this one is %s)', OLD.status);
    END IF;
    RETURN OLD;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW; -- exact no-op
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.source_id, NEW.billing_period, NEW.artifact_set_fingerprint, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.source_id, OLD.billing_period, OLD.artifact_set_fingerprint, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'RT002', MESSAGE = 'batch identity columns are immutable';
  END IF;
  IF OLD.status = 'staged' THEN
    IF NEW.status = 'superseded' THEN
      RAISE EXCEPTION USING ERRCODE = 'RT002', MESSAGE = 'illegal batch transition staged -> superseded';
    END IF;
    RETURN NEW; -- staged | published | quarantined (unknown values fail the status CHECK)
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'published_at' - 'superseded_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'published_at' - 'superseded_at') THEN
    RAISE EXCEPTION USING ERRCODE = 'RT002', MESSAGE = format('columns of a %s batch are immutable', OLD.status);
  END IF;
  IF (OLD.status = 'published' AND NEW.status = 'superseded')
     OR (OLD.status = 'superseded' AND NEW.status = 'published') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'RT002', MESSAGE = format('illegal batch transition %s -> %s', OLD.status, NEW.status);
END
$fn$;

-- Deferred (COMMIT-time) check for every (tenant, source, period) a row event
-- touched: a pointer exists iff a published batch exists, and the pointer
-- names that (single) published batch. Inlined in the trigger function (no
-- separately callable helper, so the worker needs no EXECUTE grant for it).
-- If RLS is active for the committing role, the tenant in force at COMMIT must
-- be the row's tenant: otherwise RLS would hide the rows and the check would
-- pass vacuously (challenger round 2, H1).
-- ratio:allow-function deferred publication consistency trigger function
CREATE FUNCTION ratio.tg_publication_consistency() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  k record;
  v_ptr uuid;
  v_has_ptr boolean;
  v_published uuid[];
BEGIN
  FOR k IN
    SELECT DISTINCT x.tenant_id, x.source_id, x.billing_period
    FROM (
      SELECT NEW.tenant_id, NEW.source_id, NEW.billing_period WHERE TG_OP IN ('INSERT', 'UPDATE')
      UNION ALL
      SELECT OLD.tenant_id, OLD.source_id, OLD.billing_period WHERE TG_OP IN ('UPDATE', 'DELETE')
    ) AS x(tenant_id, source_id, billing_period)
  LOOP
    IF (row_security_active('ratio.period_publications'::regclass) OR row_security_active('ratio.ingest_batches'::regclass))
       AND ratio.current_tenant_id() IS DISTINCT FROM k.tenant_id THEN
      RAISE EXCEPTION USING ERRCODE = 'RT003',
        MESSAGE = 'ratio.tenant_id changed before COMMIT: publication consistency cannot be verified';
    END IF;
    SELECT pp.batch_id INTO v_ptr FROM ratio.period_publications pp
     WHERE pp.tenant_id = k.tenant_id AND pp.source_id = k.source_id AND pp.billing_period = k.billing_period;
    v_has_ptr := FOUND;
    SELECT array_agg(b.id) INTO v_published FROM ratio.ingest_batches b
     WHERE b.tenant_id = k.tenant_id AND b.source_id = k.source_id AND b.billing_period = k.billing_period
       AND b.status = 'published';
    IF v_has_ptr THEN
      IF v_published IS NULL OR cardinality(v_published) <> 1 OR v_published[1] <> v_ptr THEN
        RAISE EXCEPTION USING ERRCODE = 'RT003',
          MESSAGE = format('publication pointer for source %s period %s must name its published batch', k.source_id, k.billing_period);
      END IF;
    ELSIF v_published IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'RT003',
        MESSAGE = format('published batch for source %s period %s has no publication pointer', k.source_id, k.billing_period);
    END IF;
  END LOOP;
  RETURN NULL;
END
$fn$;

-- ratio:allow-function attaches the child_of_staged_batch guard
CREATE TRIGGER child_of_staged_batch BEFORE INSERT OR UPDATE OR DELETE ON ratio.cost_facts
  FOR EACH ROW EXECUTE FUNCTION ratio.tg_child_of_staged_batch();
-- ratio:allow-function attaches the child_of_staged_batch guard
CREATE TRIGGER child_of_staged_batch BEFORE INSERT OR UPDATE OR DELETE ON ratio.ingest_artifacts
  FOR EACH ROW EXECUTE FUNCTION ratio.tg_child_of_staged_batch();
-- ratio:allow-function attaches the child_of_staged_batch guard
CREATE TRIGGER child_of_staged_batch BEFORE INSERT OR UPDATE OR DELETE ON ratio.ingest_validation_errors
  FOR EACH ROW EXECUTE FUNCTION ratio.tg_child_of_staged_batch();

-- ratio:allow-function attaches the refuse_truncate guard
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON ratio.cost_facts
  FOR EACH STATEMENT EXECUTE FUNCTION ratio.tg_refuse_truncate();
-- ratio:allow-function attaches the refuse_truncate guard
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON ratio.ingest_artifacts
  FOR EACH STATEMENT EXECUTE FUNCTION ratio.tg_refuse_truncate();
-- ratio:allow-function attaches the refuse_truncate guard
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON ratio.ingest_validation_errors
  FOR EACH STATEMENT EXECUTE FUNCTION ratio.tg_refuse_truncate();
-- ratio:allow-function attaches the refuse_truncate guard
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON ratio.ingest_batches
  FOR EACH STATEMENT EXECUTE FUNCTION ratio.tg_refuse_truncate();
-- ratio:allow-function attaches the refuse_truncate guard
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON ratio.period_publications
  FOR EACH STATEMENT EXECUTE FUNCTION ratio.tg_refuse_truncate();

-- ratio:allow-function attaches the batch_lifecycle guard
CREATE TRIGGER batch_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON ratio.ingest_batches
  FOR EACH ROW EXECUTE FUNCTION ratio.tg_batch_lifecycle();

-- Checked at COMMIT, so a publish transaction may supersede, publish and
-- re-point in any order; any other end state is refused.
-- ratio:allow-function attaches the publication_consistency guard
CREATE CONSTRAINT TRIGGER publication_consistency AFTER INSERT OR UPDATE OR DELETE ON ratio.period_publications
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ratio.tg_publication_consistency();
-- ratio:allow-function attaches the publication_consistency guard
CREATE CONSTRAINT TRIGGER publication_consistency AFTER INSERT OR UPDATE OR DELETE ON ratio.ingest_batches
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ratio.tg_publication_consistency();

-- 6. Row-level security: enabled and forced on every table.
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

-- 7. The read path. Definer rights (owner ratio_owner, NOT security_invoker):
-- the reader is granted this view only, and FORCE RLS on the base tables still
-- filters by ratio.tenant_id because the owner is subject to it. The explicit
-- tenant predicate and the status = 'published' join are defence in depth (the
-- join also hides rows while an uncommitted transaction has a pointer that the
-- deferred publication_consistency check would refuse at COMMIT).
-- ratio:allow-view the one published read path (definer rights, reader-granted)
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

-- 8. Grants (least privilege). Nothing is granted to PUBLIC.
GRANT SELECT ON ratio.tenants, ratio.sources TO ratio_worker;
GRANT SELECT, INSERT, UPDATE ON ratio.sync_runs, ratio.period_publications, ratio.source_checkpoints TO ratio_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ratio.ingest_batches TO ratio_worker;
GRANT SELECT, INSERT, DELETE ON ratio.ingest_artifacts, ratio.ingest_validation_errors, ratio.cost_facts TO ratio_worker;
-- Column-level only: the worker may record an artifact's row count after
-- streaming it (still subject to the staged-only trigger); nothing else.
GRANT UPDATE (row_count) ON ratio.ingest_artifacts TO ratio_worker;
GRANT SELECT ON ratio.cost_facts_published TO ratio_worker;

-- The reader sees the published view and nothing else.
GRANT SELECT ON ratio.cost_facts_published TO ratio_reader;

-- Functions: no EXECUTE for PUBLIC. The reader needs only the tenant helper
-- (view predicate + RLS policies); the worker also evaluates the CHECK guards.
-- Trigger functions need no grant (EXECUTE is checked when the trigger is created).
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ratio FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ratio.current_tenant_id() TO ratio_worker, ratio_reader;
GRANT EXECUTE ON FUNCTION ratio.text_looks_secret(text), ratio.jsonb_has_secret_like_key(jsonb),
  ratio.jsonb_has_secret_like_value(jsonb) TO ratio_worker;

-- ratio:phase expand
-- 0004_outcome_ledger: outcome accounting on the durable store (D3). Creates
-- only new objects (expand); every existing 0001 object is reused, none
-- altered:
--
--   * ratio.outcome_unit_registrations — the approved outcome-unit registry.
--     One row per (tenant, project) registration: the useful outcome unit, its
--     use-case pattern, the quality condition a completion must meet, the
--     performance claim (metric, baseline and observation samples), and the
--     value-ratio thresholds. Immutable rows: review edits are impossible —
--     a corrected definition is a new registration superseding the old one, so
--     an approval always covers exactly the content it reviewed. Approval is
--     the requester≠approver flow, enforced by CHECK and trigger (RT004).
--   * ratio.outcome_events — successful-outcome event ledger rows, one per
--     trace-level outcome determination, ingested through the SAME
--     staged→published batch machinery as cost_facts (batch FKs, staged-only
--     writes, publication pointer, supersede-on-republish): re-deriving a
--     period supersedes the old batch, so the published view never double
--     counts a trace. Carries the contract v1 outcome fields verbatim
--     (outcome_type, outcome_status, quality_result, completion_latency,
--     validated_benefit, benefit_validation_status) plus allocation_method and
--     data_as_of. Trace identity (trace_id, agent_run_id, request_id) is the
--     join key to consumption traces by project identity — an identity join at
--     read time, deliberately NOT a foreign key across migrations (the
--     consumption ledger is migration 0003 and may not exist yet when this
--     migration applies).
--   * ratio.outcome_benefit_evidence — benefit claims as ledger rows. The
--     three benefit buckets are strictly disjoint BY CONSTRUCTION: each row is
--     exactly one of measured_financial, estimated_productivity or
--     unvalidated, and the bucket's shape is CHECK-enforced (only
--     measured_financial rows carry money; estimated_productivity rows carry
--     unit counts and never cash — "hours saved" cannot become booked cash).
--   * ratio.outcome_supplemental_costs — infrastructure / implementation /
--     oversight / labor as evidence-backed ledger rows with evidence status,
--     replacing the simulation's free-text cost fields.
--   * ratio.outcome_events_published and ratio.outcome_period_counts — the
--     read path: published events, and per-project/period event counts.
--
-- Invariants inherited from 0001 and kept here: money is unconstrained numeric
-- (never float); timestamps are timestamptz; every tenant-owned row has
-- tenant_id uuid NOT NULL and every foreign key is composite and includes
-- tenant_id; RLS is ENABLED and FORCED with the reviewed tenant_isolation
-- policy shape; free text and JSON reject secret-looking content. The runner
-- wraps this file in one transaction (no BEGIN/COMMIT here).

SET LOCAL ROLE ratio_owner;

-- 1. The approved outcome-unit registry. Registration rows are immutable
--    definitions plus a governed status: a row starts `pending`, may be
--    approved (by an identity other than the requester) or revoked, and
--    `revoked` is terminal. At most one approved registration per
--    (tenant, project) — the registry that classifies the project's events.
CREATE TABLE ratio.outcome_unit_registrations (
  tenant_id                   uuid NOT NULL,
  id                          uuid NOT NULL,
  project_id                  text NOT NULL CHECK (
                                length(project_id) BETWEEN 1 AND 256
                                AND NOT ratio.text_looks_secret(project_id)
                              ),
  use_case_pattern            text NOT NULL CHECK (use_case_pattern IN (
                                'support_assistant', 'document_processing',
                                'engineering_assistant', 'workflow_agent'
                              )),
  outcome_unit_key            text NOT NULL CHECK (outcome_unit_key ~ '^[a-z][a-z0-9_]{0,99}$'),
  outcome_unit_label          text NOT NULL CHECK (
                                length(outcome_unit_label) BETWEEN 1 AND 120
                                AND NOT ratio.text_looks_secret(outcome_unit_label)
                              ),
  -- The performance claim under review (ported from the outcome plan): what
  -- is measured, in which direction it is good, the approved target, and the
  -- baseline vs observation samples with their evidence references.
  metric                      text NOT NULL CHECK (
                                length(metric) BETWEEN 1 AND 120
                                AND NOT ratio.text_looks_secret(metric)
                              ),
  unit                        text NOT NULL CHECK (
                                length(unit) BETWEEN 1 AND 50
                                AND NOT ratio.text_looks_secret(unit)
                              ),
  direction                   text NOT NULL CHECK (direction IN ('higher', 'lower')),
  target                      numeric NOT NULL CHECK (abs(target) < 'Infinity'::numeric),
  baseline                    jsonb NOT NULL CHECK (
                                jsonb_typeof(baseline) = 'object'
                                AND NOT ratio.jsonb_has_secret_like_key(baseline)
                                AND NOT ratio.jsonb_has_secret_like_value(baseline)
                              ),
  observation                 jsonb NOT NULL CHECK (
                                jsonb_typeof(observation) = 'object'
                                AND NOT ratio.jsonb_has_secret_like_key(observation)
                                AND NOT ratio.jsonb_has_secret_like_value(observation)
                              ),
  -- The quality condition: a completion is successful only when quality_result
  -- meets this threshold in quality_direction (deterministic derivation).
  quality_metric              text NOT NULL CHECK (
                                length(quality_metric) BETWEEN 1 AND 120
                                AND NOT ratio.text_looks_secret(quality_metric)
                              ),
  quality_direction           text NOT NULL CHECK (quality_direction IN ('higher', 'lower')),
  quality_threshold           numeric NOT NULL CHECK (abs(quality_threshold) < 'Infinity'::numeric),
  -- Value-ratio decision thresholds (ported rule: stop < continue < expand).
  stop_below                  numeric NOT NULL CHECK (abs(stop_below) < 'Infinity'::numeric),
  continue_at                 numeric NOT NULL CHECK (abs(continue_at) < 'Infinity'::numeric),
  expand_at                   numeric NOT NULL CHECK (abs(expand_at) < 'Infinity'::numeric),
  status                      text NOT NULL CHECK (status IN ('pending', 'approved', 'revoked')),
  requested_by                text NOT NULL CHECK (
                                length(requested_by) BETWEEN 1 AND 120
                                AND NOT ratio.text_looks_secret(requested_by)
                              ),
  approved_by                 text CHECK (
                                approved_by IS NULL
                                OR (length(approved_by) BETWEEN 1 AND 120 AND NOT ratio.text_looks_secret(approved_by))
                              ),
  approved_at                 timestamptz,
  supersedes_registration_id  uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_registration_id)
    REFERENCES ratio.outcome_unit_registrations (tenant_id, id),
  CONSTRAINT outcome_registrations_sample_shape CHECK (
    (baseline->>'value')::numeric IS NOT NULL
    AND (observation->>'value')::numeric IS NOT NULL
    AND (baseline->>'start') ~ '^\d{4}-\d{2}-\d{2}$'
    AND (baseline->>'end') ~ '^\d{4}-\d{2}-\d{2}$'
    AND (observation->>'start') ~ '^\d{4}-\d{2}-\d{2}$'
    AND (observation->>'end') ~ '^\d{4}-\d{2}-\d{2}$'
  ),
  -- Ported rule: the pre-AI baseline period must precede the observation period.
  CONSTRAINT outcome_registrations_baseline_precedes_observation CHECK (
    (baseline->>'end') < (observation->>'start')
  ),
  -- Ported rule: compare periods of equal duration.
  CONSTRAINT outcome_registrations_equal_duration CHECK (
    (observation->>'end')::pg_catalog.date - (observation->>'start')::pg_catalog.date
      = (baseline->>'end')::pg_catalog.date - (baseline->>'start')::pg_catalog.date
  ),
  -- Ported rule: ordered thresholds stop < continue < expand.
  CONSTRAINT outcome_registrations_ordered_thresholds CHECK (
    stop_below < continue_at AND continue_at < expand_at
  ),
  -- Requester ≠ approver, and an approved row always records who and when.
  CONSTRAINT outcome_registrations_approver_separate CHECK (
    approved_by IS NULL OR approved_by <> requested_by
  ),
  CONSTRAINT outcome_registrations_approved_shape CHECK (
    status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);

-- At most one approved registration per (tenant, project): the registry in force.
CREATE UNIQUE INDEX outcome_registrations_one_approved_per_project
  ON ratio.outcome_unit_registrations (tenant_id, project_id) WHERE status = 'approved';

-- 2. The outcome event ledger. Batch provenance and lifecycle exactly like
--    cost_facts: rows exist only inside an ingest batch, are writable only
--    while that batch is staged, and reach the read path only through the
--    period's published pointer (re-derivation supersedes, never double counts).
CREATE TABLE ratio.outcome_events (
  tenant_id                 uuid NOT NULL,
  source_id                 uuid NOT NULL,
  batch_id                  uuid NOT NULL,
  artifact_sha256           text NOT NULL,
  row_ordinal               bigint NOT NULL CHECK (row_ordinal >= 0),
  billing_period            date NOT NULL CHECK (extract(day FROM billing_period) = 1),
  project_id                text NOT NULL CHECK (
                              length(project_id) BETWEEN 1 AND 256
                              AND NOT ratio.text_looks_secret(project_id)
                            ),
  -- The approved registration whose quality condition classified this event.
  registry_id               uuid NOT NULL,
  -- Consumption-trace identity (contract v1 §Identity): the join keys to the
  -- consumption ledger by project identity. Deliberately not a cross-migration
  -- foreign key: the consumption tables are migration 0003's.
  trace_id                  text NOT NULL CHECK (
                              length(trace_id) BETWEEN 1 AND 128
                              AND trace_id ~ '^[0-9a-zA-Z._:-]{1,128}$'
                              AND NOT ratio.text_looks_secret(trace_id)
                            ),
  agent_run_id              text NOT NULL CHECK (
                              length(agent_run_id) BETWEEN 1 AND 128
                              AND NOT ratio.text_looks_secret(agent_run_id)
                            ),
  request_id                text CHECK (
                              request_id IS NULL
                              OR (length(request_id) BETWEEN 1 AND 128 AND NOT ratio.text_looks_secret(request_id))
                            ),
  -- Contract v1 outcome fields (enterprise conventions, cited as such):
  outcome_type              text NOT NULL CHECK (outcome_type ~ '^[a-z][a-z0-9_]{0,99}$'),
  outcome_status            text NOT NULL CHECK (outcome_status IN ('successful', 'failed', 'partial')),
  quality_result            numeric CHECK (abs(quality_result) < 'Infinity'::numeric),
  completion_latency        bigint CHECK (completion_latency >= 0), -- milliseconds
  validated_benefit         numeric CHECK (abs(validated_benefit) < 'Infinity'::numeric),
  benefit_validation_status text NOT NULL CHECK (benefit_validation_status IN (
                              'measured_financial', 'estimated_productivity', 'unvalidated'
                            )),
  currency                  text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  allocation_method         text NOT NULL CHECK (allocation_method IN (
                              'direct', 'even_split', 'keyed_tag', 'proportional_to_attributed'
                            )),
  data_as_of                timestamptz NOT NULL,
  occurred_at               timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, batch_id, artifact_sha256, row_ordinal),
  FOREIGN KEY (tenant_id, source_id, billing_period, batch_id)
    REFERENCES ratio.ingest_batches (tenant_id, source_id, billing_period, id),
  FOREIGN KEY (tenant_id, batch_id, artifact_sha256)
    REFERENCES ratio.ingest_artifacts (tenant_id, batch_id, sha256),
  FOREIGN KEY (tenant_id, registry_id)
    REFERENCES ratio.outcome_unit_registrations (tenant_id, id),
  -- An event belongs to the month it occurred in (UTC): re-derivation into a
  -- different period cannot silently move an outcome across billing periods.
  CONSTRAINT outcome_events_period_is_month_of_occurrence CHECK (
    billing_period = pg_catalog.date_trunc('month', occurred_at AT TIME ZONE 'UTC')::pg_catalog.date
  ),
  -- The R4 line, enforced in the database: only measured_financial rows carry
  -- money; estimated productivity and unvalidated rows never do, so they can
  -- never enter a value-to-cost numerator.
  CONSTRAINT outcome_events_benefit_shape CHECK (
    (benefit_validation_status = 'measured_financial') = (validated_benefit IS NOT NULL)
  ),
  -- A successful classification requires a quality result to have met the
  -- approved condition.
  CONSTRAINT outcome_events_success_requires_quality CHECK (
    outcome_status <> 'successful' OR quality_result IS NOT NULL
  )
);

-- One outcome determination per trace per batch: re-deriving the same trace
-- into one batch is refused; re-deriving into a NEW batch supersedes the old
-- one (the published view then counts each trace exactly once).
CREATE UNIQUE INDEX outcome_events_one_per_trace_per_batch
  ON ratio.outcome_events (tenant_id, batch_id, trace_id);

CREATE INDEX outcome_events_project_period
  ON ratio.outcome_events (tenant_id, project_id, billing_period);

-- 3. Benefit evidence: the three buckets as disjoint ledger rows.
CREATE TABLE ratio.outcome_benefit_evidence (
  tenant_id               uuid NOT NULL,
  id                      uuid NOT NULL,
  project_id              text NOT NULL CHECK (
                            length(project_id) BETWEEN 1 AND 256
                            AND NOT ratio.text_looks_secret(project_id)
                          ),
  billing_period          date NOT NULL CHECK (extract(day FROM billing_period) = 1),
  benefit_kind            text NOT NULL CHECK (benefit_kind IN (
                            'measured_financial', 'estimated_productivity', 'unvalidated'
                          )),
  category                text NOT NULL CHECK (category IN ('revenue', 'cost_savings', 'quality', 'risk')),
  title                   text NOT NULL CHECK (
                            length(title) BETWEEN 1 AND 160
                            AND NOT ratio.text_looks_secret(title)
                          ),
  -- Cash, for measured_financial rows only.
  amount                  numeric CHECK (abs(amount) < 'Infinity'::numeric),
  currency                text CHECK (currency ~ '^[A-Z]{3}$'),
  -- Non-cash unit value ("hours saved", quality points), for
  -- estimated_productivity rows only — never convertible to cash in this scope.
  unit_label              text CHECK (
                            unit_label IS NULL
                            OR (length(unit_label) BETWEEN 1 AND 50 AND NOT ratio.text_looks_secret(unit_label))
                          ),
  unit_amount             numeric CHECK (abs(unit_amount) < 'Infinity'::numeric),
  contribution_margin_pct numeric CHECK (contribution_margin_pct BETWEEN 0 AND 100),
  attribution_pct         numeric NOT NULL CHECK (attribution_pct BETWEEN 0 AND 100),
  method                  text CHECK (length(method) <= 500 AND NOT ratio.text_looks_secret(method)),
  reference               text CHECK (length(reference) <= 500 AND NOT ratio.text_looks_secret(reference)),
  recorded_by             text NOT NULL CHECK (
                            length(recorded_by) BETWEEN 1 AND 120
                            AND NOT ratio.text_looks_secret(recorded_by)
                          ),
  verified_by             text CHECK (
                            verified_by IS NULL
                            OR (length(verified_by) BETWEEN 1 AND 120 AND NOT ratio.text_looks_secret(verified_by))
                          ),
  verified_at             timestamptz,
  allocation_method       text NOT NULL CHECK (allocation_method IN (
                            'direct', 'even_split', 'keyed_tag', 'proportional_to_attributed'
                          )),
  data_as_of              timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT outcome_benefit_financial_shape CHECK (
    (benefit_kind = 'measured_financial') = (amount IS NOT NULL AND currency IS NOT NULL)
  ),
  -- estimated_productivity carries a unit count and NEVER cash.
  CONSTRAINT outcome_benefit_productivity_shape CHECK (
    (benefit_kind = 'estimated_productivity') = (
      unit_amount IS NOT NULL AND unit_label IS NOT NULL AND amount IS NULL
    )
  ),
  -- A measured financial claim requires evidence and an attribution method.
  CONSTRAINT outcome_benefit_measured_requires_evidence CHECK (
    benefit_kind <> 'measured_financial' OR (coalesce(reference, '') <> '' AND coalesce(method, '') <> '')
  ),
  -- Only financial categories can establish measured financial benefit.
  CONSTRAINT outcome_benefit_financial_categories CHECK (
    benefit_kind <> 'measured_financial' OR category IN ('revenue', 'cost_savings')
  ),
  CONSTRAINT outcome_benefit_verified_shape CHECK ((verified_by IS NOT NULL) = (verified_at IS NOT NULL)),
  CONSTRAINT outcome_benefit_approver_separate CHECK (
    verified_by IS NULL OR verified_by <> recorded_by
  )
);

-- 4. Supplemental costs as evidence-backed ledger rows (not free text). One row
--    per (tenant, project, period, category); edits clear verification (the
--    claim-review trigger), so a reviewer's approval always covers exactly the
--    current content.
CREATE TABLE ratio.outcome_supplemental_costs (
  tenant_id         uuid NOT NULL,
  id                uuid NOT NULL,
  project_id        text NOT NULL CHECK (
                      length(project_id) BETWEEN 1 AND 256
                      AND NOT ratio.text_looks_secret(project_id)
                    ),
  billing_period    date NOT NULL CHECK (extract(day FROM billing_period) = 1),
  category          text NOT NULL CHECK (category IN ('infrastructure', 'implementation', 'oversight', 'labor')),
  amount            numeric CHECK (abs(amount) < 'Infinity'::numeric),
  currency          text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  evidence_status   text NOT NULL CHECK (evidence_status IN ('measured', 'projected', 'assumed')),
  reference         text CHECK (length(reference) <= 500 AND NOT ratio.text_looks_secret(reference)),
  recorded_by       text NOT NULL CHECK (
                      length(recorded_by) BETWEEN 1 AND 120
                      AND NOT ratio.text_looks_secret(recorded_by)
                    ),
  verified_by       text CHECK (
                      verified_by IS NULL
                      OR (length(verified_by) BETWEEN 1 AND 120 AND NOT ratio.text_looks_secret(verified_by))
                    ),
  verified_at       timestamptz,
  allocation_method text NOT NULL CHECK (allocation_method IN (
                      'direct', 'even_split', 'keyed_tag', 'proportional_to_attributed'
                    )),
  data_as_of        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, project_id, billing_period, category),
  CONSTRAINT outcome_supplemental_measured_requires_evidence CHECK (
    evidence_status <> 'measured' OR (amount IS NOT NULL AND coalesce(reference, '') <> '')
  ),
  CONSTRAINT outcome_supplemental_verified_shape CHECK ((verified_by IS NOT NULL) = (verified_at IS NOT NULL)),
  CONSTRAINT outcome_supplemental_approver_separate CHECK (
    verified_by IS NULL OR verified_by <> recorded_by
  )
);

-- 5. Lifecycle and immutability triggers. Batch-child and TRUNCATE guards reuse
--    the 0001 trigger functions unchanged; the two new functions below govern
--    only this migration's tables.

-- Registration lifecycle: immutable definitions, governed status.
-- ratio:allow-function registration lifecycle guard (immutable definitions, requester≠approver flow)
CREATE FUNCTION ratio.tg_outcome_registration_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'RT004',
        MESSAGE = 'a registration starts pending; approval is a separate reviewer''s act';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION USING ERRCODE = 'RT004',
        MESSAGE = format('a %s registration is retained; only pending registrations can be deleted', OLD.status);
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.use_case_pattern, NEW.outcome_unit_key,
      NEW.outcome_unit_label, NEW.metric, NEW.unit, NEW.direction, NEW.target, NEW.baseline,
      NEW.observation, NEW.quality_metric, NEW.quality_direction, NEW.quality_threshold,
      NEW.stop_below, NEW.continue_at, NEW.expand_at, NEW.requested_by, NEW.supersedes_registration_id,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.use_case_pattern, OLD.outcome_unit_key,
      OLD.outcome_unit_label, OLD.metric, OLD.unit, OLD.direction, OLD.target, OLD.baseline,
      OLD.observation, OLD.quality_metric, OLD.quality_direction, OLD.quality_threshold,
      OLD.stop_below, OLD.continue_at, OLD.expand_at, OLD.requested_by, OLD.supersedes_registration_id,
      OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'RT004',
      MESSAGE = 'registration definition columns are immutable; insert a superseding registration instead';
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    RETURN NEW; -- the approved_shape and approver_separate CHECKs pin the evidence
  END IF;
  IF (OLD.status = 'pending' AND NEW.status = 'revoked')
     OR (OLD.status = 'approved' AND NEW.status = 'revoked') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'RT004',
    MESSAGE = format('illegal registration status transition %s -> %s', OLD.status, NEW.status);
END
$fn$;

-- Claim review for benefit evidence and supplemental costs: a reviewer's
-- verification covers exactly the content they reviewed — editing verified
-- content clears verification (ported rule), verification and content changes
-- cannot happen in one statement, and verified claims are retained.
-- ratio:allow-function claim review guard (edit clears verification; verified claims retained)
CREATE FUNCTION ratio.tg_outcome_claim_review() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  content_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.verified_by IS NOT NULL OR NEW.verified_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'RT004',
        MESSAGE = 'a recorded claim starts unverified; verification is a separate reviewer''s act';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.verified_by IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'RT004',
        MESSAGE = format('%s: a verified claim is retained; record a corrected claim instead', TG_TABLE_NAME);
    END IF;
    RETURN OLD;
  END IF;
  content_changed :=
    (to_jsonb(NEW) - 'verified_by' - 'verified_at' - 'updated_at')
      IS DISTINCT FROM
    (to_jsonb(OLD) - 'verified_by' - 'verified_at' - 'updated_at');
  IF content_changed THEN
    IF NEW.verified_by IS NOT NULL OR NEW.verified_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'RT004',
        MESSAGE = format('%s: verify the saved content first; a reviewer cannot verify their own edit', TG_TABLE_NAME);
    END IF;
    -- Ported rule: edits invalidate review.
    NEW.verified_by := NULL;
    NEW.verified_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;

-- ratio:allow-function attaches the registration lifecycle guard
CREATE TRIGGER registration_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON ratio.outcome_unit_registrations
  FOR EACH ROW EXECUTE FUNCTION ratio.tg_outcome_registration_lifecycle();

-- ratio:allow-function attaches the claim review guard
CREATE TRIGGER claim_review BEFORE INSERT OR UPDATE OR DELETE ON ratio.outcome_benefit_evidence
  FOR EACH ROW EXECUTE FUNCTION ratio.tg_outcome_claim_review();
-- ratio:allow-function attaches the claim review guard
CREATE TRIGGER claim_review BEFORE INSERT OR UPDATE OR DELETE ON ratio.outcome_supplemental_costs
  FOR EACH ROW EXECUTE FUNCTION ratio.tg_outcome_claim_review();

-- ratio:allow-function attaches the staged-only batch-child guard
CREATE TRIGGER child_of_staged_batch BEFORE INSERT OR UPDATE OR DELETE ON ratio.outcome_events
  FOR EACH ROW EXECUTE FUNCTION ratio.tg_child_of_staged_batch();
-- ratio:allow-function attaches the refuse_truncate guard
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON ratio.outcome_events
  FOR EACH STATEMENT EXECUTE FUNCTION ratio.tg_refuse_truncate();
-- ratio:allow-function attaches the refuse_truncate guard
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON ratio.outcome_unit_registrations
  FOR EACH STATEMENT EXECUTE FUNCTION ratio.tg_refuse_truncate();
-- ratio:allow-function attaches the refuse_truncate guard
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON ratio.outcome_benefit_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION ratio.tg_refuse_truncate();
-- ratio:allow-function attaches the refuse_truncate guard
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON ratio.outcome_supplemental_costs
  FOR EACH STATEMENT EXECUTE FUNCTION ratio.tg_refuse_truncate();

-- 6. Row-level security: enabled and forced, the reviewed tenant_isolation shape.
ALTER TABLE ratio.outcome_unit_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.outcome_unit_registrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.outcome_unit_registrations
  USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());

ALTER TABLE ratio.outcome_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.outcome_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.outcome_events
  USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());

ALTER TABLE ratio.outcome_benefit_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.outcome_benefit_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.outcome_benefit_evidence
  USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());

ALTER TABLE ratio.outcome_supplemental_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.outcome_supplemental_costs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.outcome_supplemental_costs
  USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());

-- 7. The read path: published events (definer rights, reader-granted) and the
--    per-project/period event counts over them. Same defence in depth as
--    cost_facts_published: the explicit tenant predicate plus the published
--    pointer join.
-- ratio:allow-view the published outcome read path (definer rights, reader-granted)
CREATE VIEW ratio.outcome_events_published WITH (security_barrier = true) AS
SELECT
  e.tenant_id,
  e.source_id,
  e.billing_period,
  e.batch_id,
  e.artifact_sha256,
  e.row_ordinal,
  e.project_id,
  e.registry_id,
  e.trace_id,
  e.agent_run_id,
  e.request_id,
  e.outcome_type,
  e.outcome_status,
  e.quality_result,
  e.completion_latency,
  e.validated_benefit,
  e.benefit_validation_status,
  e.currency,
  e.allocation_method,
  e.data_as_of,
  e.occurred_at,
  pp.published_at
FROM ratio.outcome_events e
JOIN ratio.period_publications pp
  ON pp.tenant_id = e.tenant_id
 AND pp.source_id = e.source_id
 AND pp.billing_period = e.billing_period
 AND pp.batch_id = e.batch_id
JOIN ratio.ingest_batches b
  ON b.tenant_id = e.tenant_id
 AND b.id = e.batch_id
 AND b.status = 'published'
WHERE e.tenant_id = ratio.current_tenant_id();

-- ratio:allow-view successful-outcome event counts per project, period and currency
CREATE VIEW ratio.outcome_period_counts WITH (security_barrier = true) AS
SELECT
  tenant_id,
  project_id,
  billing_period,
  currency,
  count(*)::bigint AS outcomes_total,
  count(*) FILTER (WHERE outcome_status = 'successful')::bigint AS successful_outcomes,
  count(*) FILTER (WHERE outcome_status = 'failed')::bigint AS failed_outcomes,
  count(*) FILTER (WHERE outcome_status = 'partial')::bigint AS partial_outcomes,
  sum(validated_benefit) FILTER (WHERE benefit_validation_status = 'measured_financial') AS validated_benefit_total,
  count(*) FILTER (WHERE benefit_validation_status = 'measured_financial')::bigint AS validated_benefit_events,
  max(data_as_of) AS data_as_of
FROM ratio.outcome_events_published
GROUP BY tenant_id, project_id, billing_period, currency;

-- 8. Grants (least privilege). Nothing is granted to PUBLIC; the widening is
--    recorded in REVIEWED_PRIVILEGES in the same change.
GRANT SELECT, INSERT, UPDATE ON ratio.outcome_unit_registrations TO ratio_worker;
GRANT SELECT, INSERT, DELETE ON ratio.outcome_events TO ratio_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ratio.outcome_benefit_evidence, ratio.outcome_supplemental_costs TO ratio_worker;
GRANT SELECT ON ratio.outcome_events_published, ratio.outcome_period_counts TO ratio_worker;

-- The reader sees the published outcome views and nothing else.
GRANT SELECT ON ratio.outcome_events_published, ratio.outcome_period_counts TO ratio_reader;

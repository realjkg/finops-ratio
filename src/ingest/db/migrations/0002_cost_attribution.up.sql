-- ratio:phase expand
-- D1 (spec art_qllcIvXH): cost-ledger enrichment — project identity,
-- allocation, billing scopes and the approved-FX policy.
--
-- Fully additive: no 0001 object is dropped, replaced, re-typed or re-granted.
-- The attribution columns on ratio.cost_facts are NULLABLE — absence means
-- "not yet attributed" and allocation coverage reports the unattributed
-- share; a NOT NULL default would fabricate attribution the exporter never
-- evidenced. The published read path is extended by a NEW view (the reviewed
-- cost_facts_published view is pinned by FOUNDATION_0001 and the expand
-- allow-list and is not touched); ratio_reader keeps reading exactly what it
-- read in 0001.
--
-- Conventions kept from 0001: money/quantities stay unconstrained numeric,
-- every object schema-qualified, tables tenant-scoped with forced RLS and the
-- reviewed tenant_isolation policy, ownership by ratio_owner, nothing granted
-- to PUBLIC, worker grants least-privilege.
SET LOCAL ROLE ratio_owner;

-- The brief's first implementation task: the billing-scopes registry — which
-- billing authorities (FOCUS BillingAccountId space) belong to which workload
-- accounts. Project identity is assigned HERE, not per billing account: a
-- billing account is never allowed to become the project boundary (a project
-- can span providers; one account can host several projects).
CREATE TABLE ratio.billing_scopes (
  tenant_id uuid NOT NULL REFERENCES ratio.tenants (id),
  id uuid NOT NULL,
  display_name text NOT NULL,
  provider_name text NOT NULL,
  billing_account_id text NOT NULL,
  workload_account_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_scopes_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT billing_scopes_account_unique UNIQUE (tenant_id, provider_name, billing_account_id)
);
ALTER TABLE ratio.billing_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.billing_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.billing_scopes
  USING (tenant_id = ratio.current_tenant_id())
  WITH CHECK (tenant_id = ratio.current_tenant_id());

-- Approved-FX policy: one approved rate per (currency, target, effective
-- date). Applied at READ time only — stored measures are never converted in
-- place, so a rate correction re-reads history instead of rewriting it.
-- effective_to NULL = open-ended; a new approval for the same pair is added as
-- a later row (the previous row's effective_to is then closed by the writer).
CREATE TABLE ratio.fx_rates (
  tenant_id uuid NOT NULL REFERENCES ratio.tenants (id),
  id uuid NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  target_currency char(3) NOT NULL CHECK (target_currency ~ '^[A-Z]{3}$'),
  effective_from date NOT NULL,
  effective_to date,
  rate numeric NOT NULL CHECK (rate > 0),
  source text NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fx_rates_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT fx_rates_effective_order CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
ALTER TABLE ratio.fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratio.fx_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratio.fx_rates
  USING (tenant_id = ratio.current_tenant_id())
  WITH CHECK (tenant_id = ratio.current_tenant_id());

-- One approved rate per (tenant, currency pair, effective date): an approval
-- supersedes, it does not fork. Lookup at read time: the greatest effective_from <= as_of.
CREATE UNIQUE INDEX fx_rates_effective_unique ON ratio.fx_rates (tenant_id, currency, target_currency, effective_from);

-- Org attribution dimensions on the durable cost facts. Carried from FOCUS
-- x_Ratio* extensions of the export (validated/mapped in src/ingest/focus),
-- or filled by the allocation step for shared rows. Nullable: unattributed
-- cost is a first-class, always-reported state (allocation coverage).
ALTER TABLE ratio.cost_facts
  ADD COLUMN project_id text,
  ADD COLUMN business_unit text,
  ADD COLUMN cost_center text,
  ADD COLUMN accountable_owner text,
  ADD COLUMN region text,
  ADD COLUMN environment text CONSTRAINT cost_facts_environment_check CHECK (environment IN ('prod', 'staging', 'dev', 'sandbox')),
  ADD COLUMN direct_or_shared text CONSTRAINT cost_facts_direct_or_shared_check CHECK (direct_or_shared IN ('direct', 'shared'));

-- The enriched published read path: the reviewed cost_facts_published view
-- joined back to the facts on their full natural key for the attribution
-- columns. Definer rights of ratio_owner (never security_invoker) so FORCE
-- RLS on cost_facts still filters by tenant; the explicit predicate mirrors
-- the reviewed view. Read-only over published batches only.
-- ratio:allow-view Native PG, read-only SELECT over the reviewed published view; exposes the new attribution columns without touching the pinned 0001 view
CREATE VIEW ratio.cost_facts_published_enriched
WITH (security_barrier = true)
AS
SELECT
  p.*,
  cf.project_id,
  cf.business_unit,
  cf.cost_center,
  cf.accountable_owner,
  cf.region,
  cf.environment,
  cf.direct_or_shared
FROM ratio.cost_facts_published p
JOIN ratio.cost_facts cf
  ON cf.tenant_id = p.tenant_id
 AND cf.source_id = p.source_id
 AND cf.billing_period = p.billing_period
 AND cf.batch_id = p.batch_id
 AND cf.artifact_sha256 = p.artifact_sha256
 AND cf.row_ordinal IS NOT DISTINCT FROM p.row_ordinal
WHERE cf.tenant_id = ratio.current_tenant_id();

-- Least privilege: the worker writes the registry tables and reads the
-- enriched published rows. The reader's grants are unchanged (it keeps
-- exactly the 0001 view; the enriched read path is a worker/agent surface).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ratio.billing_scopes TO ratio_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ratio.fx_rates TO ratio_worker;
GRANT SELECT ON TABLE ratio.cost_facts_published_enriched TO ratio_worker;

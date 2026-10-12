-- Down for 0002 (dev/test/CI only; the runner gates down migrations).
-- Exact inverse of the up file: drop the enriched view, the registry tables
-- and the attribution columns, restoring the reviewed 0001 catalog. Data in
-- the dropped columns/tables is dev/test data and is removed with them.
SET LOCAL ROLE ratio_owner;

DROP VIEW ratio.cost_facts_published_enriched;
DROP TABLE ratio.fx_rates;
DROP TABLE ratio.billing_scopes;

ALTER TABLE ratio.cost_facts
  DROP COLUMN project_id,
  DROP COLUMN business_unit,
  DROP COLUMN cost_center,
  DROP COLUMN accountable_owner,
  DROP COLUMN region,
  DROP COLUMN environment,
  DROP COLUMN direct_or_shared;

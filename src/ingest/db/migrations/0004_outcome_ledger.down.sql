-- Down for 0004_outcome_ledger (dev/test only: the runner refuses down in
-- production). Drops exactly the objects the up file created, in dependency
-- order: the read-path views, the four tables (outcome_events before the
-- registry its foreign key points at), then the two trigger functions no
-- other migration uses. Objects created by other migrations are untouched.
DROP VIEW IF EXISTS ratio.outcome_period_counts;
DROP VIEW IF EXISTS ratio.outcome_events_published;
DROP TABLE IF EXISTS ratio.outcome_events;
DROP TABLE IF EXISTS ratio.outcome_benefit_evidence;
DROP TABLE IF EXISTS ratio.outcome_supplemental_costs;
DROP TABLE IF EXISTS ratio.outcome_unit_registrations;
DROP FUNCTION IF EXISTS ratio.tg_outcome_claim_review();
DROP FUNCTION IF EXISTS ratio.tg_outcome_registration_lifecycle();

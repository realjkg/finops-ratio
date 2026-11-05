-- Down for DRAFT 0020_platform_connections (dev/test only: the runner refuses down in production). Drops exactly the
-- objects the up file created: the evidence refs first (their foreign key points at the connections), then the
-- connections, then the append-only trigger function (its triggers went with the table).
DROP TABLE IF EXISTS ratio.platform_evidence_refs;
DROP TABLE IF EXISTS ratio.platform_connections;
DROP FUNCTION IF EXISTS ratio.tg_platform_evidence_append_only();

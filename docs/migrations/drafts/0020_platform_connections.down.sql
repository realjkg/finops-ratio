-- Down for DRAFT 0020_platform_connections (dev/test only: the runner refuses down in production). Drops exactly the
-- two tables the up file created, the evidence refs first (their foreign key points at the connections).
DROP TABLE IF EXISTS ratio.platform_evidence_refs;
DROP TABLE IF EXISTS ratio.platform_connections;

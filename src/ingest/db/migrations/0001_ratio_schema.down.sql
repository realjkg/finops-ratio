-- Dev/test only (the runner refuses down in production). Drops schema `ratio`
-- and every object and row in it. Roles are cluster-global and may be shared
-- by other databases in the cluster, so they are intentionally left in place.
DROP SCHEMA ratio CASCADE;

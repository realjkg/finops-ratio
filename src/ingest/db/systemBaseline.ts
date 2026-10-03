// PUBLIC's explicit privileges in the PostgreSQL system schemas (round 14).
// The effective-privilege scan treats PUBLIC's default catalog access as the
// baseline; this module pins WHAT that baseline is, so an extra
// `GRANT … TO PUBLIC` on a system object (e.g. SELECT on pg_authid, EXECUTE on
// pg_read_file, USAGE on pg_toast) is refused — reader and worker inherit it.
//
// SYSTEM_PUBLIC_BASELINE (systemPublicBaseline.ts) is GENERATED from a fresh
// PostgreSQL 16 database with 0001 applied by
// scripts/ingest/generate-foundation-manifest.mjs; a DB test asserts a fresh
// database still equals it. It depends on the PostgreSQL MAJOR version: a server
// of another major fails closed until the baseline is regenerated and reviewed.
// Only explicit ACL entries are compared (an object whose ACL is NULL has
// implicit defaults and no entry); an explicit GRANT on such an object creates
// entries and is therefore reported too (fail closed). Revocations relative to
// the baseline only narrow access and are not reported.
import type { ClientBase } from 'pg';
import { SYSTEM_PUBLIC_BASELINE_DATA } from './systemPublicBaseline';

export interface SystemBaseline {
  pgMajor: number;
  entries: readonly string[];
}

export const SYSTEM_PUBLIC_BASELINE: SystemBaseline = SYSTEM_PUBLIC_BASELINE_DATA;

export const SYSTEM_SCHEMAS: readonly string[] = ['pg_catalog', 'information_schema', 'pg_toast'];

/** `<privilege> on <object>` for every explicit PUBLIC ACL entry in the system schemas. */
export async function systemPublicSnapshot(client: ClientBase): Promise<string[]> {
  await client.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
  const r = await client.query<{ e: string }>(
    `WITH sys AS (SELECT oid, nspname, nspacl FROM pg_catalog.pg_namespace WHERE nspname = ANY ($1::text[])),
          entries AS (
            SELECT a.grantee, a.privilege_type || ' on schema ' || s.nspname AS e
              FROM sys s CROSS JOIN LATERAL pg_catalog.aclexplode(s.nspacl) a
            UNION ALL
            SELECT a.grantee, a.privilege_type || ' on ' || s.nspname || '.' || c.relname
              FROM pg_catalog.pg_class c JOIN sys s ON s.oid = c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
            UNION ALL
            SELECT a.grantee, a.privilege_type || '(' || att.attname || ') on ' || s.nspname || '.' || c.relname
              FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid = att.attrelid JOIN sys s ON s.oid = c.relnamespace
              CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
             WHERE att.attacl IS NOT NULL
            UNION ALL
            SELECT a.grantee, a.privilege_type || ' on ' || s.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')'
              FROM pg_catalog.pg_proc p JOIN sys s ON s.oid = p.pronamespace CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
          )
     SELECT DISTINCT e FROM entries WHERE grantee = 0 ORDER BY 1`,
    [SYSTEM_SCHEMAS],
  );
  return r.rows.map((x) => x.e);
}

/** Server major version (e.g. 16). */
export async function serverMajor(client: ClientBase): Promise<number> {
  const r = await client.query<{ v: number }>(`SELECT (pg_catalog.current_setting('server_version_num')::int / 10000) AS v`);
  return Number(r.rows[0].v);
}

/** PUBLIC privileges in the system schemas that the baseline does not have; fails closed on a major-version mismatch. */
export async function systemBaselineViolations(client: ClientBase, baseline: SystemBaseline = SYSTEM_PUBLIC_BASELINE): Promise<string[]> {
  const major = await serverMajor(client);
  if (major !== baseline.pgMajor) {
    return [
      `system baseline was generated for PostgreSQL ${baseline.pgMajor} but the server is PostgreSQL ${major}: regenerate it with scripts/ingest/generate-foundation-manifest.mjs and review the diff`,
    ];
  }
  const allowed = new Set(baseline.entries);
  return (await systemPublicSnapshot(client))
    .filter((e) => !allowed.has(e))
    .map((e) => `PUBLIC holds ${e} (not in the PostgreSQL ${baseline.pgMajor} system baseline)`);
}

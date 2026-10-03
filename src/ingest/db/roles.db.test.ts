// Migration 0001 must refuse to run if a ratio role was pre-created (or later
// altered) into something dangerous (challenger findings M1/M2).
//
// Roles are cluster-global and shared with concurrently running test databases,
// so every dangerous state is created INSIDE a transaction that also runs the
// 0001 up SQL and is then rolled back: other sessions never see the change.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createTestDatabase, type TestDatabase } from './testing/harness';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations } from './migrationFiles';

let scratch: TestDatabase;
const upSql = loadMigrations(DEFAULT_MIGRATIONS_DIR)[0].upSql;

beforeAll(async () => {
  // Make sure the three roles exist in this cluster (a migrated throwaway DB creates them).
  const bootstrap = await createTestDatabase({ migrate: true });
  await bootstrap.close();
  scratch = await createTestDatabase({ migrate: false });
});
afterAll(async () => {
  await scratch?.close();
});

/** BEGIN; <pre>; <0001 up>; ROLLBACK — returns the error (if any) raised by 0001. */
async function runUpAfter(pre: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const c = new Client({ connectionString: scratch.url });
  c.on('error', () => undefined);
  await c.connect();
  try {
    await c.query(`SET lock_timeout = '10s'`);
    await c.query('BEGIN');
    if (pre) await c.query(pre);
    try {
      await c.query(upSql);
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code ?? 'UNKNOWN', message: err.message ?? String(e) };
    }
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end().catch(() => undefined);
  }
}

describe('0001 role guard', () => {
  it('positive control: with clean roles the migration body succeeds', async () => {
    expect(await runUpAfter('')).toEqual({ ok: true });
  });

  it('refuses SUPERUSER / BYPASSRLS / REPLICATION on any ratio role (M1)', async () => {
    for (const pre of [
      'ALTER ROLE ratio_reader BYPASSRLS',
      'ALTER ROLE ratio_worker BYPASSRLS',
      'ALTER ROLE ratio_owner BYPASSRLS',
      'ALTER ROLE ratio_worker SUPERUSER',
      'ALTER ROLE ratio_owner SUPERUSER',
      'ALTER ROLE ratio_reader REPLICATION',
      'ALTER ROLE ratio_owner REPLICATION',
    ]) {
      expect(await runUpAfter(pre), pre).toMatchObject({ ok: false, code: 'RT010' });
    }
  });

  it('refuses CREATEROLE / CREATEDB on ratio_worker and ratio_reader (M2)', async () => {
    for (const pre of [
      'ALTER ROLE ratio_worker CREATEROLE',
      'ALTER ROLE ratio_reader CREATEROLE',
      'ALTER ROLE ratio_worker CREATEDB',
      'ALTER ROLE ratio_reader CREATEDB',
    ]) {
      expect(await runUpAfter(pre), pre).toMatchObject({ ok: false, code: 'RT010' });
    }
  });

  it('refuses any membership of a ratio role in another role (M1/M2)', async () => {
    for (const pre of [
      'GRANT ratio_owner TO ratio_worker',
      'GRANT ratio_owner TO ratio_reader',
      'GRANT ratio_worker TO ratio_reader',
      'GRANT ratio_reader TO ratio_worker',
      'GRANT pg_read_all_data TO ratio_reader',
      'GRANT pg_write_all_data TO ratio_worker',
      'GRANT pg_read_server_files TO ratio_worker',
      'GRANT pg_execute_server_program TO ratio_owner',
      'GRANT pg_signal_backend TO ratio_reader',
      'GRANT postgres TO ratio_reader',
      'CREATE ROLE ratio_guard_probe_role NOLOGIN; GRANT ratio_guard_probe_role TO ratio_worker',
    ]) {
      expect(await runUpAfter(pre), pre).toMatchObject({ ok: false, code: 'RT010' });
    }
  });

  it('the guard leaves no trace: roles are clean after all the rolled-back probes', async () => {
    const c = new Client({ connectionString: scratch.url });
    await c.connect();
    try {
      const r = await c.query(
        `SELECT rolname, rolsuper, rolbypassrls, rolreplication, rolcreaterole, rolcreatedb FROM pg_roles
         WHERE rolname IN ('ratio_owner','ratio_worker','ratio_reader') ORDER BY 1`,
      );
      for (const row of r.rows) {
        expect(row, row.rolname).toMatchObject({ rolsuper: false, rolbypassrls: false, rolreplication: false, rolcreaterole: false, rolcreatedb: false });
      }
      const m = await c.query(
        `SELECT count(*)::int AS n FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.member
         WHERE r.rolname IN ('ratio_owner','ratio_worker','ratio_reader')`,
      );
      expect(m.rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });
});

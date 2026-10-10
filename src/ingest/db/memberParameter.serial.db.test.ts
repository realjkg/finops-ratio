// Round 16 (Copilot High H1), with a REAL login: a LOGIN member of
// ratio_worker that was granted SET on session_replication_role (cluster-global
// pg_parameter_acl) can switch its own session to `replica`, which disables
// the RT001–RT003 guard triggers (and FK enforcement): it deletes the facts of
// a PUBLISHED batch, which RT001 otherwise refuses. The catalog check must
// flag it — per migration and in `--status`.
//
// SERIAL test file (vitest.db.serial.config.ts): the login and its parameter
// grant must be COMMITTED to connect and use them, and while they exist every
// migration in the cluster is (correctly) refused. Unique name; revoked and
// dropped in `finally`; verified gone (role and pg_parameter_acl entry).
import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from 'pg';
import { createTestDatabase, type TestDatabase } from './testing/harness';
import { seedTwoTenants } from './testing/fixtures';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations } from './migrationFiles';
import { migrateUp, migrationStatus } from './migrate';
import { privilegeModelViolations } from './privilegeModel';
import { requireTestDatabaseUrl } from './testing/requireTestDatabaseUrl';

const created: string[] = [];
afterAll(async () => {
  const admin = new Client({ connectionString: requireTestDatabaseUrl() });
  await admin.connect();
  try {
    for (const r of created) {
      const exists = (await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [r])).rowCount;
      if (exists) {
        await admin.query(`REVOKE SET ON PARAMETER session_replication_role FROM ${r}`);
        await admin.query(`DROP ROLE ${r}`);
      }
    }
    const left = await admin.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY ($1::text[])`, [created]);
    expect(left.rows[0].n).toBe(0);
    const acl = await admin.query(
      `SELECT count(*)::int AS n FROM pg_parameter_acl WHERE EXISTS (SELECT 1 FROM unnest(paracl) a WHERE a::text ~ ANY ($1::text[]))`,
      [created.map((r) => `^${r}=`)],
    );
    expect(acl.rows[0].n).toBe(0);
  } finally {
    await admin.end();
  }
});

describe('real LOGIN member of ratio_worker with SET on session_replication_role (serial)', () => {
  it('it disables the RT triggers in its own session; the check, --status and a migration refuse it', async () => {
    const db: TestDatabase = await createTestDatabase({ migrate: true });
    const login = `ratio_probe_srr_${crypto.randomBytes(5).toString('hex')}`;
    try {
      const seed = await seedTwoTenants(db.pool);
      await db.pool.query(`CREATE ROLE ${login} LOGIN IN ROLE ratio_worker`);
      created.push(login);
      const u = new URL(db.url);
      u.username = login;
      u.password = '';
      const deletePublished = `DELETE FROM ratio.cost_facts WHERE tenant_id = $1 AND batch_id = $2`;
      const w = new Client({ connectionString: u.toString() });
      w.on('error', () => undefined);
      await w.connect();
      try {
        // Controls before the grant: RT001 refuses, and the login cannot set replica.
        await w.query('BEGIN');
        await w.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [seed.a.tenantId]);
        await expect(w.query(deletePublished, [seed.a.tenantId, seed.a.batchPublished])).rejects.toMatchObject({ code: 'RT001' });
        await w.query('ROLLBACK');
        await w.query('BEGIN');
        await expect(w.query(`SET LOCAL session_replication_role = replica`)).rejects.toMatchObject({ code: '42501' });
        await w.query('ROLLBACK');

        await db.pool.query(`GRANT SET ON PARAMETER session_replication_role TO ${login}`);

        // The threat: replica mode, then the published batch's facts are deleted.
        await w.query('BEGIN');
        await w.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [seed.a.tenantId]);
        await w.query(`SET LOCAL session_replication_role = replica`);
        const del = await w.query(deletePublished, [seed.a.tenantId, seed.a.batchPublished]);
        expect(del.rowCount).toBeGreaterThan(0);
        await w.query('ROLLBACK');
      } finally {
        await w.end();
      }
      const c = new Client({ connectionString: db.url });
      await c.connect();
      try {
        const re = new RegExp(`${login} holds parameter:session_replication_role:SET beyond the reviewed set`);
        expect((await privilegeModelViolations(c)).join('\n')).toMatch(re);
        const st = await migrationStatus(c);
        expect(st.problems).toContain('PRIVILEGE_MODEL_VIOLATION');
        expect(st.privilegeProblems.join('\n')).toMatch(re);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-srr-'));
        try {
          for (const f of fs.readdirSync(DEFAULT_MIGRATIONS_DIR)) fs.copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(dir, f));
          // The probe must sort after the real migration set so it is pending, not out of order.
          const probeVersion = String(Number(loadMigrations(DEFAULT_MIGRATIONS_DIR).at(-1)!.version) + 1).padStart(4, '0');
          fs.writeFileSync(path.join(dir, `${probeVersion}_noop.up.sql`), "-- ratio:phase expand\nCOMMENT ON SCHEMA ratio IS 'ratio';\n");
          await expect(migrateUp(c, { dir })).rejects.toThrow(re);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } finally {
        await c.end();
      }
    } finally {
      await db.pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [login]).catch(() => undefined);
      await db.pool.query(`REVOKE SET ON PARAMETER session_replication_role FROM ${login}`).catch(() => undefined);
      await db.pool.query(`DROP ROLE IF EXISTS ${login}`).catch(() => undefined);
      await db.close();
    }
  });
});

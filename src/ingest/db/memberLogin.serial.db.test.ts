// Round 15 (Copilot High), with REAL logins: a BYPASSRLS LOGIN member of
// ratio_worker reads another tenant's facts despite FORCE RLS, and the catalog
// check must flag it — in the per-migration check and in `--status`.
//
// SERIAL test file (vitest.db.serial.config.ts, run by `npm run test:db` AFTER
// the parallel phase): the login must be COMMITTED to connect, roles are
// cluster-global, and while it exists every migration in the cluster is
// (correctly) refused — so nothing else of this suite may run at the same
// time. Unique name, dropped in `finally`, verified gone.
import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from 'pg';
import { createTestDatabase, fixtureMigrationVersions, type TestDatabase } from './testing/harness';
import { seedTwoTenants } from './testing/fixtures';
import { DEFAULT_MIGRATIONS_DIR } from './migrationFiles';
import { migrateUp, migrationStatus } from './migrate';
import { privilegeModelViolations } from './privilegeModel';
import { requireTestDatabaseUrl } from './testing/requireTestDatabaseUrl';

// Fixture version just past the last real migration: an injected fixture file must
// never shadow a real version (real 0003–0005 land with the sibling slices).
const [V1] = fixtureMigrationVersions(1);

const created: string[] = [];
afterAll(async () => {
  const admin = new Client({ connectionString: requireTestDatabaseUrl() });
  await admin.connect();
  try {
    for (const r of created) await admin.query(`DROP ROLE IF EXISTS ${r}`);
    const left = await admin.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY ($1::text[])`, [created]);
    expect(left.rows[0].n).toBe(0);
  } finally {
    await admin.end();
  }
});

describe('real LOGIN members with dangerous attributes (serial)', () => {
  it('a BYPASSRLS LOGIN member of ratio_worker reads tenant A while set to tenant B; the check and --status flag it; a migration is refused', async () => {
    const db: TestDatabase = await createTestDatabase({ migrate: true });
    const login = `ratio_probe_bypass_${crypto.randomBytes(5).toString('hex')}`;
    try {
      const seed = await seedTwoTenants(db.pool);
      await db.pool.query(`CREATE ROLE ${login} LOGIN BYPASSRLS IN ROLE ratio_worker`);
      created.push(login);
      // The threat, as the login itself.
      const u = new URL(db.url);
      u.username = login;
      u.password = '';
      const w = new Client({ connectionString: u.toString() });
      await w.connect();
      try {
        await w.query('BEGIN');
        await w.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [seed.b.tenantId]);
        const leak = await w.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE tenant_id = $1`, [seed.a.tenantId]);
        expect(leak.rows[0].n).toBeGreaterThan(0);
        await w.query('ROLLBACK');
      } finally {
        await w.end();
      }
      // The check (what every migration and --status run).
      const c = new Client({ connectionString: db.url });
      await c.connect();
      try {
        expect((await privilegeModelViolations(c)).join('\n')).toMatch(new RegExp(`role ${login} \\(member of ratio_worker\\) must not be BYPASSRLS`));
        const st = await migrationStatus(c);
        expect(st.problems).toContain('PRIVILEGE_MODEL_VIOLATION');
        expect(st.privilegeProblems.join('\n')).toMatch(new RegExp(`role ${login} .*BYPASSRLS`));
        // Per-migration check: a harmless extra migration is refused while the login exists.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-member-'));
        try {
          for (const f of fs.readdirSync(DEFAULT_MIGRATIONS_DIR)) {
            fs.copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(dir, f));
          }
          fs.writeFileSync(path.join(dir, `${V1}_noop.up.sql`), '-- ratio:phase expand\nCOMMENT ON SCHEMA ratio IS \'ratio\';\n');
          await expect(migrateUp(c, { dir })).rejects.toThrow(new RegExp(`role ${login} \\(member of ratio_worker\\) must not be BYPASSRLS`));
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } finally {
        await c.end();
      }
    } finally {
      await db.pool.query(`DROP ROLE IF EXISTS ${login}`).catch(() => undefined);
      await db.close();
    }
  });
});

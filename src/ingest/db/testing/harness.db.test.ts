import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createTestDatabase } from './harness';
import { requireTestDatabaseUrl } from './requireTestDatabaseUrl';
import { loadMigrations, DEFAULT_MIGRATIONS_DIR } from '../migrationFiles';

async function databaseExists(name: string): Promise<boolean> {
  const admin = new Client({ connectionString: requireTestDatabaseUrl() });
  await admin.connect();
  try {
    const r = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return r.rowCount === 1;
  } finally {
    await admin.end();
  }
}

describe('DB test harness', () => {
  it('creates a uniquely named database and drops it', async () => {
    const one = await createTestDatabase({ migrate: false });
    const two = await createTestDatabase({ migrate: false });
    try {
      expect(one.name).not.toBe(two.name);
      expect(one.name).toMatch(/^ratio_test_[a-z0-9_]+$/);
      expect(await databaseExists(one.name)).toBe(true);
      const cur = await one.pool.query('SELECT current_database() AS d');
      expect(cur.rows[0].d).toBe(one.name);
      const noSchema = await one.pool.query(`SELECT to_regnamespace('ratio') AS n`);
      expect(noSchema.rows[0].n).toBeNull();
    } finally {
      await one.close();
      await two.close();
    }
    expect(await databaseExists(one.name)).toBe(false);
    expect(await databaseExists(two.name)).toBe(false);
  });

  it('migrate option leaves the database fully migrated', async () => {
    const db = await createTestDatabase({ migrate: true });
    try {
      const r = await db.pool.query('SELECT version FROM public.schema_migrations ORDER BY version');
      expect(r.rows.map((x) => x.version)).toEqual(loadMigrations(DEFAULT_MIGRATIONS_DIR).map((m) => m.version));
    } finally {
      await db.close();
    }
  });

  it('two test databases are isolated from each other', async () => {
    const one = await createTestDatabase({ migrate: true });
    const two = await createTestDatabase({ migrate: true });
    try {
      await one.pool.query(`INSERT INTO ratio.tenants (id, slug) VALUES ('cccccccc-0000-4000-8000-000000000001', 'only-in-one')`);
      const r = await two.pool.query(`SELECT count(*)::int AS n FROM ratio.tenants`);
      expect(r.rows[0].n).toBe(0);
    } finally {
      await one.close();
      await two.close();
    }
  });
});

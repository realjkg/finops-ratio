// Round 15 (Copilot Medium): a transaction whose callback swallowed a query
// error is ABORTED; PostgreSQL then answers COMMIT with the ROLLBACK command
// tag. The helpers must report that as a failure, never as success.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client, type ClientBase } from 'pg';
import { createTestDatabase, type TestDatabase } from './testing/harness';
import { DEFAULT_MIGRATIONS_DIR } from './migrationFiles';
import { migrateUp } from './migrate';
import { withTenantTransaction } from './tenant';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function db(migrate: boolean): Promise<TestDatabase> {
  const d = await createTestDatabase({ migrate });
  cleanups.push(() => d.close());
  return d;
}

describe('COMMIT answered with ROLLBACK is a failure', () => {
  it('withTenantTransaction: a callback that catches a failing statement and returns makes the helper throw; nothing is written', async () => {
    const d = await db(true);
    const tenant = crypto.randomUUID();
    const slug = `t-${tenant.slice(0, 8)}`;
    await expect(
      withTenantTransaction(d.pool, tenant, async (c) => {
        await c.query(`INSERT INTO ratio.tenants (id, slug) VALUES ($1, $2)`, [tenant, slug]);
        await c.query('SELECT 1 / 0').catch(() => undefined); // swallowed: the transaction is now aborted
        return 'looks fine';
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_ROLLED_BACK' });
    const n = await d.pool.query(`SELECT count(*)::int AS n FROM ratio.tenants WHERE id = $1`, [tenant]);
    expect(n.rows[0].n).toBe(0);
  });

  it('migration runner: a COMMIT answered with ROLLBACK stops the run with TRANSACTION_ROLLED_BACK and records nothing', async () => {
    const d = await db(false);
    const real = new Client({ connectionString: d.url });
    real.on('error', () => undefined);
    await real.connect();
    cleanups.push(() => real.end());
    // Proxy: the server-side outcome of an aborted transaction (ROLLBACK + its command tag) in place of a COMMIT.
    const proxy = {
      query: (sql: unknown, params?: unknown) =>
        sql === 'COMMIT' ? real.query('ROLLBACK').then((r) => ({ ...r, command: 'ROLLBACK' })) : real.query(sql as string, params as unknown[]),
    } as unknown as ClientBase;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-commit-'));
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    for (const f of fs.readdirSync(DEFAULT_MIGRATIONS_DIR)) fs.copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(dir, f));
    await expect(migrateUp(proxy, { dir })).rejects.toMatchObject({ code: 'TRANSACTION_ROLLED_BACK' });
    const ledger = await real.query(`SELECT count(*)::int AS n FROM public.schema_migrations`);
    expect(ledger.rows[0].n).toBe(0);
    expect((await real.query(`SELECT pg_catalog.to_regnamespace('ratio') IS NULL AS gone`)).rows[0].gone).toBe(true);
  });
});

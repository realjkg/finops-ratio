// Worker authorization: refuse superuser / BYPASSRLS / owner / non-worker
// connections at startup; the reader role cannot drive any worker write path.
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing/harness';
import { assertSafeWorkerRole, createWorkerPool } from './db';
import { runSync } from './pipeline';
import { replayBatch } from './replay';
import { showBatch } from './quarantine';
import { FakeFocusSource } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { main } from '../cli';
import { createLogin, seedTenantSource, type Login } from '../testing/db';
import { csvGz, rowsOf } from '../testing/focusCsv';

let db: TestDatabase;
const logins: Login[] = [];
const extraRoles: string[] = [];
beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
});
afterAll(async () => {
  for (const l of logins) await l.drop();
  for (const r of extraRoles) await db.pool.query(`DROP ROLE IF EXISTS ${r}`);
  await db.close();
});

async function login(memberOf: Array<'ratio_worker' | 'ratio_reader' | 'ratio_owner'>, attrs: string[] = []) {
  const l = await createLogin(db, memberOf, attrs);
  logins.push(l);
  return l;
}

async function check(url: string) {
  const pool = createWorkerPool(url, { max: 1 });
  try {
    await assertSafeWorkerRole(pool);
  } finally {
    await pool.end();
  }
}

describe('worker refuses unsafe database roles', () => {
  it('A1 accepts a plain ratio_worker login', async () => {
    const l = await login(['ratio_worker']);
    await expect(check(l.url)).resolves.toBeUndefined();
  });

  it('A1 refuses a superuser connection', async () => {
    await expect(check(db.url)).rejects.toMatchObject({ code: 'UNSAFE_DB_ROLE' });
  });

  it('A1 refuses a BYPASSRLS login even if it is a ratio_worker member', async () => {
    const l = await login(['ratio_worker'], ['BYPASSRLS']);
    await expect(check(l.url)).rejects.toMatchObject({ code: 'UNSAFE_DB_ROLE' });
  });

  it('A1 refuses a login that can SET ROLE to a superuser role', async () => {
    const su = `ratio_test_su_${crypto.randomBytes(4).toString('hex')}`;
    await db.pool.query(`CREATE ROLE ${su} NOLOGIN SUPERUSER`);
    extraRoles.push(su);
    const l = await login(['ratio_worker']);
    await db.pool.query(`GRANT ${su} TO ${l.name}`);
    await expect(check(l.url)).rejects.toMatchObject({ code: 'UNSAFE_DB_ROLE' });
  });

  it('A1 refuses a member of ratio_owner (could disable RLS)', async () => {
    const l = await login(['ratio_worker', 'ratio_owner']);
    await expect(check(l.url)).rejects.toMatchObject({ code: 'UNSAFE_DB_ROLE' });
  });

  it('A1 refuses a login that is not a ratio_worker member (e.g. the reader)', async () => {
    const l = await login(['ratio_reader']);
    await expect(check(l.url)).rejects.toMatchObject({ code: 'UNSAFE_DB_ROLE' });
  });

  it('A1 the CLI refuses to sync as a superuser (exit 1, UNSAFE_DB_ROLE, nothing written)', async () => {
    const s = await seedTenantSource(db.pool);
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], { RATIO_DATABASE_URL: db.url, RATIO_EVIDENCE_S3_BUCKET: 'unused' }, { out: (l) => out.push(l), err: (l) => err.push(l) });
    expect(code).toBe(1);
    expect(out.concat(err).join('\n')).toContain('UNSAFE_DB_ROLE');
    const runs = await db.pool.query(`SELECT count(*)::int AS n FROM ratio.sync_runs WHERE tenant_id = $1`, [s.tenantId]);
    expect(runs.rows[0].n).toBe(0);
  });
});

describe('reader cannot drive worker writes', () => {
  it('A2 every worker entry point fails with permission denied as ratio_reader', async () => {
    const s = await seedTenantSource(db.pool);
    const l = await login(['ratio_reader']);
    const pool = createWorkerPool(l.url, { max: 2 });
    try {
      const source = new FakeFocusSource([{ billingPeriod: '2026-07-01', artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf('2026-07-01', 1)) }] }]);
      await expect(
        runSync({ pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source, evidence: new MemoryEvidenceStore(), mode: 'sync' }),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(replayBatch({ pool, tenantId: s.tenantId, sourceKey: s.sourceKey, batchId: crypto.randomUUID() })).rejects.toMatchObject({ code: '42501' });
      await expect(showBatch(pool, s.tenantId, crypto.randomUUID())).rejects.toMatchObject({ code: '42501' });
    } finally {
      await pool.end();
    }
    const writes = await db.pool.query(
      `SELECT (SELECT count(*) FROM ratio.sync_runs WHERE tenant_id = $1) + (SELECT count(*) FROM ratio.ingest_batches WHERE tenant_id = $1) AS n`,
      [s.tenantId],
    );
    expect(Number(writes.rows[0].n)).toBe(0);
  });
});

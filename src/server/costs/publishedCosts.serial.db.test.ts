// GET /api/v1/costs/published refuses DANGEROUS reader logins (serial phase):
// a BYPASSRLS ratio_reader member, members that can assume a SUPERUSER /
// BYPASSRLS / REPLICATION / CREATEROLE / CREATEDB role, and members that can
// reach any of Slice 0's REFUSED_PREDEFINED_ROLES over an INHERIT, SET-only,
// ADMIN-only or transitive edge. The refusal reuses Slice 1's inspectRole /
// roleProblems (which read Slice 0's list), so this file iterates over the
// list itself; Slice 1's auth.serial.db.test.ts pins the list's contents.
//
// SERIAL test file (vitest.db.serial.config.ts): these logins must be
// COMMITTED to connect, and while one exists every migration/status check in
// the cluster is refused. Unique names, dropped afterwards, verified gone.
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../ingest/db/testing/harness';
import { seedTwoTenants, type Seeded } from '../../ingest/db/testing/fixtures';
import { createLogin, type Login } from '../../ingest/testing/db';
import { REFUSED_PREDEFINED_ROLES } from '../../ingest/db/privilegeModel';
import { createPublishedCostsRoute, ROUTE_MESSAGES } from './publishedCostsRoute';
import { Pool } from 'pg';
import { closeReaderPools, READER_SESSION_OPTIONS } from './readerPool';
import { readPublishedCosts } from './publishedCosts';
import { bearer, call, makeReq, TEST_API_TOKEN } from './testing/http';

let db: TestDatabase;
let seeded: Seeded;
const logins: Login[] = [];
const extraRoles: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  seeded = await seedTwoTenants(db.pool);
});
afterAll(async () => {
  await closeReaderPools();
  for (const l of logins) await l.drop();
  for (const r of extraRoles) await db.pool.query(`DROP ROLE IF EXISTS ${r}`);
  const left = await db.pool.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY ($1::text[])`, [[...logins.map((l) => l.name), ...extraRoles]]);
  expect(left.rows[0].n).toBe(0);
  await db.close();
});
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function status(readerUrl: string): Promise<{ status: number; body: unknown }> {
  const route = createPublishedCostsRoute({
    env: { RATIO_API_TOKEN: TEST_API_TOKEN, RATIO_API_TENANT_ID: seeded.a.tenantId, RATIO_READER_DATABASE_URL: readerUrl },
    logger: () => undefined,
  });
  const res = await call(route, makeReq({ headers: bearer() }));
  return { status: res.statusCode, body: res.body };
}

async function expectRefused(readerUrl: string) {
  const r = await status(readerUrl);
  expect(r.status).toBe(503);
  expect(r.body).toEqual({ error: { code: 'unsafe_db_login', message: ROUTE_MESSAGES.unsafeLogin, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
}

/** The unsafe_db_login log events written while fn runs. */
async function unsafeEvents(fn: () => Promise<void>): Promise<{ events: Array<Record<string, unknown>>; text: string }> {
  const lines: string[] = [];
  for (const f of ['error', 'warn'] as const) {
    vi.mocked(console[f]).mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  }
  await fn();
  const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.event === 'unsafe_db_login');
  return { events, text: lines.join('\n') };
}

async function readerLogin(attrs: string[] = []): Promise<Login> {
  const l = await createLogin(db, ['ratio_reader'], attrs);
  logins.push(l);
  return l;
}

async function role(attr: string): Promise<string> {
  const name = `ratio_test_s2_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  await db.pool.query(`CREATE ROLE ${name} NOLOGIN ${attr}`);
  extraRoles.push(name);
  return name;
}

describe('reader API refuses dangerous reader logins (serial)', () => {
  it('control: a plain ratio_reader login is served', async () => {
    expect((await status((await readerLogin()).url)).status).toBe(200);
  });

  for (const attr of ['BYPASSRLS', 'REPLICATION', 'CREATEROLE', 'CREATEDB']) {
    it(`refuses a ratio_reader login with ${attr}`, async () => {
      await expectRefused((await readerLogin([attr])).url);
    });

    it(`refuses a ratio_reader login that can assume a ${attr} role`, async () => {
      const r = await role(attr);
      const l = await readerLogin();
      await db.pool.query(`GRANT ${r} TO ${l.name} WITH INHERIT FALSE, SET TRUE`);
      await expectRefused(l.url);
    });
  }

  it('refuses a ratio_reader login that can SET ROLE to a SUPERUSER role', async () => {
    const r = await role('SUPERUSER');
    const l = await readerLogin();
    await db.pool.query(`GRANT ${r} TO ${l.name} WITH INHERIT FALSE, SET TRUE`);
    await expectRefused(l.url);
  });

  it('still serves a reader that is also a member of a harmless role (no over-refusal)', async () => {
    const r = await role('');
    const l = await readerLogin();
    await db.pool.query(`GRANT ${r} TO ${l.name}`);
    expect((await status(l.url)).status).toBe(200);
  });

  const edges: Array<[string, (target: string, login: string) => Promise<void>]> = [
    ['an INHERIT edge', (t, l) => db.pool.query(`GRANT ${t} TO ${l}`).then(() => undefined)],
    ['a SET-only edge', (t, l) => db.pool.query(`GRANT ${t} TO ${l} WITH INHERIT FALSE, SET TRUE`).then(() => undefined)],
    ['an ADMIN-only edge', (t, l) => db.pool.query(`GRANT ${t} TO ${l} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`).then(() => undefined)],
    [
      'a transitive edge (login -> plain role -> predefined role)',
      async (t, l) => {
        const mid = await role('');
        await db.pool.query(`GRANT ${t} TO ${mid}`);
        await db.pool.query(`GRANT ${mid} TO ${l} WITH INHERIT FALSE, SET TRUE`);
      },
    ],
  ];

  it('the log names a refused predefined role or an attribute by CODE only, never the role or the login', async () => {
    const l1 = await readerLogin();
    await db.pool.query(`GRANT pg_monitor TO ${l1.name}`);
    const l2 = await readerLogin(['CREATEDB']);
    const { events, text } = await unsafeEvents(async () => {
      await expectRefused(l1.url);
      await expectRefused(l2.url);
    });
    expect(events.map((e) => e.reasons)).toEqual([['REFUSED_PREDEFINED_ROLE'], ['UNSAFE_ATTRIBUTE']]);
    expect(text).not.toMatch(/pg_monitor|CREATEDB|ratio_reader/);
    expect(text).not.toContain(l1.name);
    expect(text).not.toContain(l2.name);
  });

  it("iterates over Slice 0's list (non-empty)", () => {
    expect(Object.keys(REFUSED_PREDEFINED_ROLES).length).toBeGreaterThanOrEqual(11);
  });

  for (const target of Object.keys(REFUSED_PREDEFINED_ROLES)) {
    for (const [edge, grant] of edges) {
      it(`refuses a ratio_reader login that reaches ${target} over ${edge}`, async () => {
        const l = await readerLogin();
        await grant(target, l.name);
        await expectRefused(l.url);
      });
    }
  }
});

// --- Copilot 4176238982 (D10a, D10c): a reader login whose ROLE defaults are
// hostile session settings. ALTER ROLE … SET is cluster state, so these run in
// the serial phase (Slice 1's static rule). D10b (the SQL alone) is in
// publishedCosts.db.test.ts.
describe('D10 output never depends on session settings: role defaults (serial; Copilot 4176238982)', () => {
  const HOSTILE_ROLE_DEFAULTS: Array<[string, string]> = [
    ['DateStyle', 'SQL, DMY'],
    ['TimeZone', 'America/Sao_Paulo'],
    ['IntervalStyle', 'sql_standard'],
    ['extra_float_digits', '-15'],
  ];
  const PERIOD = /^\d{4}-(0[1-9]|1[0-2])-01$/;
  const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
  interface PageBody {
    data: Array<{ billingPeriod: string; chargePeriodStart: string; publishedAt: string; batchId: string; artifactSha256: string; rowOrdinal: string }>;
    page: { nextCursor: string | null };
    totals: Array<{ billingPeriod: string; rowCount: unknown }> | null;
  }

  async function hostileLogin(): Promise<Login> {
    const l = await readerLogin();
    for (const [k, v] of HOSTILE_ROLE_DEFAULTS) await db.pool.query(`ALTER ROLE ${l.name} SET ${k} = '${v}'`);
    return l;
  }

  /** Every page at limit 1 (so page 2 onwards needs the cursor). */
  async function walk(readerUrl: string): Promise<PageBody[]> {
    const route = createPublishedCostsRoute({
      env: { RATIO_API_TOKEN: TEST_API_TOKEN, RATIO_API_TENANT_ID: seeded.a.tenantId, RATIO_READER_DATABASE_URL: readerUrl },
      logger: () => undefined,
    });
    const pages: PageBody[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i += 1) {
      const res = await call(route, makeReq({ headers: bearer(), query: cursor ? { limit: '1', cursor } : { limit: '1' } }));
      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
      const body = res.body as PageBody;
      pages.push(body);
      cursor = body.page.nextCursor;
      if (!cursor) break;
    }
    return pages;
  }

  it('D10a a reader login whose ROLE defaults are DateStyle=SQL,DMY, a non-UTC TimeZone, sql_standard intervals and extra_float_digits=-15 gets canonical output, and paging through nextCursor returns every row exactly once', async () => {
    expect(seeded.a.publishedRows).toBeGreaterThanOrEqual(2);
    const plainReader = await readerLogin();
    const odd = await hostileLogin();
    // The role defaults are real: a plain session of this login sees them.
    const plain = new Pool({ connectionString: odd.url, max: 1 });
    try {
      const s = await plain.query(`SELECT current_setting('DateStyle') AS ds, current_setting('TimeZone') AS tz, (DATE '2026-05-01')::text AS d`);
      expect(s.rows[0]).toEqual({ ds: 'SQL, DMY', tz: 'America/Sao_Paulo', d: '01/05/2026' });
    } finally {
      await plain.end();
    }
    const canonical = await walk(plainReader.url);
    const hostile = await walk(odd.url);
    const rows = hostile.flatMap((p) => p.data);
    const key = (r: PageBody['data'][number]) => `${r.batchId}/${r.artifactSha256}/${r.rowOrdinal}`;
    expect(hostile).toHaveLength(seeded.a.publishedRows);
    expect(rows).toHaveLength(seeded.a.publishedRows);
    expect(new Set(rows.map(key)).size).toBe(seeded.a.publishedRows);
    expect(rows).toEqual(canonical.flatMap((p) => p.data));
    expect(hostile[0].totals).toEqual(canonical[0].totals);
    for (const r of rows) {
      expect(r.billingPeriod).toMatch(PERIOD);
      expect(r.chargePeriodStart).toMatch(TS);
      expect(r.publishedAt).toMatch(TS);
    }
    for (const t of hostile[0].totals ?? []) {
      expect(t.billingPeriod).toMatch(PERIOD);
      expect(typeof t.rowCount).toBe('string');
    }
  });

  it('D10c fail closed: a pool that pins everything but DateStyle, for a login whose default is SQL,DMY, is refused (no data served)', async () => {
    const odd = await hostileLogin();
    const options = READER_SESSION_OPTIONS.split(' -c ')
      .map((o) => o.replace(/^-c /, ''))
      .filter((o) => !/^DateStyle=/.test(o))
      .map((o) => `-c ${o}`)
      .join(' ');
    expect(options).not.toMatch(/DateStyle/);
    const unpinned = new Pool({ connectionString: odd.url, max: 1, options });
    try {
      await expect(readPublishedCosts(unpinned, seeded.a.tenantId, { from: null, to: null, limit: 5, cursor: null })).rejects.toThrow(/published-costs read requires/);
    } finally {
      await unpinned.end();
    }
  });
});

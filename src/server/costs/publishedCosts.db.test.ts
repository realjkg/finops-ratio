// GET /api/v1/costs/published against a real Postgres 16 (Slice 0 schema),
// through the route handler, with REAL LOGIN roles (ratio_test_login_*):
//   - tenant isolation (tenant A never sees B's rows, and vice versa);
//   - only published facts (never staged, quarantined or superseded);
//   - money and quantities as exact decimal strings;
//   - keyset pagination bounds and traversal, period filter;
//   - the reader-login safety check refuses unsafe logins (the DANGEROUS
//     ones — BYPASSRLS, superuser roles, refused predefined roles — are
//     committed cluster state and live in publishedCosts.serial.db.test.ts).
// Data: Slice 0's synthetic two-tenant fixture (published + superseded +
// staged + quarantined batches per tenant) and a third tenant published by
// the REAL Slice 1 worker library (FakeFocusSource, in-memory evidence).
import crypto from 'crypto';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { NextApiHandler } from 'next';
import { Pool } from 'pg';
import { createTestDatabase, type TestDatabase } from '../../ingest/db/testing/harness';
import { seedTwoTenants, type Seeded } from '../../ingest/db/testing/fixtures';
import { createLogin, seedTenantSource, publishedTotals, type Login } from '../../ingest/testing/db';
import { createWorkerPool } from '../../ingest/worker/db';
import { runSync } from '../../ingest/worker/pipeline';
import { FakeFocusSource } from '../../ingest/sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../../ingest/evidence/MemoryEvidenceStore';
import { csvGz, focusRow, rowsOf } from '../../ingest/testing/focusCsv';
import { createPublishedCostsRoute, ROUTE_MESSAGES } from './publishedCostsRoute';
import { closeReaderPools, readerPool } from './readerPool';
import { PUBLISHED_COSTS_SQL, readPublishedCosts, setAfterPageHookForTests } from './publishedCosts';
import { READER_SESSION_OPTIONS } from './readerPool';
import { withTenantTransaction } from '../../ingest/db/tenant';
import { bearer, call, makeReq, TEST_API_TOKEN } from './testing/http';

interface Row {
  billingPeriod: string;
  sourceId: string;
  batchId: string;
  artifactSha256: string;
  rowOrdinal: string;
  billedCost: string;
  effectiveCost: string | null;
  usageQuantity: string | null;
  chargePeriodStart: string;
  publishedAt: string;
}
interface Total {
  billingPeriod: string;
  billingCurrency: string;
  /** bigint count as a decimal string (Copilot 4176238961). */
  rowCount: string;
  billedCost: string;
}
interface Body {
  data: Row[];
  page: { limit: number; nextCursor: string | null };
  totals: Total[] | null;
}

let db: TestDatabase;
let seeded: Seeded;
let reader: Login;
let worker: Login;
const logins: Login[] = [];
const C = { tenantId: '', sourceId: '', supersededBatch: '', quarantinedBatch: '' };
const PRECISE = '12345678901234567890.123456789012345678';
const TINY = '0.0000000001';

async function login(memberOf: Array<'ratio_worker' | 'ratio_reader' | 'ratio_owner'>): Promise<Login> {
  const l = await createLogin(db, memberOf);
  logins.push(l);
  return l;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  seeded = await seedTwoTenants(db.pool);
  reader = await login(['ratio_reader']);
  worker = await login(['ratio_worker']);

  // Tenant C, published by the real worker: 2026-05 (23 tiny rows), 2026-06
  // (restated once: the first set is superseded), 2026-04 quarantined.
  const s = await seedTenantSource(db.pool);
  C.tenantId = s.tenantId;
  C.sourceId = s.sourceId;
  const may = rowsOf('2026-05-01', 23, TINY, 'may');
  const juneFirst = rowsOf('2026-06-01', 4, '9.99', 'old');
  const juneFinal = [...rowsOf('2026-06-01', 10, '0.10', 'jun'), focusRow('2026-06-01', { BilledCost: PRECISE, EffectiveCost: PRECISE, ConsumedQuantity: '0.000000000000000001', ResourceId: 'precise' })];
  const april = [focusRow('2026-04-01', { BilledCost: 'not-a-number' })];
  const source = new FakeFocusSource([
    { billingPeriod: '2026-04-01', artifacts: [{ name: 'apr/a.csv.gz', bytes: csvGz(april) }] },
    { billingPeriod: '2026-05-01', artifacts: [{ name: 'may/a.csv.gz', bytes: csvGz(may.slice(0, 12)) }, { name: 'may/b.csv.gz', bytes: csvGz(may.slice(12)) }] },
    { billingPeriod: '2026-06-01', artifacts: [{ name: 'jun/a.csv.gz', bytes: csvGz(juneFirst) }] },
  ]);
  const pool = createWorkerPool(worker.url, { max: 2 });
  try {
    const evidence = new MemoryEvidenceStore();
    await runSync({ pool, tenantId: C.tenantId, sourceKey: s.sourceKey, source, evidence, mode: 'sync' });
    source.setPeriods([
      { billingPeriod: '2026-04-01', artifacts: [{ name: 'apr/a.csv.gz', bytes: csvGz(april) }] },
      { billingPeriod: '2026-05-01', artifacts: [{ name: 'may/a.csv.gz', bytes: csvGz(may.slice(0, 12)) }, { name: 'may/b.csv.gz', bytes: csvGz(may.slice(12)) }] },
      { billingPeriod: '2026-06-01', artifacts: [{ name: 'jun/b.csv.gz', bytes: csvGz(juneFinal) }] },
    ]);
    await runSync({ pool, tenantId: C.tenantId, sourceKey: s.sourceKey, source, evidence, mode: 'sync' });
  } finally {
    await pool.end();
  }
  const b = await db.pool.query(`SELECT id, billing_period::text AS p, status FROM ratio.ingest_batches WHERE tenant_id = $1 ORDER BY created_at`, [C.tenantId]);
  C.supersededBatch = b.rows.find((r) => r.p === '2026-06-01' && r.status === 'superseded')?.id;
  C.quarantinedBatch = b.rows.find((r) => r.p === '2026-04-01' && r.status === 'quarantined')?.id;
  // The fixture is what the tests assume (fail loudly otherwise).
  expect(C.supersededBatch).toBeTruthy();
  expect(C.quarantinedBatch).toBeTruthy();
}, 120_000);

afterAll(async () => {
  await closeReaderPools();
  for (const l of logins) await l.drop();
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

function routeFor(tenantId: string, readerUrl: string = reader.url): NextApiHandler {
  return createPublishedCostsRoute({
    env: { RATIO_API_TOKEN: TEST_API_TOKEN, RATIO_API_TENANT_ID: tenantId, RATIO_READER_DATABASE_URL: readerUrl },
    logger: () => undefined,
  });
}

async function get(tenantId: string, query: Record<string, string> = {}, opts: { readerUrl?: string; headers?: Record<string, string> } = {}) {
  const res = await call(routeFor(tenantId, opts.readerUrl), makeReq({ headers: { ...bearer(), ...(opts.headers ?? {}) }, query }));
  return res;
}

async function getOk(tenantId: string, query: Record<string, string> = {}, opts: { readerUrl?: string; headers?: Record<string, string> } = {}): Promise<Body> {
  const res = await get(tenantId, query, opts);
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return res.body as Body;
}

/** Every page, following nextCursor. */
async function all(tenantId: string, query: Record<string, string> = {}): Promise<{ rows: Row[]; pages: Body[] }> {
  const pages: Body[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 1000; i += 1) {
    const body = await getOk(tenantId, cursor ? { ...query, cursor } : query);
    pages.push(body);
    cursor = body.page.nextCursor;
    if (!cursor) break;
  }
  return { rows: pages.flatMap((p) => p.data), pages };
}

/** Superuser ground truth: published facts of a tenant (the view's definition, evaluated without RLS). */
async function groundTruth(tenantId: string): Promise<Array<{ batch: string; sha: string; ord: string; cost: string }>> {
  const r = await db.pool.query(
    `SELECT cf.batch_id::text AS batch, cf.artifact_sha256 AS sha, cf.row_ordinal::text AS ord, cf.billed_cost::text AS cost
       FROM ratio.cost_facts cf
       JOIN ratio.period_publications pp ON pp.tenant_id = cf.tenant_id AND pp.source_id = cf.source_id
                                         AND pp.billing_period = cf.billing_period AND pp.batch_id = cf.batch_id
       JOIN ratio.ingest_batches b ON b.tenant_id = cf.tenant_id AND b.id = cf.batch_id AND b.status = 'published'
      WHERE cf.tenant_id = $1
      ORDER BY cf.billing_period, cf.source_id, cf.artifact_sha256, cf.row_ordinal`,
    [tenantId],
  );
  return r.rows;
}

const key = (r: { batchId?: string; batch?: string; artifactSha256?: string; sha?: string; rowOrdinal?: string; ord?: string }) =>
  `${r.batchId ?? r.batch}/${r.artifactSha256 ?? r.sha}/${r.rowOrdinal ?? r.ord}`;

describe('D1 tenant isolation', () => {
  it('the key bound to tenant A returns exactly A’s published facts; bound to B exactly B’s', async () => {
    const { a, b } = seeded;
    const bodyA = await getOk(a.tenantId);
    const bodyB = await getOk(b.tenantId);
    expect(bodyA.data.map(key).sort()).toEqual((await groundTruth(a.tenantId)).map(key).sort());
    expect(bodyB.data.map(key).sort()).toEqual((await groundTruth(b.tenantId)).map(key).sort());
    expect(new Set(bodyA.data.map((r) => r.batchId))).toEqual(new Set([a.batchPublished]));
    expect(new Set(bodyB.data.map((r) => r.batchId))).toEqual(new Set([b.batchPublished]));
    expect(bodyA.data.map((r) => r.sourceId).every((x) => x === a.sourceId)).toBe(true);
    expect(bodyA.totals).toEqual([{ billingPeriod: a.period, billingCurrency: 'USD', rowCount: String(a.publishedRows), billedCost: a.publishedTotal }]);
    expect((await get(a.tenantId)).headers['cache-control']).toBe('no-store');
    expect(bodyB.totals).toEqual([{ billingPeriod: b.period, billingCurrency: 'USD', rowCount: String(b.publishedRows), billedCost: b.publishedTotal }]);
    // Nothing of B in A's answer and vice versa.
    const textA = JSON.stringify(bodyA);
    for (const id of [b.tenantId, b.sourceId, b.batchPublished, b.batchSuperseded, b.batchStaged, b.batchQuarantined]) expect(textA).not.toContain(id);
    const textB = JSON.stringify(bodyB);
    for (const id of [a.tenantId, a.sourceId, a.batchPublished, a.batchSuperseded, a.batchStaged, a.batchQuarantined]) expect(textB).not.toContain(id);
  });

  it('request headers cannot switch the tenant; a tenant without data gets nothing', async () => {
    const { a, b } = seeded;
    const body = await getOk(a.tenantId, {}, { headers: { 'x-ratio-tenant': b.tenantId, 'x-tenant-id': b.tenantId } });
    expect(new Set(body.data.map((r) => r.batchId))).toEqual(new Set([a.batchPublished]));
    const empty = await getOk(crypto.randomUUID());
    expect(empty).toEqual({ data: [], page: { limit: 100, nextCursor: null }, totals: [] });
  });

  it('a cursor taken from tenant B’s pages reveals nothing of B to tenant A', async () => {
    const pageB = await getOk(C.tenantId, { limit: '3' });
    expect(pageB.page.nextCursor).toBeTruthy();
    const body = await getOk(seeded.a.tenantId, { cursor: pageB.page.nextCursor as string });
    for (const r of body.data) expect(r.sourceId).toBe(seeded.a.sourceId);
    expect(JSON.stringify(body)).not.toContain(C.sourceId);
  });
});

describe('D2 only published facts', () => {
  it('no staged, quarantined or superseded fact appears (Slice 0 fixture)', async () => {
    for (const t of [seeded.a, seeded.b]) {
      const { rows } = await all(t.tenantId);
      const ids = new Set(rows.map((r) => r.batchId));
      for (const hidden of [t.batchSuperseded, t.batchStaged, t.batchQuarantined]) expect(ids.has(hidden)).toBe(false);
      expect(rows).toHaveLength(t.publishedRows);
    }
  });

  it('worker-published tenant: the quarantined period and the superseded revision are invisible; totals equal the ground truth', async () => {
    const { rows, pages } = await all(C.tenantId);
    const ids = new Set(rows.map((r) => r.batchId));
    expect(ids.has(C.supersededBatch)).toBe(false);
    expect(ids.has(C.quarantinedBatch)).toBe(false);
    expect(rows.some((r) => r.billingPeriod === '2026-04-01')).toBe(false);
    expect(rows.map(key).sort()).toEqual((await groundTruth(C.tenantId)).map(key).sort());
    const truth = await publishedTotals(db.pool, C.tenantId, C.sourceId);
    expect(pages[0].totals).toEqual(
      Object.entries(truth).map(([p, t]) => ({ billingPeriod: p, billingCurrency: 'USD', rowCount: String(t.rows), billedCost: t.total })),
    );
    expect(Object.keys(truth)).toEqual(['2026-05-01', '2026-06-01']);
  });
});

describe('D3 money as exact decimal strings', () => {
  it('values round-trip exactly as Postgres numeric text; never a JS number', async () => {
    const { rows, pages } = await all(C.tenantId, { period: '2026-06' });
    const precise = rows.find((r) => r.billedCost === PRECISE);
    expect(precise).toBeDefined();
    expect(precise?.effectiveCost).toBe(PRECISE);
    expect(precise?.usageQuantity).toBe('0.000000000000000001');
    for (const r of rows) {
      expect(typeof r.billedCost).toBe('string');
      expect(r.billedCost).toMatch(/^-?\d+(\.\d+)?$/);
      expect(typeof r.rowOrdinal).toBe('string');
      expect(r.chargePeriodStart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(r.publishedAt).toMatch(/Z$/);
    }
    const sum = await db.pool.query(`SELECT ($1::numeric + 10 * 0.10)::text AS s`, [PRECISE]);
    expect(pages[0].totals).toEqual([{ billingPeriod: '2026-06-01', billingCurrency: 'USD', rowCount: '11', billedCost: sum.rows[0].s }]);
    const may = await getOk(C.tenantId, { period: '2026-05' });
    expect(may.totals?.[0].billedCost).toBe('0.0000000023');
  });
});

describe('D4 keyset pagination', () => {
  it('limit=5 walks every row exactly once, in key order; totals only on the first page', async () => {
    const { rows, pages } = await all(C.tenantId, { limit: '5' });
    expect(rows).toHaveLength(34);
    expect(new Set(rows.map(key)).size).toBe(34);
    expect(pages.map((p) => p.data.length)).toEqual([5, 5, 5, 5, 5, 5, 4]);
    expect(pages.every((p) => p.page.limit === 5)).toBe(true);
    expect(pages[pages.length - 1].page.nextCursor).toBeNull();
    expect(pages[0].totals).not.toBeNull();
    for (const p of pages.slice(1)) expect(p.totals).toBeNull();
    const sortKey = (r: Row) => [r.billingPeriod, r.sourceId, r.artifactSha256, r.rowOrdinal.padStart(20, '0')].join('|');
    const keys = rows.map(sortKey);
    expect(keys).toEqual([...keys].sort());
  });

  it('a page exactly filling the limit has nextCursor only if more rows exist', async () => {
    const all34 = await getOk(C.tenantId, { limit: '34' });
    expect(all34.data).toHaveLength(34);
    expect(all34.page.nextCursor).toBeNull();
    const first33 = await getOk(C.tenantId, { limit: '33' });
    expect(first33.page.nextCursor).not.toBeNull();
    const rest = await getOk(C.tenantId, { limit: '33', cursor: first33.page.nextCursor as string });
    expect(rest.data).toHaveLength(1);
    expect(rest.page.nextCursor).toBeNull();
  });

  it('bounds: limit 1 and 500 work; default is 100; 0 and 501 are refused', async () => {
    expect((await getOk(C.tenantId, { limit: '1' })).data).toHaveLength(1);
    expect((await getOk(C.tenantId, { limit: '500' })).data).toHaveLength(34);
    expect((await getOk(C.tenantId)).page.limit).toBe(100);
    for (const limit of ['0', '501']) expect((await get(C.tenantId, { limit })).statusCode).toBe(400);
  });
});

describe('D5 period filter', () => {
  it('period, from and to select whole billing months', async () => {
    const may = await all(C.tenantId, { period: '2026-05' });
    expect(may.rows).toHaveLength(23);
    expect(new Set(may.rows.map((r) => r.billingPeriod))).toEqual(new Set(['2026-05-01']));
    expect((await all(C.tenantId, { from: '2026-06' })).rows).toHaveLength(11);
    expect((await all(C.tenantId, { to: '2026-05' })).rows).toHaveLength(23);
    expect((await all(C.tenantId, { from: '2026-05', to: '2026-06' })).rows).toHaveLength(34);
    expect(await getOk(C.tenantId, { period: '2026-04' })).toEqual({ data: [], page: { limit: 100, nextCursor: null }, totals: [] });
  });
});

describe('D6 the reader-login safety check refuses unsafe logins (503, nothing served)', () => {
  async function refused(readerUrl: string) {
    const res = await get(seeded.a.tenantId, {}, { readerUrl });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: { code: 'unsafe_db_login', message: ROUTE_MESSAGES.unsafeLogin, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    expect(res.headers['x-request-id']).toBe((res.body as { error: { requestId: string } }).error.requestId);
    expect(JSON.stringify(res.body)).not.toMatch(/ratio_|postgres|superuser/i);
    return res;
  }

  it('a plain ratio_reader login is accepted (control)', async () => {
    expect((await get(seeded.a.tenantId)).statusCode).toBe(200);
  });

  it('the superuser connection is refused', async () => {
    await refused(db.url);
  });

  it('a member of ratio_owner is refused (could disable RLS)', async () => {
    await refused((await login(['ratio_reader', 'ratio_owner'])).url);
  });

  it('a ratio_worker login is refused (not a reader; could write)', async () => {
    await refused(worker.url);
  });

  it('a reader that is also a ratio_worker member is refused', async () => {
    await refused((await login(['ratio_reader', 'ratio_worker'])).url);
  });

  it('a reader that can only SET ROLE ratio_worker (no inherit) is refused', async () => {
    const l = await login([]);
    await db.pool.query(`GRANT ratio_reader TO ${l.name}`);
    await db.pool.query(`GRANT ratio_worker TO ${l.name} WITH INHERIT FALSE, SET TRUE`);
    await refused(l.url);
  });

  it('a login with no ratio membership is refused', async () => {
    await refused((await login([])).url);
  });

  it('a reader holding ratio_reader only through SET (no inherited privileges) is refused', async () => {
    const l = await login([]);
    await db.pool.query(`GRANT ratio_reader TO ${l.name} WITH INHERIT FALSE, SET TRUE`);
    await refused(l.url);
  });

  it('N3: a login DROPPED while its session is pooled is never served (Postgres errors on the dead role OID ⇒ 500, no data)', async () => {
    const l = await login(['ratio_reader']);
    expect((await get(seeded.a.tenantId, {}, { readerUrl: l.url })).statusCode).toBe(200);
    await db.pool.query(`DROP ROLE ${l.name}`);
    const res = await get(seeded.a.tenantId, {}, { readerUrl: l.url });
    expect([500, 503]).toContain(res.statusCode);
    expect(JSON.stringify(res.body)).not.toContain('billedCost');
  });

  it('the check runs on every request: a login made unsafe while pooled is refused at once, and served again when fixed', async () => {
    const l = await login(['ratio_reader']);
    expect((await get(seeded.a.tenantId, {}, { readerUrl: l.url })).statusCode).toBe(200);
    await db.pool.query(`GRANT ratio_worker TO ${l.name}`);
    await refused(l.url);
    await db.pool.query(`REVOKE ratio_worker FROM ${l.name}`);
    expect((await get(seeded.a.tenantId, {}, { readerUrl: l.url })).statusCode).toBe(200);
  });

  it('the reason is logged for the operator as a distinct unsafe_db_login event (codes, no role names), never returned', async () => {
    const lines: string[] = [];
    for (const f of ['error', 'warn'] as const) {
      vi.mocked(console[f]).mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
    }
    const owner = await login(['ratio_reader', 'ratio_owner']);
    const res1 = await refused(db.url);
    const res2 = await refused(owner.url);
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.filter((e) => e.event === 'unhandled_error')).toEqual([]);
    const ev = events.filter((e) => e.event === 'unsafe_db_login');
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({ status: 503, requestId: (res1.body as { error: { requestId: string } }).error.requestId });
    expect(ev[0].reasons).toContain('SUPERUSER');
    expect(ev[1]).toMatchObject({ status: 503, requestId: (res2.body as { error: { requestId: string } }).error.requestId, reasons: ['OWNER_MEMBER'] });
    const text = lines.join('\n');
    expect(text).not.toContain(owner.name);
    expect(text).not.toMatch(/ratio_owner|ratio_reader|ratio_worker|postgres:/);
  });

  it('a pooled login set NOLOGIN is refused on the very next request (pooled sessions survive NOLOGIN); LOGIN again ⇒ served', async () => {
    const l = await login(['ratio_reader']);
    expect((await get(seeded.a.tenantId, {}, { readerUrl: l.url })).statusCode).toBe(200);
    await db.pool.query(`ALTER ROLE ${l.name} NOLOGIN`);
    // The pooled session is still connected: Postgres does not end it on NOLOGIN.
    const alive = await db.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1`, [l.name]);
    expect(alive.rows[0].n).toBeGreaterThan(0);
    await refused(l.url);
    await db.pool.query(`ALTER ROLE ${l.name} LOGIN`);
    expect((await get(seeded.a.tenantId, {}, { readerUrl: l.url })).statusCode).toBe(200);
  });
});

describe('D8 page 1 data and totals come from ONE snapshot (REPEATABLE READ READ ONLY)', () => {
  it('a publish committed between the page query and the totals query cannot make them disagree', async () => {
    const s = await seedTenantSource(db.pool, { sourceKey: 'snap' });
    const source = new FakeFocusSource([{ billingPeriod: '2026-03-01', artifacts: [{ name: 'mar/a.csv.gz', bytes: csvGz(rowsOf('2026-03-01', 5, '1.00', 'old')) }] }]);
    const pool = createWorkerPool(worker.url, { max: 2 });
    const evidence = new MemoryEvidenceStore();
    try {
      await runSync({ pool, tenantId: s.tenantId, sourceKey: 'snap', source, evidence, mode: 'sync' });
      let republished = false;
      // Test-only seam (module level, refused outside vitest): not a parameter of the public read.
      setAfterPageHookForTests(async () => {
        // A restatement is published and COMMITTED while the read transaction is open.
        source.setPeriods([{ billingPeriod: '2026-03-01', artifacts: [{ name: 'mar/b.csv.gz', bytes: csvGz(rowsOf('2026-03-01', 7, '2.00', 'new')) }] }]);
        const r = await runSync({ pool, tenantId: s.tenantId, sourceKey: 'snap', source, evidence, mode: 'sync' });
        republished = r.periods[0].outcome === 'published';
      });
      let page!: Awaited<ReturnType<typeof readPublishedCosts>>;
      try {
        page = await readPublishedCosts(readerPool(reader.url), s.tenantId, { from: null, to: null, limit: 100, cursor: null });
      } finally {
        setAfterPageHookForTests(null);
      }
      expect(republished).toBe(true);
      expect(page.data).toHaveLength(5);
      expect(page.totals).toEqual([{ billingPeriod: '2026-03-01', billingCurrency: 'USD', rowCount: '5', billedCost: '5.00' }]);
      expect(new Set(page.data.map((r) => r.batchId)).size).toBe(1);
      // A fresh read sees the restatement, consistently.
      const after = await readPublishedCosts(readerPool(reader.url), s.tenantId, { from: null, to: null, limit: 100, cursor: null });
      expect(after.data).toHaveLength(7);
      expect(after.totals).toEqual([{ billingPeriod: '2026-03-01', billingCurrency: 'USD', rowCount: '7', billedCost: '14.00' }]);
    } finally {
      await pool.end();
    }
  });

  it('fails closed on a pool that does not start transactions at REPEATABLE READ (no silent READ COMMITTED read)', async () => {
    const plain = new Pool({ connectionString: reader.url, max: 1 });
    plain.on('error', () => undefined);
    try {
      await expect(readPublishedCosts(plain, seeded.a.tenantId, { from: null, to: null, limit: 10, cursor: null })).rejects.toThrow(/REPEATABLE READ READ ONLY/);
    } finally {
      await plain.end();
    }
  });

  it('the read transaction runs at REPEATABLE READ, read only', async () => {
    const c = await readerPool(reader.url).connect();
    try {
      await c.query('BEGIN');
      const r = await c.query(`SELECT current_setting('transaction_isolation') AS iso, current_setting('transaction_read_only') AS ro`);
      expect(r.rows[0]).toEqual({ iso: 'repeatable read', ro: 'on' });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

describe('D9 keyset tie-break on source_id (two sources, identical artifacts, one period)', () => {
  it('limit 3 visits every row of both sources exactly once', async () => {
    const tenantId = crypto.randomUUID();
    const bytes = csvGz(rowsOf('2026-02-01', 5, '0.50', 'twin'));
    const pool = createWorkerPool(worker.url, { max: 2 });
    try {
      for (const sourceKey of ['twin-a', 'twin-b']) {
        await seedTenantSource(db.pool, { tenantId, sourceKey });
        const source = new FakeFocusSource([{ billingPeriod: '2026-02-01', artifacts: [{ name: 'feb/a.csv.gz', bytes }] }]);
        await runSync({ pool, tenantId, sourceKey, source, evidence: new MemoryEvidenceStore(), mode: 'sync' });
      }
    } finally {
      await pool.end();
    }
    const { rows } = await all(tenantId, { limit: '3' });
    expect(rows).toHaveLength(10);
    // Same artifact sha256 and ordinals in both sources: only source_id tells the rows apart.
    expect(new Set(rows.map((r) => r.artifactSha256)).size).toBe(1);
    expect(new Set(rows.map((r) => `${r.sourceId}/${r.rowOrdinal}`)).size).toBe(10);
    expect(new Set(rows.map((r) => r.sourceId)).size).toBe(2);
    const keys = rows.map((r) => `${r.sourceId}|${r.rowOrdinal.padStart(20, '0')}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('D7 reader session settings', () => {
  it('the reader pool pins search_path, read-only transactions and a statement timeout', async () => {
    const pool = readerPool(reader.url);
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT current_setting('search_path') AS sp, current_setting('default_transaction_read_only') AS ro,
                current_setting('statement_timeout') AS st, current_setting('TimeZone') AS tz,
                current_setting('DateStyle') AS ds, current_setting('IntervalStyle') AS ist`,
      );
      // A startup-option value is reported as given (no space after the comma);
      // DateStyle is canonicalised by the server.
      expect(r.rows[0]).toEqual({ sp: 'pg_catalog,pg_temp', ro: 'on', st: '10s', tz: 'UTC', ds: 'ISO, MDY', ist: 'postgres' });
    } finally {
      c.release();
    }
    expect(readerPool(reader.url)).toBe(pool);
  });
});

// --- Copilot 4176238982: the output may not depend on any session setting ------
// date::text follows DateStyle; a cursor built from such a value no longer
// decodes. Two layers, each tested on its own: the SQL formats every date and
// timestamp explicitly (D10b), and the pool pins DateStyle / IntervalStyle /
// TimeZone and the read asserts them, failing closed (D10a, D10c).
describe('D10 output never depends on session settings (Copilot 4176238982)', () => {
  const HOSTILE_ROLE_DEFAULTS: Array<[string, string]> = [
    ['DateStyle', 'SQL, DMY'],
    ['TimeZone', 'America/Sao_Paulo'],
    ['IntervalStyle', 'sql_standard'],
    ['extra_float_digits', '-15'],
  ];
  const PERIOD = /^\d{4}-(0[1-9]|1[0-2])-01$/;
  const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

  async function hostileLogin(): Promise<Login> {
    const l = await login(['ratio_reader']);
    for (const [k, v] of HOSTILE_ROLE_DEFAULTS) await db.pool.query(`ALTER ROLE ${l.name} SET ${k} = '${v}'`);
    return l;
  }

  async function walk(readerUrl: string): Promise<{ rows: Row[]; pages: Body[] }> {
    const pages: Body[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i += 1) {
      const body = await getOk(C.tenantId, cursor ? { limit: '5', cursor } : { limit: '5' }, { readerUrl });
      pages.push(body);
      cursor = body.page.nextCursor;
      if (!cursor) break;
    }
    return { rows: pages.flatMap((p) => p.data), pages };
  }

  it('D10a a reader login whose ROLE defaults are DateStyle=SQL,DMY, a non-UTC TimeZone, sql_standard intervals and extra_float_digits=-15 gets canonical output, and paging through nextCursor returns every row exactly once', async () => {
    const odd = await hostileLogin();
    // The role defaults are real: a plain session of this login sees them.
    const plain = new Pool({ connectionString: odd.url, max: 1 });
    try {
      const s = await plain.query(`SELECT current_setting('DateStyle') AS ds, current_setting('TimeZone') AS tz, (DATE '2026-05-01')::text AS d`);
      expect(s.rows[0]).toEqual({ ds: 'SQL, DMY', tz: 'America/Sao_Paulo', d: '01/05/2026' });
    } finally {
      await plain.end();
    }
    const canonical = await walk(reader.url);
    const hostile = await walk(odd.url);
    expect(hostile.rows).toHaveLength(34);
    expect(new Set(hostile.rows.map(key)).size).toBe(34);
    expect(hostile.rows.map(key).sort()).toEqual((await groundTruth(C.tenantId)).map(key).sort());
    expect(hostile.pages.map((p) => p.data.length)).toEqual([5, 5, 5, 5, 5, 5, 4]);
    expect(hostile.rows).toEqual(canonical.rows);
    expect(hostile.pages[0].totals).toEqual(canonical.pages[0].totals);
    for (const r of hostile.rows) {
      expect(r.billingPeriod).toMatch(PERIOD);
      expect(r.chargePeriodStart).toMatch(TS);
      expect(r.publishedAt).toMatch(TS);
    }
    for (const t of hostile.pages[0].totals ?? []) {
      expect(t.billingPeriod).toMatch(PERIOD);
      expect(typeof t.rowCount).toBe('string');
    }
  });

  it('D10b the SQL alone is setting-independent: under hostile SET LOCAL values every column of the page and the totals equals the canonical output', async () => {
    // A plain pool: none of the reader pool's pinned options.
    const plain = new Pool({ connectionString: reader.url, max: 1 });
    try {
      const run = (sets: Array<[string, string]>) =>
        withTenantTransaction(plain, C.tenantId, async (c) => {
          for (const [k, v] of sets) await c.query(`SELECT pg_catalog.set_config($1, $2, true)`, [k, v]);
          const page = await c.query(PUBLISHED_COSTS_SQL.page, [null, null, null, null, null, null, 1000]);
          const totals = await c.query(PUBLISHED_COSTS_SQL.totals, [null, null]);
          return { page: page.rows, totals: totals.rows };
        });
      const base = await run([
        ['DateStyle', 'ISO, MDY'],
        ['TimeZone', 'UTC'],
        ['IntervalStyle', 'postgres'],
        ['extra_float_digits', '1'],
      ]);
      expect(base.page).toHaveLength(34);
      for (const r of base.page) expect(r.billingPeriod).toMatch(PERIOD);
      for (const style of ['SQL, DMY', 'German', 'Postgres, DMY', 'SQL, MDY']) {
        const r = await run([
          ['DateStyle', style],
          ['TimeZone', 'Pacific/Chatham'],
          ['IntervalStyle', 'iso_8601'],
          ['extra_float_digits', '-15'],
        ]);
        expect(r, style).toEqual(base);
      }
    } finally {
      await plain.end();
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
      await expect(readPublishedCosts(unpinned, C.tenantId, { from: null, to: null, limit: 5, cursor: null })).rejects.toThrow(/published-costs read requires/);
    } finally {
      await unpinned.end();
    }
  });
});

// The reader API's client-side deadlines (Copilot 4176494809). statement_timeout
// is server-side: a stalled connection or a lost response would otherwise hold
// one of the pool's 4 slots forever. Every query has a client-side
// query_timeout slightly above statement_timeout, connecting is bounded, and
// the whole request (tenant transaction, login check, reads) has a deadline.
// A client that timed out, failed at the connection level, or outlived the
// request deadline is DESTROYED (release(err)), never returned to the pool.
import net from 'net';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { READ_TIMEOUTS, readWithDeadline } from './readDeadline';
import { READER_SESSION_OPTIONS, createReaderPool, readerPoolConfig } from './readerPool';
import { createPublishedCostsRoute } from './publishedCostsRoute';
import { bearer, call, makeReq, TEST_API_TOKEN } from './testing/http';

const TENANT = '11111111-1111-4111-8111-111111111111';

/** A fake pg client: `query` is the given implementation; release and the socket are spies. */
function fakeClient(query: (sql: string) => Promise<unknown>) {
  const destroy = vi.fn();
  return { query: vi.fn(query), release: vi.fn(), connection: { stream: { destroy } }, destroy };
}
const poolOf = (client: ReturnType<typeof fakeClient>) => ({ connect: vi.fn(async () => client) }) as unknown as Pick<Pool, 'connect'>;
const never = () => new Promise<never>(() => undefined);

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('RD1 the reader pool has client-side deadlines', () => {
  it('query_timeout slightly above the server statement_timeout, a connect timeout, and a request deadline above both', () => {
    const statementMs = Number(/statement_timeout=(\d+)/.exec(READER_SESSION_OPTIONS)![1]);
    const cfg = readerPoolConfig('postgres://reader@127.0.0.1:1/ratio');
    expect(cfg.query_timeout).toBe(READ_TIMEOUTS.queryMs);
    expect(cfg.query_timeout!).toBeGreaterThan(statementMs);
    expect(cfg.query_timeout!).toBeLessThanOrEqual(statementMs + 5_000);
    expect(cfg.connectionTimeoutMillis).toBe(READ_TIMEOUTS.connectMs);
    expect(cfg.max).toBe(4);
    expect(cfg.options).toBe(READER_SESSION_OPTIONS);
    expect(READ_TIMEOUTS.requestMs).toBeGreaterThan(READ_TIMEOUTS.queryMs);
  });
});

describe('RD2 readWithDeadline: a stuck or timed-out client is destroyed, never returned', () => {
  it('a query that never answers: rejects at the request deadline and destroys the client (release with an error, socket destroyed)', async () => {
    const c = fakeClient(never);
    const t0 = Date.now();
    await expect(readWithDeadline(poolOf(c), async (p) => {
      const client = await p.connect();
      try {
        return await client.query('SELECT 1');
      } finally {
        client.release();
      }
    }, 200)).rejects.toThrow(/deadline/);
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(c.release).toHaveBeenCalledTimes(1);
    expect(c.release.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(c.destroy).toHaveBeenCalled();
  });

  it("a client-side query timeout poisons the client: later queries (the ROLLBACK) fail at once without reaching it, and release passes the error", async () => {
    const c = fakeClient(async () => {
      throw new Error('Query read timeout');
    });
    await expect(readWithDeadline(poolOf(c), async (p) => {
      const client = await p.connect();
      try {
        await client.query('SELECT 1').catch(async (e) => {
          await client.query('ROLLBACK').catch(() => undefined);
          throw e;
        });
      } finally {
        client.release();
      }
    }, 5_000)).rejects.toThrow(/Query read timeout/);
    expect(c.query).toHaveBeenCalledTimes(1); // the ROLLBACK never reached the poisoned client
    expect(c.release).toHaveBeenCalledTimes(1);
    expect(c.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('a healthy read releases normally (no error); a second release is a no-op', async () => {
    const c = fakeClient(async () => ({ rows: [{ ok: 1 }] }));
    const r = await readWithDeadline(poolOf(c), async (p) => {
      const client = await p.connect();
      const out = await client.query('SELECT 1');
      client.release();
      client.release();
      return out;
    }, 5_000);
    expect(r).toEqual({ rows: [{ ok: 1 }] });
    expect(c.release).toHaveBeenCalledTimes(1);
    expect(c.release.mock.calls[0][0]).toBeUndefined();
  });
});

describe('RD3 the route answers within its deadline when Postgres stalls', () => {
  const servers: net.Server[] = [];
  const sockets = new Set<net.Socket>();
  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(undefined)))));
  });
  async function stalledPostgres(): Promise<number> {
    const srv = net.createServer((s) => {
      sockets.add(s);
      s.on('error', () => undefined);
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    return (srv.address() as net.AddressInfo).port;
  }

  it('a fake Postgres that accepts the connection and never answers ⇒ 500 within the connect deadline (the real reader pool)', async () => {
    const port = await stalledPostgres();
    const url = `postgres://reader:pw@127.0.0.1:${port}/ratio`;
    const pool = createReaderPool(url, { connectionTimeoutMillis: 300 });
    try {
      const route = createPublishedCostsRoute({ env: { RATIO_API_TOKEN: TEST_API_TOKEN, RATIO_API_TENANT_ID: TENANT, RATIO_READER_DATABASE_URL: url }, poolFor: () => pool, logger: () => undefined });
      const t0 = Date.now();
      const res = await call(route, makeReq({ headers: bearer(), remoteAddress: '10.88.0.1' }));
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(res.statusCode).toBe(500);
      expect(pool.totalCount).toBe(0);
    } finally {
      await pool.end();
    }
  }, 10_000);

  it('a connection that stalls mid-request ⇒ 500 at the request deadline, and the client is destroyed', async () => {
    const c = fakeClient(never);
    const route = createPublishedCostsRoute({
      env: { RATIO_API_TOKEN: TEST_API_TOKEN, RATIO_API_TENANT_ID: TENANT, RATIO_READER_DATABASE_URL: 'postgres://reader@127.0.0.1:1/ratio' },
      poolFor: () => poolOf(c),
      logger: () => undefined,
      requestDeadlineMs: 300,
    });
    const t0 = Date.now();
    const res = await call(route, makeReq({ headers: bearer(), remoteAddress: '10.88.0.2' }));
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(res.statusCode).toBe(500);
    expect(c.release).toHaveBeenCalledTimes(1);
    expect(c.release.mock.calls[0][0]).toBeInstanceOf(Error);
  }, 10_000);
});

// The reader API's client-side deadlines (Copilot 4176494809). statement_timeout
// is server-side: a stalled connection or a lost response would otherwise hold
// one of the pool's 4 slots forever. Every query has a client-side
// query_timeout slightly above statement_timeout, connecting is bounded, and
// the whole request (tenant transaction, login check, reads) has a deadline.
// A client that timed out, failed at the connection level, or outlived the
// request deadline is DESTROYED (release(err)), never returned to the pool.
import { EventEmitter } from 'events';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseError, type Pool } from 'pg';
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

// --- challenger Medium on 480dd87: guard() added an 'error' listener on EVERY
// checkout and never removed it; a pooled client is never retired under steady
// traffic, so the listeners grew without bound (MaxListenersExceededWarning).
describe('RD4 the stray-error listener is attached once per client, not per request', () => {
  it('50 reads on one pooled client leave exactly one guard listener', async () => {
    const client = Object.assign(new EventEmitter(), { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() });
    const pool = { connect: vi.fn(async () => client) } as unknown as Pick<Pool, 'connect'>;
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on('warning', onWarning);
    try {
      for (let i = 0; i < 50; i += 1) {
        await readWithDeadline(pool, async (p) => {
          const c = await p.connect();
          await c.query('SELECT 1');
          c.release();
        }, 5_000);
      }
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off('warning', onWarning);
    }
    expect(client.listenerCount('error')).toBe(1);
    expect(client.release).toHaveBeenCalledTimes(50);
    expect(warnings).not.toContain('MaxListenersExceededWarning');
  });
});

// --- Copilot 4176969214: a server SQL error is classified POSITIVELY (a pg
// DatabaseError that leaves the session usable). Anything else poisons and
// destroys the client: a Node system error such as EPIPE has a 5-letter
// uppercase code too, and is NOT a SQLSTATE.
describe('RD5 only a real, session-preserving SQL error keeps a client; everything else poisons it (Copilot 4176969214)', () => {
  /** A Node system error, as net/stream raise them (code, errno, syscall). */
  const sysErr = (code: string, errno: number, syscall = 'write') => Object.assign(new Error(`${syscall} ${code}`), { code, errno, syscall });
  /** A real pg-protocol DatabaseError, as the parser builds it. */
  const dbErr = (code: string, severity = 'ERROR') => Object.assign(new DatabaseError(`server says ${code}`, 0, 'error'), { code, severity });

  /** One read whose first query fails with `err`; the catch path then sends a ROLLBACK, as withTenantTransaction does. */
  async function readFailingWith(err: unknown) {
    const c = fakeClient(async (sql) => {
      if (sql === 'ROLLBACK') return {};
      throw err;
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
    }, 5_000)).rejects.toBe(err);
    return c;
  }

  it.each([
    ['EPIPE (system error)', sysErr('EPIPE', -32)],
    ['ECONNRESET (system error)', sysErr('ECONNRESET', -104, 'read')],
    ['ETIMEDOUT (system error)', sysErr('ETIMEDOUT', -110, 'connect')],
    ['EIO (system error)', sysErr('EIO', -5, 'read')],
    ['a bare Error (no code)', new Error('boom')],
    ['a pg query_timeout error', new Error('Query read timeout')],
    ['"Connection terminated unexpectedly"', new Error('Connection terminated unexpectedly')],
    ['a plain object with a SQLSTATE-shaped code (not a DatabaseError)', Object.assign(new Error('looks like SQL'), { code: '42P01' })],
    ['a look-alike with severity ERROR and a SQLSTATE that is not a DatabaseError', Object.assign(new Error('fake server error'), { severity: 'ERROR', code: '42P01' })],
    ['a DatabaseError with severity FATAL (57P01, pg_terminate_backend)', dbErr('57P01', 'FATAL')],
    ['a DatabaseError of class 08 (connection exception)', dbErr('08006')],
    ['a DatabaseError 57P01 even if severity says ERROR', dbErr('57P01')],
    ['a DatabaseError with a localized or missing severity', dbErr('42P01', 'FEHLER')],
    ['a DatabaseError that also carries errno/syscall', Object.assign(dbErr('42P01'), { errno: -32, syscall: 'write' })],
  ])('%s poisons the client: the ROLLBACK never reaches it, release gets the error, the socket is destroyed', async (_name, err) => {
    const c = await readFailingWith(err);
    expect(c.query).toHaveBeenCalledTimes(1);
    expect(c.release).toHaveBeenCalledTimes(1);
    expect(c.release.mock.calls[0][0]).toBe(err);
    expect(c.destroy).toHaveBeenCalled();
  });

  it.each([
    ['42P01 undefined_table', '42P01'],
    ['57014 query_canceled (statement_timeout)', '57014'],
    ['42501 insufficient_privilege', '42501'],
    ['40001 serialization_failure', '40001'],
  ])('a real DatabaseError %s (severity ERROR) keeps the client: the ROLLBACK reaches it, release without an error, socket intact', async (_name, code) => {
    const c = await readFailingWith(dbErr(code));
    expect(c.query).toHaveBeenCalledTimes(2);
    expect(c.query.mock.calls[1][0]).toBe('ROLLBACK');
    expect(c.release).toHaveBeenCalledTimes(1);
    expect(c.release.mock.calls[0][0]).toBeUndefined();
    expect(c.destroy).not.toHaveBeenCalled();
  });

  it('the classifier is positive: it uses pg\'s DatabaseError and the severity, not a code-shape regex alone', () => {
    const src = fs.readFileSync(path.join(__dirname, 'readDeadline.ts'), 'utf8');
    expect(src).toMatch(/import \{[^}]*\bDatabaseError\b[^}]*\} from 'pg'/);
    expect(src).toMatch(/instanceof DatabaseError/);
    expect(src).toMatch(/severity === 'ERROR'/);
  });
});

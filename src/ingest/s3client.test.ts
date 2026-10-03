// Challenger M-1: S3 requests must time out. A server that accepts the
// connection but never answers must not hang the worker.
import net from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeS3Client } from './s3client';
import { loadWorkerConfig } from './config';
import { S3FocusExportSource } from './sources/s3/S3FocusExportSource';

let server: net.Server;
let port = 0;
const sockets = new Set<net.Socket>();
beforeAll(async () => {
  server = net.createServer((s) => {
    sockets.add(s); // accept, read, never respond
    s.on('data', () => undefined);
    s.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('S3 client timeouts', () => {
  it('config exposes request/connect timeouts with defaults and bounds', () => {
    const base = { RATIO_DATABASE_URL: 'postgres://w@h/db' };
    const c = loadWorkerConfig(base);
    expect(c.sourceS3.requestTimeoutMs).toBe(60_000);
    expect(c.sourceS3.connectTimeoutMs).toBe(10_000);
    expect(loadWorkerConfig({ ...base, RATIO_S3_REQUEST_TIMEOUT_MS: '1500' }).evidenceS3.requestTimeoutMs).toBe(1500);
    expect(() => loadWorkerConfig({ ...base, RATIO_S3_REQUEST_TIMEOUT_MS: '0' })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('a request to a server that never answers fails within the configured timeout', async () => {
    const cfg = loadWorkerConfig({
      RATIO_DATABASE_URL: 'postgres://w@h/db',
      RATIO_SOURCE_S3_ENDPOINT: `http://127.0.0.1:${port}`,
      RATIO_SOURCE_S3_ACCESS_KEY_ID: 'a',
      RATIO_SOURCE_S3_SECRET_ACCESS_KEY: 'b',
      RATIO_S3_REQUEST_TIMEOUT_MS: '500',
    });
    const client = makeS3Client(cfg.sourceS3);
    const src = new S3FocusExportSource({ client, location: { bucket: 'stall-bucket', prefix: 'p', exportName: 'e' } });
    const start = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      src.listPeriods().then(
        () => 'resolved',
        (e: { code?: string }) => e.code ?? 'error',
      ),
      new Promise<string>((r) => (timer = setTimeout(() => r('still hanging after 4 s'), 4_000))),
    ]);
    clearTimeout(timer);
    client.destroy();
    expect(outcome).toBe('SOURCE_LIST_FAILED');
    expect(Date.now() - start).toBeLessThan(4_000);
  });
});

// PR #54 second Copilot review, M3 against a REAL S3 client (AWS SDK) and a
// real HTTP server that paginates forever: MAX_RUN_SECONDS bounds the source
// listing.
//   - in-process: the request in flight at the deadline is one the server
//     never answers; the abort signal must tear it down (the server sees the
//     connection close unanswered) and the run fails MAX_RUN_EXCEEDED;
//   - the worker CLI as a real OS process: at the deadline the run fails and
//     the PROCESS EXITS on its own (nothing keeps paginating, no request is
//     left holding the event loop).
import http from 'http';
import type { AddressInfo } from 'net';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing/harness';
import { createWorkerPool } from './db';
import { runSync } from './pipeline';
import { S3FocusExportSource } from '../sources/s3/S3FocusExportSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { createLogin, runsOf, seedTenantSource, type Login } from '../testing/db';
import { createTestBucket, requireTestS3Endpoint, testS3Env, type TestBucket } from '../testing/s3';
import { noSleep } from '../testing/workerSetup';
import type { Pool } from 'pg';

// Fail the whole file at collection time (not "skipped" tests) when no S3 endpoint is configured.
requireTestS3Endpoint();
import { spawnCli } from '../testing/cli';

let db: TestDatabase;
let worker: Login;
let workerPool: Pool;
let evidence: TestBucket;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  worker = await createLogin(db, ['ratio_worker']);
  workerPool = createWorkerPool(worker.url, { max: 4 });
  evidence = await createTestBucket('maxrun');
});
afterAll(async () => {
  await workerPool?.end();
  await evidence?.destroy();
  await worker?.drop();
  await db?.close();
});

const LOCATION = { bucket: 'endless', prefix: 'exports', exportName: 'focus' };

/** An S3 endpoint whose ListObjectsV2 is always truncated; after `hangAfter` requests it stops answering. */
async function endlessS3(opts: { delayMs: number; hangAfter?: number }) {
  const state = { requests: 0, answered: 0, abortedUnanswered: 0 };
  const server = http.createServer((_req, res) => {
    const n = ++state.requests;
    res.on('close', () => {
      if (!res.writableFinished) state.abortedUnanswered++;
    });
    if (opts.hangAfter !== undefined && n > opts.hangAfter) return; // never answered
    const timer = setTimeout(() => {
      if (res.destroyed) return;
      state.answered++;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
          `<Name>${LOCATION.bucket}</Name><Prefix></Prefix><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys>` +
          `<IsTruncated>true</IsTruncated><NextContinuationToken>page-${n}</NextContinuationToken></ListBucketResult>`,
      );
    }, opts.delayMs);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    state,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('M3: MAX_RUN_SECONDS bounds a real S3 listing', () => {
  it('in-process: the request in flight at the deadline is torn down, the run fails MAX_RUN_EXCEEDED, nothing is sent afterwards', async () => {
    const s3 = await endlessS3({ delayMs: 20, hangAfter: 5 });
    const client = new S3Client({
      endpoint: s3.url,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1,
    });
    try {
      const s = await seedTenantSource(db.pool, { kind: 'focus_file', config: { layout: 'aws-data-exports', ...LOCATION } });
      const started = Date.now();
      const r = await runSync({
        pool: workerPool,
        tenantId: s.tenantId,
        sourceKey: s.sourceKey,
        source: new S3FocusExportSource({ client, location: LOCATION }),
        evidence: new MemoryEvidenceStore(),
        mode: 'sync',
        settings: { maxRunSeconds: 1 },
        hooks: noSleep,
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(r).toMatchObject({ status: 'failed', errorCode: 'MAX_RUN_EXCEEDED' });
      expect((await runsOf(db.pool, s.tenantId, s.sourceId))[0]).toMatchObject({ status: 'failed', error_code: 'MAX_RUN_EXCEEDED' });
      // The server learns of the teardown asynchronously (the socket closes): give it a moment to observe it.
      for (let i = 0; i < 50 && s3.state.abortedUnanswered === 0; i++) await settle(20);
      expect(s3.state.requests).toBe(6); // 5 answered pages + the one that never got an answer
      expect(s3.state.abortedUnanswered).toBe(1); // ...torn down by the abort, not left open
      await settle(300);
      expect(s3.state.requests).toBe(6);
    } finally {
      client.destroy();
      await s3.close();
    }
  });

  // RATIO_MAX_RUN_SECONDS has a configured floor of 60 s (a production guard,
  // not lowered for tests), so this test needs a minute of wall time: its
  // timeout is the 60 s deadline plus 60 s for start-up and teardown.
  it(
    'the worker CLI process: at RATIO_MAX_RUN_SECONDS the run fails MAX_RUN_EXCEEDED and the process exits on its own',
    async () => {
      const s3 = await endlessS3({ delayMs: 250 });
      try {
        const s = await seedTenantSource(db.pool, { kind: 'focus_file', config: { layout: 'aws-data-exports', ...LOCATION } });
        const started = Date.now();
        const child = spawnCli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], {
          ...testS3Env(evidence),
          RATIO_SOURCE_S3_ENDPOINT: s3.url,
          RATIO_DATABASE_URL: worker.url,
          RATIO_MAX_RUN_SECONDS: '60',
        });
        const exited = await child.exited;
        const elapsed = Date.now() - started;
        expect(exited).toEqual({ code: 1, signal: null });
        expect(elapsed).toBeGreaterThanOrEqual(59_000); // it was the deadline that ended it...
        expect(elapsed).toBeLessThan(100_000); // ...and the process did not hang on after it
        const record = JSON.parse(child.stdout.join('').trim()) as { pass: boolean; results: { status: string; errorCode: string } };
        expect(record.pass).toBe(false);
        expect(record.results).toMatchObject({ status: 'failed', errorCode: 'MAX_RUN_EXCEEDED' });
        expect(s3.state.requests).toBeGreaterThan(10); // it really was paginating all along
        const requests = s3.state.requests;
        await settle(500);
        expect(s3.state.requests).toBe(requests);
        expect((await runsOf(db.pool, s.tenantId, s.sourceId))[0]).toMatchObject({ status: 'failed', error_code: 'MAX_RUN_EXCEEDED' });
      } finally {
        await s3.close();
      }
    },
    120_000,
  );
});

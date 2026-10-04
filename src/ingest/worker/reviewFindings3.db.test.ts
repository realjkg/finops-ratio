// PR #54 third Copilot review (f22f1f6), worker side:
//   H2  `replay --period 9999-12` terminates (no string-compare period loop);
//       ranges are bounded to 2000-01..9999-12 and must not be inverted;
//   M3  opening a source artifact honours the run's abort signal: at
//       MAX_RUN_SECONDS the period fails MAX_RUN_EXCEEDED, not SOURCE_STALLED;
//   M4  doctor fails a source that has never published a period;
//   M5  opening an evidence object honours the run's abort signal: at
//       MAX_RUN_SECONDS the period fails MAX_RUN_EXCEEDED, not EVIDENCE_STALLED.
import crypto from 'crypto';
import type { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import type { ArtifactRef, PeriodListing, PeriodRange } from '../sources/types';
import { runSync, type RunSyncOptions } from './pipeline';
import { runDoctor } from './doctor';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import { batchesOf, publishedTotals, runsOf, seedTenantSource, type SeededSource } from '../testing/db';
import { csvGz, rowsOf } from '../testing/focusCsv';
import { createTestBucket, requireTestS3Endpoint, testS3Env, type TestBucket } from '../testing/s3';

// Fail the whole file at collection time (not "skipped" tests) when no S3 endpoint is configured.
requireTestS3Endpoint();
import { spawnCli } from '../testing/cli';

let t: WorkerTestDb;
let evidenceBucket: TestBucket;
beforeAll(async () => {
  t = await workerTestDb();
  evidenceBucket = await createTestBucket('rf3');
});
afterAll(async () => {
  await evidenceBucket?.destroy();
  await t.close();
});

const P = '2026-07-01';

function sync(s: SeededSource, source: FakeFocusSource, extra: Partial<RunSyncOptions> = {}) {
  return runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source, evidence: new MemoryEvidenceStore(), mode: 'sync', ...extra, hooks: { ...noSleep, ...extra.hooks } });
}

/** Resolves when the signal aborts (rejecting with its reason); never otherwise. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return; // without a signal it never settles
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

describe('H2: period ranges terminate and are bounded', () => {
  it('replay --period 9999-12 (worker CLI process) ends: PERIOD_NOT_FOUND, exit 1, well within the bound', async () => {
    const s = await seedTenantSource(t.db.pool, { kind: 'fake', config: { fixture: 'synthetic-base' } });
    const child = spawnCli(['replay', '--tenant', s.tenantId, '--source', s.sourceKey, '--period', '9999-12'], {
      RATIO_DATABASE_URL: t.login.url,
      ...testS3Env(evidenceBucket),
      NODE_ENV: 'test',
      RATIO_ALLOW_FAKE_SOURCE: '1',
    });
    // The bug is a synchronous endless loop: bound it from here and kill the child if it never ends.
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      child.exited,
      new Promise<'hung'>((resolve) => {
        timer = setTimeout(() => resolve('hung'), 20_000);
      }),
    ]);
    clearTimeout(timer);
    if (outcome === 'hung') child.child.kill('SIGKILL');
    expect(outcome).toEqual({ code: 1, signal: null });
    const record = JSON.parse(child.stdout.join('').trim()) as { results: { periods: Array<{ billingPeriod: string; code: string }> } };
    expect(record.results.periods).toEqual([expect.objectContaining({ billingPeriod: '9999-12-01', code: 'PERIOD_NOT_FOUND' })]);
  });

  it('runSync refuses ranges outside 2000-01..9999-12, malformed or inverted (INVALID_RANGE) before taking a lease', async () => {
    const s = await seedTenantSource(t.db.pool);
    const bad: Array<{ from: string; to: string }> = [
      { from: '1999-12-01', to: '2000-01-01' },
      { from: '9999-12-01', to: '10000-01-01' },
      { from: '10000-01-01', to: '10000-01-01' },
      { from: '2026-08-01', to: '2026-07-01' },
      { from: '2026-07-15', to: '2026-08-01' },
    ];
    for (const range of bad) {
      for (const mode of ['backfill', 'replay_period'] as const) {
        await expect(sync(s, new FakeFocusSource([]), { mode, range }), `${mode} ${JSON.stringify(range)}`).rejects.toMatchObject({ code: 'INVALID_RANGE' });
      }
    }
    expect(await runsOf(t.db.pool, s.tenantId, s.sourceId)).toEqual([]);
  });
});

describe('M3: opening a source artifact is abort-aware', () => {
  class HangingOpen extends FakeFocusSource {
    sawSignal = false;
    async openArtifact(ref: ArtifactRef, opts?: { signal?: AbortSignal }): Promise<Readable> {
      void ref;
      this.sawSignal = !!opts?.signal;
      return untilAborted(opts?.signal);
    }
  }

  it('an open that never answers: at MAX_RUN_SECONDS the period fails MAX_RUN_EXCEEDED (not SOURCE_STALLED)', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new HangingOpen([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 2)) }] }]);
    const started = Date.now();
    const r = await sync(s, source, { settings: { maxRunSeconds: 1, stallTimeoutSeconds: 6 } as RunSyncOptions['settings'] });
    expect(Date.now() - started).toBeLessThan(5_000); // the deadline, not the 6 s stall limit
    expect(source.sawSignal).toBe(true);
    expect(r.status).toBe('failed');
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'MAX_RUN_EXCEEDED' });
  });
});

describe('M3/M5: the open deadline itself is abort-aware (a transport that ignores the signal)', () => {
  const never = () => new Promise<never>(() => undefined);
  class DeafOpen extends FakeFocusSource {
    async openArtifact(): Promise<Readable> {
      return never();
    }
  }
  class DeafEvidenceOpen extends MemoryEvidenceStore {
    async open(): Promise<Readable> {
      return never();
    }
  }
  const settings = { maxRunSeconds: 1, stallTimeoutSeconds: 6 } as RunSyncOptions['settings'];
  const set = [{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 2)) }] }];

  it('source: an open that ignores the signal still fails MAX_RUN_EXCEEDED at the deadline (not SOURCE_STALLED)', async () => {
    const s = await seedTenantSource(t.db.pool);
    const started = Date.now();
    const r = await sync(s, new DeafOpen(set), { settings });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'MAX_RUN_EXCEEDED' });
  });

  it('evidence: an open that ignores the signal still fails MAX_RUN_EXCEEDED at the deadline (not EVIDENCE_STALLED)', async () => {
    const s = await seedTenantSource(t.db.pool);
    const started = Date.now();
    const r = await runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source: new FakeFocusSource(set), evidence: new DeafEvidenceOpen(), mode: 'sync', settings, hooks: noSleep });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'MAX_RUN_EXCEEDED' });
  });
});

describe('M5: opening an evidence object is abort-aware', () => {
  class HangingEvidenceOpen extends MemoryEvidenceStore {
    sawSignal = false;
    async open(key: string, opts?: { signal?: AbortSignal }): Promise<Readable> {
      void key;
      this.sawSignal = !!opts?.signal;
      return untilAborted(opts?.signal);
    }
  }

  it('an evidence open that never answers: at MAX_RUN_SECONDS the period fails MAX_RUN_EXCEEDED (not EVIDENCE_STALLED)', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 2)) }] }]);
    const evidence = new HangingEvidenceOpen();
    const started = Date.now();
    const r = await runSync({
      pool: t.pool,
      tenantId: s.tenantId,
      sourceKey: s.sourceKey,
      source,
      evidence,
      mode: 'sync',
      settings: { maxRunSeconds: 1, stallTimeoutSeconds: 6 } as RunSyncOptions['settings'],
      hooks: noSleep,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(evidence.sawSignal).toBe(true);
    expect(r.status).toBe('failed');
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'MAX_RUN_EXCEEDED' });
  });
});

describe('M4: doctor fails a source that has never published a period', () => {
  it('a successful run that published nothing: NEVER_PUBLISHED; after a publication the source passes', async () => {
    const s = await seedTenantSource(t.db.pool);
    expect((await sync(s, new FakeFocusSource([]))).status).toBe('succeeded');
    // Past the first-publication grace window (challenger L2; default 48 h).
    await t.db.pool.query(`UPDATE ratio.sources SET created_at = now() - interval '49 hours' WHERE id = $1`, [s.sourceId]);
    const name = `source:${s.tenantId}/${s.sourceKey}`;
    const before = await runDoctor({ workerUrl: t.login.url, migrateUrl: t.db.url, tenantIds: [s.tenantId], maxStalenessHours: 48 });
    expect(before.pass).toBe(false);
    expect(before.checks.find((c) => c.name === name)).toMatchObject({ status: 'fail', data: expect.objectContaining({ lastRunStatus: 'succeeded', publishedPeriods: 0 }) });
    expect(before.checks.find((c) => c.name === name)!.detail).toMatch(/NEVER_PUBLISHED/);

    await sync(s, new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 1)) }] }]));
    const after = await runDoctor({ workerUrl: t.login.url, migrateUrl: t.db.url, tenantIds: [s.tenantId], maxStalenessHours: 48 });
    expect(after.checks.find((c) => c.name === name)).toMatchObject({ status: 'pass' });
  });
});

describe('Gap 1: names that collide once redacted are refused before anything is downloaded', () => {
  it('token=x and token=y in one period: MANIFEST_INVALID, nothing opened, nothing staged', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([
      {
        billingPeriod: P,
        artifacts: [
          { name: 'r/token=x.csv.gz', bytes: csvGz(rowsOf(P, 1, '1.00', 'x')) },
          { name: 'r/token=y.csv.gz', bytes: csvGz(rowsOf(P, 1, '1.00', 'y')) },
        ],
      },
    ]);
    const r = await sync(s, source);
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'MANIFEST_INVALID' });
    expect(source.opened).toEqual([]);
    expect(await batchesOf(t.db.pool, s.tenantId, s.sourceId)).toEqual([]);
  });
});

describe('Gap 2: evidence uploads are abort-aware', () => {
  const settings = { maxRunSeconds: 1, stallTimeoutSeconds: 6 } as RunSyncOptions['settings'];
  const set = () => [{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 2)) }] }];
  /** A listing that carries manifest bytes (so the manifest evidence is uploaded first). */
  class WithManifest extends FakeFocusSource {
    async listPeriods(range?: PeriodRange): Promise<PeriodListing[]> {
      return (await super.listPeriods(range)).map((l) => (l.ok ? { ...l, set: { ...l.set, manifest: { name: 'e-Manifest.json', bytes: Buffer.from('{}') } } } : l));
    }
  }
  class UploadStore extends MemoryEvidenceStore {
    sawSignal: boolean[] = [];
    constructor(
      private readonly which: 'put' | 'putBytes',
      private readonly honours: boolean,
    ) {
      super();
    }
    private hang(signal: AbortSignal | undefined): Promise<never> {
      this.sawSignal.push(!!signal);
      return this.honours ? untilAborted(signal) : new Promise<never>(() => undefined);
    }
    async put(key: string, filePath: string, info: { sha256: string; byteSize: number }, opts?: { signal?: AbortSignal }) {
      return this.which === 'put' ? this.hang(opts?.signal) : super.put(key, filePath, info);
    }
    async putBytes(key: string, bytes: Buffer, opts?: { signal?: AbortSignal }) {
      return this.which === 'putBytes' ? this.hang(opts?.signal) : super.putBytes(key, bytes);
    }
  }

  for (const which of ['put', 'putBytes'] as const) {
    for (const honours of [true, false]) {
      it(`${which === 'put' ? 'artifact' : 'manifest'} upload that ${honours ? 'honours' : 'ignores'} the signal and never finishes: MAX_RUN_EXCEEDED at the deadline`, async () => {
        const s = await seedTenantSource(t.db.pool);
        const evidence = new UploadStore(which, honours);
        const started = Date.now();
        const r = await runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source: new WithManifest(set()), evidence, mode: 'sync', settings, hooks: noSleep });
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(evidence.sawSignal).toEqual([true]);
        expect(r.status).toBe('failed');
        expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'MAX_RUN_EXCEEDED' });
      });
    }
  }
});

describe('Gap 3: the retry backoff is abort-aware', () => {
  it('a transient failure with a 60 s backoff: the run fails MAX_RUN_EXCEEDED at the 1 s deadline, not after the backoff', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 2)) }] }], {
      openFailure: () => Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }),
    });
    const started = Date.now();
    const r = await runSync({
      pool: t.pool,
      tenantId: s.tenantId,
      sourceKey: s.sourceKey,
      source,
      evidence: new MemoryEvidenceStore(),
      mode: 'sync',
      settings: { maxRunSeconds: 1, retryBaseMs: 60_000, retryMaxMs: 60_000, maxAttempts: 3 } as RunSyncOptions['settings'],
      hooks: { random: () => 0.999 }, // real sleep, maximum backoff
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(source.opened).toEqual(['r/a.csv.gz']); // no second attempt after the abort
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'MAX_RUN_EXCEEDED' });
  });
});

describe('PR #54 fourth review M3: the fake resolves artifacts by period and name (and version)', () => {
  it('two periods with the same artifact name and different bytes each publish their own data', async () => {
    const s = await seedTenantSource(t.db.pool);
    const P8 = '2026-08-01';
    const source = new FakeFocusSource([
      { billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 2, '1.00')) }] },
      { billingPeriod: P8, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P8, 3, '2.00')) }] },
    ]);
    const r = await sync(s, source);
    expect(r.status).toBe('succeeded');
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 2, total: '2.00' }, [P8]: { rows: 3, total: '6.00' } });
  });

  it('an artifact replaced after the listing is SOURCE_CHANGED for the stale ref (like an S3 If-Match 412)', async () => {
    const source = new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 2)) }] }]);
    const [l] = await source.listPeriods();
    if (!l.ok) throw new Error('listing failed');
    source.setPeriods([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 3)) }] }]);
    await expect(source.openArtifact(l.set.artifacts[0])).rejects.toMatchObject({ code: 'SOURCE_CHANGED', retryable: true });
  });
});

describe('PR #54 fourth review M1: pre-seeded evidence of the same size but different bytes', () => {
  it('memory store: the period fails EVIDENCE_INTEGRITY_MISMATCH and the object is not overwritten', async () => {
    const s = await seedTenantSource(t.db.pool);
    const bytes = csvGz(rowsOf(P, 2));
    const key = `evidence/${s.tenantId}/${s.sourceId}/${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    const evidence = new MemoryEvidenceStore();
    const forged = Buffer.alloc(bytes.length, 7);
    evidence.objects.set(key, forged);
    const r = await runSync({
      pool: t.pool,
      tenantId: s.tenantId,
      sourceKey: s.sourceKey,
      source: new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes }] }]),
      evidence,
      mode: 'sync',
      hooks: noSleep,
    });
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'EVIDENCE_INTEGRITY_MISMATCH' });
    expect(evidence.objects.get(key)!.equals(forged)).toBe(true);
    expect(await batchesOf(t.db.pool, s.tenantId, s.sourceId)).toEqual([]);
  });
});


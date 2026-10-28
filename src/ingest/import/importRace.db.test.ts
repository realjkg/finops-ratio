// R3 review round 2 (B1 on PR #143): concurrent `import-file` runs to ONE source + period, against
// real Postgres (worker login) and real S3 (SeaweedFS). Fixture: the public FOCUS 1.0 sample split
// into part 1 (records 1..500) and part 2 (records 501..1000) of 2024-09.
//
// The failure being pinned: the restatement guard and the S3 staging ran before the source lease was
// taken, and every import of a period writes its manifest to the same key. Two imports could then both
// pass the guard, the later manifest replaced the earlier one, and a run published data it had not
// staged while reporting success (one part's data lost, every exit 0 or a documented retry).
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DeleteObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workerTestDb, type WorkerTestDb } from '../testing/workerSetup';
import { createLogin, publishedTotals, runsOf, type Login } from '../testing/db';
import { createTestBucket, requireTestS3Endpoint, testS3Client, testS3Env, type TestBucket } from '../testing/s3';
import { cli, CLI_SOURCE } from '../testing/cli';
import { S3EvidenceStore } from '../evidence/S3EvidenceStore';
import { IngestError } from '../errors';
import { makeSourceFactory } from '../worker/sourceFactory';
import { acquireRun } from '../worker/lease';
import { runSync } from '../worker/pipeline';
import { localDelivery, stageAndSync, stageLocalFiles, type ImportRefusal, type StageAndSyncResult } from './importFile';

requireTestS3Endpoint();

const SAMPLE_FILE = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'focus-1.0-sample', 'focus_sample.csv');
const PERIOD = '2024-09-01';

let t: WorkerTestDb;
let owner: Login;
let evidence: TestBucket;
let src: TestBucket;
let s3: S3Client;
let tmp: string;
let part1: string;
let part2: string;
beforeAll(async () => {
  t = await workerTestDb();
  owner = await createLogin(t.db, ['ratio_owner']);
  evidence = await createTestBucket('ev');
  src = await createTestBucket('drop');
  s3 = testS3Client();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-import-race-'));
  const l = fs.readFileSync(SAMPLE_FILE, 'utf8').replace(/\n$/, '').split('\n');
  part1 = path.join(tmp, 'part1.csv');
  part2 = path.join(tmp, 'part2.csv');
  fs.writeFileSync(part1, `${[l[0], ...l.slice(1, 501)].join('\n')}\n`);
  fs.writeFileSync(part2, `${[l[0], ...l.slice(501)].join('\n')}\n`);
});
afterAll(async () => {
  s3?.destroy();
  await owner?.drop();
  await t?.close();
  await evidence?.destroy();
  await src?.destroy();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ RATIO_DATABASE_URL: t.login.url, RATIO_MIGRATE_DATABASE_URL: owner.url, ...testS3Env(evidence) });

async function newSource(): Promise<{ tenant: string; sid: string }> {
  const tenant = crypto.randomUUID();
  const r = await cli(['source', 'add', '--tenant', tenant, '--key', 'focus-aws', '--providers', 'AWS', '--bucket', src.name, '--prefix', src.at(tenant)], env());
  expect(r.code).toBe(0);
  const sid = (await t.db.pool.query(`SELECT id::text FROM ratio.sources WHERE tenant_id = $1`, [tenant])).rows[0].id as string;
  return { tenant, sid };
}

const location = (tenant: string) => ({ bucket: src.name, prefix: src.at(tenant), exportName: 'focus-aws' });
/** What this import stages, computed independently (same staging code, no S3). */
const stagedBy = (file: string, tenant: string) => stageLocalFiles([file], { location: location(tenant), period: PERIOD, providers: ['AWS'] });

type Outcome = { ok: StageAndSyncResult | ImportRefusal } | { error: { code?: string } };
function importVia(tenant: string, file: string, client: S3Client = s3): Promise<Outcome> {
  return stageAndSync({
    pool: t.pool,
    tenantId: tenant,
    sourceKey: 'focus-aws',
    objects: localDelivery([file]),
    period: PERIOD,
    sourceClient: () => client,
    source: makeSourceFactory({}, () => s3),
    evidence: new S3EvidenceStore({ client: s3, bucket: evidence.name, prefix: evidence.root }),
  }).then(
    (ok) => ({ ok }),
    (e: { code?: string }) => ({ error: { code: e.code } }),
  );
}

/** The real client, with hooks on this import's own PutObject calls. */
function hooked(hooks: { onFirstPut?: () => void; beforeManifestPut?: () => Promise<void>; afterManifestPut?: () => Promise<void> }): S3Client {
  let first = true;
  return {
    async send(cmd: unknown) {
      const isPut = cmd instanceof PutObjectCommand;
      const isManifest = isPut && String(cmd.input.Key).endsWith('-Manifest.json');
      if (isPut && first) {
        first = false;
        hooks.onFirstPut?.();
      }
      if (isManifest) await hooks.beforeManifestPut?.();
      const out = await s3.send(cmd as PutObjectCommand);
      if (isManifest) await hooks.afterManifestPut?.();
      return out;
    },
  } as unknown as S3Client;
}

describe('R3 review round 2 B1: concurrent imports of one source and period', () => {
  it('a second import while the first is staging exits ALREADY_RUNNING having written nothing; the first publishes exactly its own rows; the retry is refused PERIOD_ALREADY_PUBLISHED', async () => {
    const { tenant, sid } = await newSource();
    const mine = await stagedBy(part1, tenant);
    const theirs = await stagedBy(part2, tenant);
    // B starts as soon as A has begun writing to S3; A's manifest waits until B has finished. Before the
    // fix B passed the guard (nothing published yet), staged and published, and A then replaced it.
    let second!: Promise<Outcome>;
    let started!: () => void;
    const bStarted = new Promise<void>((r) => (started = r));
    const a = importVia(
      tenant,
      part1,
      hooked({
        onFirstPut: () => {
          second = importVia(tenant, part2);
          started();
        },
        beforeManifestPut: async () => {
          await bStarted;
          await second;
        },
      }),
    );
    const ra = await a;
    await bStarted;
    const rb = await second;

    expect(rb).toEqual({ error: { code: 'ALREADY_RUNNING' } });
    const keys = await src.keys(`${src.at(tenant)}/`);
    for (const o of theirs.objects.filter((x) => x.kind === 'data')) expect(keys, 'the loser wrote nothing').not.toContain(o.key);
    expect(keys.sort()).toEqual(mine.objects.map((o) => o.key).sort());

    expect('ok' in ra && ra.ok.status).toBe('succeeded');
    const res = (ra as { ok: StageAndSyncResult }).ok;
    expect(res.periods).toEqual([expect.objectContaining({ billingPeriod: PERIOD, outcome: 'published', rowCount: String(mine.preview[0].rows), billedTotal: mine.preview[0].billed.USD })]);
    expect(await publishedTotals(t.db.pool, tenant, sid)).toEqual({ [PERIOD]: { rows: mine.preview[0].rows, total: mine.preview[0].billed.USD } });

    // The loser's retry sees the winner's published content: refused, nothing written.
    const retry = await importVia(tenant, part2);
    expect('ok' in retry && retry.ok.status).toBe('refused');
    expect((retry as { ok: ImportRefusal }).ok.error.code).toBe('PERIOD_ALREADY_PUBLISHED');
    expect(await src.keys(`${src.at(tenant)}/`)).toEqual(keys);
    expect(await publishedTotals(t.db.pool, tenant, sid)).toEqual({ [PERIOD]: { rows: mine.preview[0].rows, total: mine.preview[0].billed.USD } });
  });

  it('a period whose manifest was replaced after this import staged it (another writer, e.g. one that lost its lock) fails IMPORT_MANIFEST_REPLACED and publishes nothing', async () => {
    const { tenant, sid } = await newSource();
    const theirs = await stagedBy(part2, tenant);
    const r = await importVia(
      tenant,
      part1,
      hooked({
        afterManifestPut: async () => {
          for (const o of [...theirs.objects.filter((x) => x.kind === 'data'), ...theirs.objects.filter((x) => x.kind === 'manifest')]) {
            await s3.send(new PutObjectCommand({ Bucket: src.name, Key: o.key, Body: o.body }));
          }
        },
      }),
    );
    expect('ok' in r).toBe(true);
    const res = (r as { ok: StageAndSyncResult }).ok;
    expect(res.status).toBe('failed');
    expect(res.periods).toEqual([expect.objectContaining({ billingPeriod: PERIOD, outcome: 'failed', code: 'IMPORT_MANIFEST_REPLACED' })]);
    expect(res.periods.some((p) => p.outcome === 'published')).toBe(false);
    expect(await publishedTotals(t.db.pool, tenant, sid)).toEqual({});
  });

  // Review round 3 (NIT): the listing of a period whose manifest is gone fails MANIFEST_MISSING, and that
  // listing's own code is reported (it was reported as IMPORT_MANIFEST_REPLACED before).
  it('a period whose staged manifest is gone before the sync lists it fails with the listing code MANIFEST_MISSING, never an empty success', async () => {
    const { tenant, sid } = await newSource();
    const r = await importVia(
      tenant,
      part1,
      hooked({
        afterManifestPut: async () => {
          const key = (await src.keys(`${src.at(tenant)}/`)).find((k) => k.endsWith('-Manifest.json'))!;
          await s3.send(new DeleteObjectCommand({ Bucket: src.name, Key: key }));
        },
      }),
    );
    const res = (r as { ok: StageAndSyncResult }).ok;
    expect(res.status).toBe('failed');
    expect(res.periods).toEqual([expect.objectContaining({ billingPeriod: PERIOD, outcome: 'failed', code: 'MANIFEST_MISSING' })]);
    expect(await publishedTotals(t.db.pool, tenant, sid)).toEqual({});
  });

  it('a staged period the source does not list at all (on S3 the metadata prefix of a deleted manifest disappears; SeaweedFS keeps it, so the listing is filtered here) fails IMPORT_MANIFEST_REPLACED', async () => {
    const { tenant, sid } = await newSource();
    const real = makeSourceFactory({}, () => s3);
    const r = await stageAndSync({
      pool: t.pool,
      tenantId: tenant,
      sourceKey: 'focus-aws',
      objects: localDelivery([part1]),
      period: PERIOD,
      sourceClient: () => s3,
      source: (row) => {
        const inner = real(row);
        return { kind: inner.kind, listPeriods: async () => [], openArtifact: (ref, opts) => inner.openArtifact(ref, opts) };
      },
      evidence: new S3EvidenceStore({ client: s3, bucket: evidence.name, prefix: evidence.root }),
    });
    expect(r.status).toBe('failed');
    expect((r as StageAndSyncResult).periods).toEqual([expect.objectContaining({ billingPeriod: PERIOD, outcome: 'failed', code: 'IMPORT_MANIFEST_REPLACED' })]);
    expect(await publishedTotals(t.db.pool, tenant, sid)).toEqual({});
  });

  it('a manifest replaced while the period is being read (SOURCE_CHANGED, re-listed) also fails IMPORT_MANIFEST_REPLACED and publishes nothing', async () => {
    const { tenant, sid } = await newSource();
    const theirs = await stagedBy(part2, tenant);
    const real = makeSourceFactory({}, () => s3);
    let first = true;
    const r = await stageAndSync({
      pool: t.pool,
      tenantId: tenant,
      sourceKey: 'focus-aws',
      objects: localDelivery([part1]),
      period: PERIOD,
      sourceClient: () => s3,
      source: (row) => {
        const inner = real(row);
        return {
          kind: inner.kind,
          listPeriods: (range, opts) => inner.listPeriods(range, opts),
          async openArtifact(ref, opts) {
            if (first) {
              first = false;
              for (const o of [...theirs.objects.filter((x) => x.kind === 'data'), ...theirs.objects.filter((x) => x.kind === 'manifest')]) {
                await s3.send(new PutObjectCommand({ Bucket: src.name, Key: o.key, Body: o.body }));
              }
              throw new IngestError('SOURCE_CHANGED', 'changed since listed (test)', { retryable: true });
            }
            return inner.openArtifact(ref, opts);
          },
        };
      },
      evidence: new S3EvidenceStore({ client: s3, bucket: evidence.name, prefix: evidence.root }),
      hooks: { sleep: async () => undefined },
    });
    expect(first).toBe(false);
    expect(r.status).toBe('failed');
    expect((r as StageAndSyncResult).periods).toEqual([expect.objectContaining({ billingPeriod: PERIOD, outcome: 'failed', code: 'IMPORT_MANIFEST_REPLACED' })]);
    expect(await publishedTotals(t.db.pool, tenant, sid)).toEqual({});
  });

  it('two concurrent CLI processes (part 1, part 2): every exit is honest (0 = own rows published, 4 = nothing written, 3 = refused); the end state is the winner\'s rows', async () => {
    const run = (argv: string[]) =>
      new Promise<{ code: number | null; rec: { results: { periods?: Array<{ outcome: string; rowCount?: string }>; error?: { code: string } } } }>((resolve) => {
        const c = spawn(process.execPath, ['--import', 'tsx', CLI_SOURCE, ...argv], { env: { ...process.env, ...env() } });
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        c.stderr.resume();
        c.on('exit', (code) => resolve({ code, rec: JSON.parse(out.trim().split('\n').pop() || '{}') }));
      });
    for (let i = 0; i < 3; i++) {
      const { tenant, sid } = await newSource();
      const rows = { [part1]: (await stagedBy(part1, tenant)).preview[0].rows, [part2]: (await stagedBy(part2, tenant)).preview[0].rows };
      const base = ['import-file', '--tenant', tenant, '--source', 'focus-aws', '--period', '2024-09'];
      const results = await Promise.all([part1, part2].map((f) => run([...base, '--file', f]).then((r) => ({ f, ...r }))));
      const published = await publishedTotals(t.db.pool, tenant, sid);
      const winners = results.filter((r) => r.code === 0);
      expect(winners.length, JSON.stringify(results.map((r) => [r.code, r.rec.results]))).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        if (r.code === 0) expect(r.rec.results.periods).toEqual([expect.objectContaining({ outcome: 'published', rowCount: String(rows[r.f]) })]);
        else expect([[4, 'ALREADY_RUNNING'], [3, 'PERIOD_ALREADY_PUBLISHED']]).toContainEqual([r.code, r.rec.results.error?.code]);
      }
      expect(winners).toHaveLength(1);
      expect(published[PERIOD].rows).toBe(rows[winners[0].f]);
    }
  }, 180_000);
});

// R3 review round 3 (PR #143 MEDIUM): the run lease used to be taken by the sync AFTER the delivery was
// staged, so an import refused because another run held the lease (exit 4, "nothing written") had
// already put its data + manifest on S3, and the next plain `sync` published them.
describe('R3 review round 3: an import refused for the run lease writes nothing', () => {
  const expireLeases = (sid: string) => t.db.pool.query(`UPDATE ratio.sync_runs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE source_id = $1 AND status = 'running'`, [sid]);

  it('another run holds a live lease: import-file --restate exits 4 with nothing on S3; after the lease expires a plain sync publishes nothing new', async () => {
    const { tenant, sid } = await newSource();
    const base = ['import-file', '--tenant', tenant, '--source', 'focus-aws', '--period', '2024-09'];
    expect((await cli([...base, '--file', part1], env())).code).toBe(0);
    const pubA = await publishedTotals(t.db.pool, tenant, sid);
    const keysA = (await src.keys(`${src.at(tenant)}/`)).sort();

    // A sync that holds the lease and dies (deterministic: the lease is taken and never finished).
    await acquireRun(t.pool, tenant, 'focus-aws', { kind: 'scheduled', ttlSeconds: 300 });
    const r = await cli([...base, '--file', part2, '--restate'], env());
    expect(r.code).toBe(4);
    expect((r.record.results as { error: { code: string } }).error.code).toBe('ALREADY_RUNNING');
    expect((await src.keys(`${src.at(tenant)}/`)).sort(), 'the refused import wrote nothing to S3').toEqual(keysA);
    expect(await publishedTotals(t.db.pool, tenant, sid)).toEqual(pubA);

    await expireLeases(sid);
    const s = await cli(['sync', '--tenant', tenant, '--source', 'focus-aws'], env());
    expect(s.code).toBe(0);
    const periods = (s.record.results as { periods: Array<{ outcome: string }> }).periods;
    expect(periods.some((p) => p.outcome === 'published'), JSON.stringify(periods)).toBe(false);
    expect(await publishedTotals(t.db.pool, tenant, sid), 'the later sync published nothing new').toEqual(pubA);
  });

  it('the import holds the run lease while it stages: a plain sync started meanwhile is refused ALREADY_RUNNING and the import publishes its own rows', async () => {
    const { tenant, sid } = await newSource();
    const mine = await stagedBy(part1, tenant);
    let sync!: Promise<unknown>;
    const r = await importVia(
      tenant,
      part1,
      hooked({
        beforeManifestPut: async () => {
          sync = runSync({ pool: t.pool, tenantId: tenant, sourceKey: 'focus-aws', source: makeSourceFactory({}, () => s3), evidence: new S3EvidenceStore({ client: s3, bucket: evidence.name, prefix: evidence.root }), mode: 'sync' }).then(
            () => 'ran',
            (e: { code?: string }) => e.code,
          );
          await sync;
        },
      }),
    );
    expect(await sync).toBe('ALREADY_RUNNING');
    expect('ok' in r && r.ok.status).toBe('succeeded');
    expect(await publishedTotals(t.db.pool, tenant, sid)).toEqual({ [PERIOD]: { rows: mine.preview[0].rows, total: mine.preview[0].billed.USD } });
    expect((await runsOf(t.db.pool, tenant, sid)).map((x) => [x.run_kind, x.status])).toEqual([['backfill', 'succeeded']]);
  });

  it('staging that fails after the lease was taken finishes the run (failed), so the next import is not blocked until the TTL', async () => {
    const { tenant, sid } = await newSource();
    const broken = { send: async () => { throw new Error('S3 put failed (test)'); } } as unknown as S3Client;
    const r = await importVia(tenant, part1, broken);
    expect(r).toEqual({ error: { code: undefined } });
    expect((await runsOf(t.db.pool, tenant, sid)).map((x) => x.status)).toEqual(['failed']);
    const again = await importVia(tenant, part1);
    expect('ok' in again && again.ok.status).toBe('succeeded');
  });

  it('a refusal for a published period (exit 3) takes no lease and starts no run', async () => {
    const { tenant, sid } = await newSource();
    expect('ok' in (await importVia(tenant, part1))).toBe(true);
    const refused = await importVia(tenant, part2);
    expect('ok' in refused && refused.ok.status).toBe('refused');
    expect((await runsOf(t.db.pool, tenant, sid)).map((x) => x.status)).toEqual(['succeeded']);
  });
});

// R3 review round 3 (NIT): a failed listing of an expected period reports the listing's own error code.
describe('R3 review round 3: a failed listing is not reported as a replaced manifest', () => {
  it('the listing fails for the staged period (no manifest bytes): the period fails with the listing code', async () => {
    const { tenant, sid } = await newSource();
    const r = await stageAndSync({
      pool: t.pool,
      tenantId: tenant,
      sourceKey: 'focus-aws',
      objects: localDelivery([part1]),
      period: PERIOD,
      sourceClient: () => s3,
      source: (row) => {
        const inner = makeSourceFactory({}, () => s3)(row);
        return { kind: inner.kind, listPeriods: async () => [{ ok: false, billingPeriod: PERIOD, code: 'MANIFEST_INVALID', message: 'listing failed (test)' }], openArtifact: (ref, opts) => inner.openArtifact(ref, opts) };
      },
      evidence: new S3EvidenceStore({ client: s3, bucket: evidence.name, prefix: evidence.root }),
    });
    expect((r as StageAndSyncResult).periods).toEqual([expect.objectContaining({ billingPeriod: PERIOD, outcome: 'failed', code: 'MANIFEST_INVALID' })]);
    expect(await publishedTotals(t.db.pool, tenant, sid)).toEqual({});
  });
});

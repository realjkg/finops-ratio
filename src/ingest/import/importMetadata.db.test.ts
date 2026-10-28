// R3 part 3 end to end: the implementation-metadata record through
// `source add --metadata` and `import-file --metadata` (real Postgres + S3).
// Public FOCUS 1.0 sample; its record (fixtures/focus-1.0-sample/metadata.json)
// carries control totals for this exact file only.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workerTestDb, type WorkerTestDb } from '../testing/workerSetup';
import { batchesOf, createLogin, type Login } from '../testing/db';
import { createTestBucket, requireTestS3Endpoint, testS3Env, type TestBucket } from '../testing/s3';
import { cli } from '../testing/cli';

requireTestS3Endpoint();

const DIR = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'focus-1.0-sample');
const SAMPLE_FILE = path.join(DIR, 'focus_sample.csv');
const META_FILE = path.join(DIR, 'metadata.json');
const META_BYTES = fs.readFileSync(META_FILE);
const META = JSON.parse(META_BYTES.toString('utf8'));

let t: WorkerTestDb;
let owner: Login;
let evidence: TestBucket;
let src: TestBucket;
let tmp: string;
beforeAll(async () => {
  t = await workerTestDb();
  owner = await createLogin(t.db, ['ratio_owner']);
  evidence = await createTestBucket('ev');
  src = await createTestBucket('meta');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-meta-'));
});
afterAll(async () => {
  await owner?.drop();
  await t?.close();
  await evidence?.destroy();
  await src?.destroy();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ RATIO_DATABASE_URL: t.login.url, RATIO_MIGRATE_DATABASE_URL: owner.url, ...testS3Env(evidence) });
const addSource = (tenant: string, key: string, providers: string, extra: string[] = []) =>
  cli(['source', 'add', '--tenant', tenant, '--key', key, '--providers', providers, '--bucket', src.name, '--prefix', src.at(tenant), ...extra], env());
const importArgs = (tenant: string, key: string, extra: string[] = [], file = SAMPLE_FILE) => ['import-file', '--tenant', tenant, '--source', key, '--file', file, ...extra];
const writeMeta = (doc: unknown) => {
  const f = path.join(tmp, `${crypto.randomUUID()}.json`);
  fs.writeFileSync(f, JSON.stringify(doc));
  return f;
};
type Period = { billingPeriod: string; outcome: string; reconciliation?: string; reconciliationNote?: string; code?: string };
type Results = { periods: Period[]; overlapWarnings: Array<{ billingPeriod: string; otherSource: string }>; error?: { code: string; message: string } };
const results = (r: Awaited<ReturnType<typeof cli>>) => r.record.results as unknown as Results;
async function manifestImport(tenant: string, ym: string, key = 'focus-aws') {
  const keys = await src.keys(`${src.at(tenant)}/`);
  const k = keys.filter((x) => x.includes(`/${key}/metadata/BILLING_PERIOD=${ym}/`));
  return JSON.parse((await src.get(k[0])).toString('utf8'))['x-ratio-import'];
}

describe('R3 import-file --metadata', () => {
  it('the record is the control for one period: reconciled; the record and its sha256 travel in the manifest', async () => {
    const tenant = crypto.randomUUID();
    expect((await addSource(tenant, 'focus-aws', 'AWS')).code).toBe(0);
    const r = await cli(importArgs(tenant, 'focus-aws', ['--period', '2024-09', '--metadata', META_FILE]), env());
    expect(r.code).toBe(0);
    expect(results(r).periods).toEqual([expect.objectContaining({ billingPeriod: '2024-09-01', outcome: 'published', reconciliation: 'reconciled' })]);
    const sid = (await t.db.pool.query(`SELECT id::text FROM ratio.sources WHERE tenant_id = $1`, [tenant])).rows[0].id;
    expect((await batchesOf(t.db.pool, tenant, sid)).map((b) => [b.control_rows, b.control_total])).toEqual([[null, META.financial.billed_cost_total.USD]]);
    const imp = await manifestImport(tenant, '2024-09');
    expect(imp.metadata).toEqual(META);
    expect(imp.metadataSha256).toBe(crypto.createHash('sha256').update(META_BYTES).digest('hex'));
  });

  it('flags and record must agree; flags win when they do', async () => {
    const tenant = crypto.randomUUID();
    expect((await addSource(tenant, 'focus-aws', 'AWS')).code).toBe(0);
    const conflict = await cli(importArgs(tenant, 'focus-aws', ['--period', '2024-09', '--metadata', META_FILE, '--control-billed', '18.0066386184', '--currency', 'EUR']), env());
    expect([conflict.code, results(conflict).error?.code]).toEqual([2, 'IMPORT_CONTROL_CONFLICT']);
    const agree = await cli(importArgs(tenant, 'focus-aws', ['--period', '2024-09', '--metadata', META_FILE, '--control-rows', '942', '--control-billed', '18.0066386184', '--currency', 'USD']), env());
    expect(agree.code).toBe(0);
    expect(results(agree).periods[0]).toMatchObject({ reconciliation: 'reconciled' });
  });

  it('a multi-period import is never reconciled against a whole-scope total: unverified with the reason', async () => {
    const tenant = crypto.randomUUID();
    expect((await addSource(tenant, 'focus-aws', 'AWS')).code).toBe(0);
    const r = await cli(importArgs(tenant, 'focus-aws', ['--metadata', META_FILE]), env());
    expect(results(r).periods[0]).toMatchObject({ billingPeriod: '2024-09-01', outcome: 'published', reconciliation: 'unverified', reconciliationNote: expect.stringContaining('import it with --period 2024-09') });
  });

  it("a record without a billed total ('unknown') leaves the period unverified (no control total supplied)", async () => {
    const tenant = crypto.randomUUID();
    expect((await addSource(tenant, 'focus-aws', 'AWS')).code).toBe(0);
    const f = writeMeta({ ...META, financial: { ...META.financial, billed_cost_total: 'unknown' } });
    const r = await cli(importArgs(tenant, 'focus-aws', ['--period', '2024-09', '--metadata', f]), env());
    expect(results(r).periods[0]).toMatchObject({ reconciliation: 'unverified', reconciliationNote: 'unverified (no control total supplied)' });
  });

  it('refuses a record whose provider the source does not declare, and an invalid record (exit 2, key named)', async () => {
    const tenant = crypto.randomUUID();
    expect((await addSource(tenant, 'focus-ms', 'Microsoft')).code).toBe(0);
    const r = await cli(importArgs(tenant, 'focus-ms', ['--period', '2024-09', '--metadata', META_FILE]), env());
    expect([r.code, results(r).error?.code]).toEqual([2, 'METADATA_MISMATCH']);
    const bad = await cli(importArgs(tenant, 'focus-ms', ['--metadata', writeMeta({ ...META, extra: 'VAL-9' })]), env());
    expect([bad.code, results(bad).error?.code]).toEqual([2, 'METADATA_INVALID']);
    expect(bad.out.concat(bad.err).join('\n')).not.toContain('VAL-9');
  });

  it('refuses rows outside the declared scope before anything is written', async () => {
    const tenant = crypto.randomUUID();
    expect((await addSource(tenant, 'focus-aws', 'AWS')).code).toBe(0);
    const f = writeMeta({ ...META, scope: { ...META.scope, period_end: '2024-09-15', period_end_semantics: 'inclusive' } });
    const r = await cli(importArgs(tenant, 'focus-aws', ['--metadata', f]), env());
    expect([r.code, results(r).error?.code]).toEqual([1, 'IMPORT_SCOPE_VIOLATION']);
    expect(await src.keys(`${src.at(tenant)}/`)).toEqual([]);
  });

  it('overlap yes requires a registered related source and records it; a same-period overlap with other bytes is a warning', async () => {
    const tenant = crypto.randomUUID();
    expect((await addSource(tenant, 'focus-a', 'AWS')).code).toBe(0);
    expect((await addSource(tenant, 'focus-b', 'AWS')).code).toBe(0);
    expect((await cli(importArgs(tenant, 'focus-a', ['--period', '2024-09']), env())).code).toBe(0);
    const overlapping = { ...META, overlap: { also_present_in_other_source: 'yes', related_source: 'no-such-source' } };
    const missing = await cli(importArgs(tenant, 'focus-b', ['--period', '2024-09', '--metadata', writeMeta(overlapping)]), env());
    expect([missing.code, results(missing).error?.code]).toEqual([1, 'IMPORT_RELATED_SOURCE_NOT_FOUND']);

    // Other bytes for the same period (one Microsoft row dropped): not a byte duplicate, but an overlap.
    const lines = fs.readFileSync(SAMPLE_FILE, 'utf8').split('\n');
    const msRow = lines.findIndex((l) => l.includes(',"Microsoft",'));
    const other = path.join(tmp, 'other.csv');
    fs.writeFileSync(other, lines.filter((_, i) => i !== msRow).join('\n'));
    const ok = await cli(importArgs(tenant, 'focus-b', ['--period', '2024-09', '--metadata', writeMeta({ ...overlapping, overlap: { ...overlapping.overlap, related_source: 'focus-a' } })], other), env());
    expect(ok.code).toBe(0);
    expect(results(ok).overlapWarnings).toEqual([expect.objectContaining({ billingPeriod: '2024-09-01', otherSource: 'focus-a' })]);
    expect((await manifestImport(tenant, '2024-09', 'focus-b')).overlap).toEqual({ alsoPresentInOtherSource: 'yes', relatedSource: 'focus-a', relatedSourceId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it('source add --metadata stores the record on the source; import-file uses it when no --metadata is given', async () => {
    const tenant = crypto.randomUUID();
    const add = await addSource(tenant, 'focus-aws', 'AWS', ['--metadata', META_FILE]);
    expect(add.code).toBe(0);
    const cfg = (await t.db.pool.query(`SELECT config FROM ratio.sources WHERE tenant_id = $1`, [tenant])).rows[0].config;
    expect(cfg.metadata).toEqual(META);
    expect(cfg.metadataSha256).toBe(crypto.createHash('sha256').update(META_BYTES).digest('hex'));
    const r = await cli(importArgs(tenant, 'focus-aws', ['--period', '2024-09']), env());
    expect(results(r).periods[0]).toMatchObject({ reconciliation: 'reconciled' });
  });

  // Review round 1 (PR #145).
  it('B3: a rows-only flag control never overrides the record billed total: 99.00 + --control-rows 942 is NOT reconciled', async () => {
    const tenant = crypto.randomUUID();
    expect((await addSource(tenant, 'focus-aws', 'AWS')).code).toBe(0);
    const wrong = writeMeta({ ...META, financial: { ...META.financial, billed_cost_total: { USD: '99.00' } } });
    const r = await cli(importArgs(tenant, 'focus-aws', ['--period', '2024-09', '--metadata', wrong, '--control-rows', '942']), env());
    expect(r.code).toBe(1);
    expect(results(r).periods).toEqual([expect.objectContaining({ billingPeriod: '2024-09-01', outcome: 'quarantined', code: 'RECONCILIATION_VARIANCE', reconciliation: 'variance' })]);
    const sid = (await t.db.pool.query(`SELECT id::text FROM ratio.sources WHERE tenant_id = $1`, [tenant])).rows[0].id;
    expect((await batchesOf(t.db.pool, tenant, sid)).map((b) => [b.status, b.control_rows, b.control_total])).toEqual([['quarantined', '942', '99.00']]);
  });

  it('B3: rows-only flags merge with a matching record billed total (both recorded, reconciled); a record total that cannot apply is IMPORT_CONTROL_CONFLICT', async () => {
    const tenant = crypto.randomUUID();
    expect((await addSource(tenant, 'focus-aws', 'AWS')).code).toBe(0);
    const ok = await cli(importArgs(tenant, 'focus-aws', ['--period', '2024-09', '--metadata', META_FILE, '--control-rows', '942']), env());
    expect(ok.code).toBe(0);
    expect(results(ok).periods[0]).toMatchObject({ outcome: 'published', reconciliation: 'reconciled' });
    // Review M4: the metadata path is never echoed, only that a record was supplied.
    expect(ok.record.args).toMatchObject({ metadata: 'supplied' });
    expect(ok.out.concat(ok.err).join('\n')).not.toContain(path.basename(META_FILE));
    const sid = (await t.db.pool.query(`SELECT id::text FROM ratio.sources WHERE tenant_id = $1`, [tenant])).rows[0].id;
    expect((await batchesOf(t.db.pool, tenant, sid)).map((b) => [b.control_rows, b.control_total])).toEqual([['942', META.financial.billed_cost_total.USD]]);
    const twoMonths = writeMeta({ ...META, scope: { ...META.scope, period_end: '2024-11-01' } });
    const conflict = await cli(importArgs(tenant, 'focus-aws', ['--period', '2024-09', '--metadata', twoMonths, '--control-rows', '942']), env());
    expect([conflict.code, results(conflict).error?.code]).toEqual([2, 'IMPORT_CONTROL_CONFLICT']);
  });

  it('overlap: marked prominently (overlapNotice, the period, a warn log line) and never names the importing source itself', async () => {
    const tenant = crypto.randomUUID();
    expect((await addSource(tenant, 'focus-a', 'AWS')).code).toBe(0);
    expect((await addSource(tenant, 'focus-b', 'AWS')).code).toBe(0);
    expect((await cli(importArgs(tenant, 'focus-a', ['--period', '2024-09']), env())).code).toBe(0);
    const lines = fs.readFileSync(SAMPLE_FILE, 'utf8').split('\n');
    const msRow = lines.findIndex((l) => l.includes(',"Microsoft",'));
    const other = path.join(tmp, `other-${tenant}.csv`);
    fs.writeFileSync(other, lines.filter((_, i) => i !== msRow).join('\n'));
    // The importing source's own published batch is not an overlap (restating focus-a with other bytes).
    const self = await cli(importArgs(tenant, 'focus-a', ['--period', '2024-09', '--restate'], other), env());
    expect(self.code).toBe(0);
    expect(results(self).overlapWarnings).toEqual([]);
    expect((self.record.results as { overlapNotice: unknown }).overlapNotice).toBeNull();
    const b = await cli(importArgs(tenant, 'focus-b', ['--period', '2024-09']), env());
    expect(b.code).toBe(0);
    expect((b.record.results as { overlapNotice: string }).overlapNotice).toMatch(/^OVERLAP: 1 .*COUNTED TWICE/);
    expect(results(b).periods[0]).toMatchObject({ overlapWarning: expect.stringContaining('COUNTED TWICE') });
    expect(b.err.some((l) => JSON.parse(l).event === 'import.overlap' && JSON.parse(l).level === 'warn')).toBe(true);
  });
});

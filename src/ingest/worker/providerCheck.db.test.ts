// Issue #62 (D1–D8): the worker checks FOCUS ProviderName against the
// source type, through the real pipeline, RLS and grants (worker login).
// DESIGN: docs/evidence/issue-62/DESIGN.md §2–§3, §6.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource, type FakePeriod } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { runSync, type RunSyncOptions } from './pipeline';
import { showBatch } from './quarantine';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import { batchesOf, publishedTotals, seedTenantSource, type SeededSource } from '../testing/db';
import { FOCUS_HEADER, csvGz, focusRow, type FocusRow } from '../testing/focusCsv';
import { cli } from '../testing/cli';
import { createTestBucket, requireTestS3Endpoint, testS3Env, type TestBucket } from '../testing/s3';

let t: WorkerTestDb;
beforeAll(async () => {
  t = await workerTestDb();
});
afterAll(async () => {
  await t.close();
});

const P = '2026-07-01';
const AWS_CONFIG = { layout: 'aws-data-exports', bucket: 'unused-bucket', prefix: 'p62', exportName: 'focus-export' };

const awsSource = () => seedTenantSource(t.db.pool, { kind: 'focus_file', config: AWS_CONFIG });

/** Production-like by default: the synthetic-provider opt-in is explicitly OFF unless a test turns it on. */
function sync(s: SeededSource, source: FakeFocusSource, extra: Partial<RunSyncOptions> = {}) {
  return runSync({
    pool: t.pool,
    tenantId: s.tenantId,
    sourceKey: s.sourceKey,
    source,
    evidence: new MemoryEvidenceStore(),
    mode: 'sync',
    ...extra,
    settings: { allowSyntheticProviders: false, ...extra.settings },
    hooks: { ...noSleep, ...extra.hooks },
  });
}

const row = (provider: string, cost: string, tag: string, extra: FocusRow = {}): FocusRow => focusRow(P, { ProviderName: provider, BilledCost: cost, ResourceId: tag, ...extra });

const period = (artifacts: Array<[string, Buffer]>, control?: FakePeriod['control']): FakePeriod => ({
  billingPeriod: P,
  artifacts: artifacts.map(([name, bytes]) => ({ name, bytes })),
  control,
});

/** The batch's published facts: (artifact name, row ordinal, provider, billed) in order. */
async function factsOf(s: SeededSource, batchId: string) {
  const r = await t.db.pool.query(
    `SELECT a.artifact_name, f.row_ordinal::int AS ord, f.provider_name, f.billed_cost::text AS billed
     FROM ratio.cost_facts f JOIN ratio.ingest_artifacts a ON a.batch_id = f.batch_id AND a.sha256 = f.artifact_sha256
     WHERE f.tenant_id = $1 AND f.batch_id = $2 ORDER BY a.artifact_name, f.row_ordinal`,
    [s.tenantId, batchId],
  );
  return r.rows.map((x) => [x.artifact_name, x.ord, x.provider_name, x.billed]);
}

async function artifactRowCounts(s: SeededSource, batchId: string) {
  const r = await t.db.pool.query(`SELECT artifact_name, row_count::int AS n FROM ratio.ingest_artifacts WHERE tenant_id = $1 AND batch_id = $2 ORDER BY 1`, [
    s.tenantId,
    batchId,
  ]);
  return Object.fromEntries(r.rows.map((x) => [x.artifact_name, x.n]));
}

describe('D1 a mixed-provider file on an AWS Data Exports source', () => {
  it('excludes exactly the foreign rows (recorded as PROVIDER_MISMATCH) and publishes the rest', async () => {
    const s = await awsSource();
    const mixed = csvGz([
      row('AWS', '1.00', 'a1'),
      row('Microsoft', '2.00', 'm1'),
      row('AWS', '3.00', 'a2'),
      row('Oracle', '4.00', 'o1'),
      row('AWS', '5.00', 'a3'),
      row('Microsoft', '6.00', 'm2'),
      row('AWS', '7.00', 'a4'),
    ]);
    const awsOnly = csvGz([row('AWS', '0.50', 'b1'), row('AWS', '0.25', 'b2')]);
    const r = await sync(s, new FakeFocusSource([period([['run/a-mixed.csv.gz', mixed], ['run/b-aws.csv.gz', awsOnly]])]));

    expect(r.status).toBe('succeeded');
    expect(r.periods).toHaveLength(1);
    expect(r.periods[0]).toMatchObject({ outcome: 'published', rowCount: '6', billedTotal: '16.75', reconciliation: 'unverified', excludedRows: '3' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 6, total: '16.75' } });

    const batchId = r.periods[0].batchId!;
    expect(await factsOf(s, batchId)).toEqual([
      ['run/a-mixed.csv.gz', 1, 'AWS', '1.00'],
      ['run/a-mixed.csv.gz', 3, 'AWS', '3.00'],
      ['run/a-mixed.csv.gz', 5, 'AWS', '5.00'],
      ['run/a-mixed.csv.gz', 7, 'AWS', '7.00'],
      ['run/b-aws.csv.gz', 1, 'AWS', '0.50'],
      ['run/b-aws.csv.gz', 2, 'AWS', '0.25'],
    ]);
    // Per-artifact row counts still count every record of the file.
    expect(await artifactRowCounts(s, batchId)).toEqual({ 'run/a-mixed.csv.gz': 7, 'run/b-aws.csv.gz': 2 });

    const [b] = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(b).toMatchObject({ status: 'published', row_count: '6', loaded: '16.75', error_count: '3', quarantine_reason: null });

    // Inspectable as the worker (RLS): exactly the foreign row ordinals, no cell values.
    const shown = await showBatch(t.pool, s.tenantId, batchId);
    expect(shown.batch).toMatchObject({ status: 'published', validationErrorCount: '3', storedErrorCount: 3 });
    expect(shown.errors.map((e) => [e.rowOrdinal, e.column, e.code])).toEqual([
      ['2', 'ProviderName', 'PROVIDER_MISMATCH'],
      ['4', 'ProviderName', 'PROVIDER_MISMATCH'],
      ['6', 'ProviderName', 'PROVIDER_MISMATCH'],
    ]);
    const mixedSha = shown.batch.artifacts.find((a) => a.name === 'run/a-mixed.csv.gz')!.sha256;
    for (const e of shown.errors) {
      expect(e.artifactSha256).toBe(mixedSha);
      expect(e.message).toBe('ProviderName is not allowed for source type aws-data-exports (allowed: AWS); row excluded');
      expect(e.message).not.toMatch(/Microsoft|Oracle/);
    }
  });

  it('an unchanged listing is skipped on the next sync (the published batch with exclusions is final)', async () => {
    const s = await awsSource();
    const source = new FakeFocusSource([period([['run/x.csv.gz', csvGz([row('AWS', '1.00', 'a'), row('Oracle', '9.00', 'o')])]])]);
    expect((await sync(s, source)).periods[0]).toMatchObject({ outcome: 'published', excludedRows: '1' });
    const again = await sync(s, source);
    expect(again.status).toBe('succeeded');
    expect(again.periods[0]).toMatchObject({ outcome: 'skipped_unchanged' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 1, total: '1.00' } });
  });

  it('a batch without foreign rows reports no excludedRows and stores no errors', async () => {
    const s = await awsSource();
    const r = await sync(s, new FakeFocusSource([period([['run/x.csv.gz', csvGz([row('AWS', '1.00', 'a')])]])]));
    expect(r.periods[0].outcome).toBe('published');
    expect(r.periods[0]).not.toHaveProperty('excludedRows');
    expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId))[0].error_count).toBe('0');
  });
});

describe('D2 a batch whose every row is foreign is never published', () => {
  it('is quarantined PROVIDER_MISMATCH; the period keeps its prior publication; a re-sync stays BATCH_QUARANTINED', async () => {
    const s = await awsSource();
    const source = new FakeFocusSource([period([['run1/x.csv.gz', csvGz([row('AWS', '10.00', 'a')])]])]);
    expect((await sync(s, source)).periods[0]).toMatchObject({ outcome: 'published' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 1, total: '10.00' } });

    source.setPeriods([period([['run2/x.csv.gz', csvGz([row('Microsoft', '2.00', 'm1'), row('Oracle', '3.00', 'o1'), row('Microsoft', '4.00', 'm2')])]])]);
    const r = await sync(s, source);
    expect(r.status).toBe('failed');
    expect(r.periods[0]).toMatchObject({ outcome: 'quarantined', code: 'PROVIDER_MISMATCH' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 1, total: '10.00' } });

    const batches = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(batches.map((b) => b.status)).toEqual(['published', 'quarantined']);
    const q = batches[1];
    expect(q).toMatchObject({ row_count: '0', loaded: '0', error_count: '3' });
    expect(q.quarantine_reason).toBe(
      'PROVIDER_MISMATCH: every data row (3) has a ProviderName not allowed for source type aws-data-exports (PROVIDER_MISMATCH x3)',
    );
    const shown = await showBatch(t.pool, s.tenantId, q.id);
    expect(shown.errors.map((e) => [e.rowOrdinal, e.code])).toEqual([
      ['1', 'PROVIDER_MISMATCH'],
      ['2', 'PROVIDER_MISMATCH'],
      ['3', 'PROVIDER_MISMATCH'],
    ]);
    const facts = await t.db.pool.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE batch_id = $1`, [q.id]);
    expect(facts.rows[0].n).toBe(0);

    const again = await sync(s, source);
    expect(again.status).toBe('failed');
    expect(again.periods[0]).toMatchObject({ outcome: 'failed', code: 'BATCH_QUARANTINED', batchId: q.id });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 1, total: '10.00' } });
  });

  it('on a fresh source nothing is published at all, even across several all-foreign artifacts', async () => {
    const s = await awsSource();
    const r = await sync(
      s,
      new FakeFocusSource([period([['run/a.csv.gz', csvGz([row('Oracle', '1.00', 'o1')])], ['run/b.csv.gz', csvGz([row('Google Cloud', '1.00', 'g1')])]])]),
    );
    expect(r.periods[0]).toMatchObject({ outcome: 'quarantined', code: 'PROVIDER_MISMATCH' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
    expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId))[0]).toMatchObject({ status: 'quarantined', error_count: '2' });
  });
});

describe('D3 a NULL or missing ProviderName quarantines the whole batch (fail closed)', () => {
  it('an empty ProviderName cell ⇒ VALIDATION_FAILED, MISSING_VALUE on ProviderName, nothing published', async () => {
    const s = await awsSource();
    const r = await sync(s, new FakeFocusSource([period([['run/x.csv.gz', csvGz([row('AWS', '1.00', 'a1'), row('', '2.00', 'n1'), row('AWS', '3.00', 'a2')])]])]));
    expect(r.status).toBe('failed');
    expect(r.periods[0]).toMatchObject({ outcome: 'quarantined', code: 'VALIDATION_FAILED' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
    const [b] = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(b).toMatchObject({ status: 'quarantined', error_count: '1' });
    expect(b.quarantine_reason).toBe('VALIDATION_FAILED: 1 validation error(s) (MISSING_VALUE x1)');
    const shown = await showBatch(t.pool, s.tenantId, b.id);
    expect(shown.errors.map((e) => [e.rowOrdinal, e.column, e.code])).toEqual([['2', 'ProviderName', 'MISSING_VALUE']]);
  });

  it('a header without ProviderName ⇒ VALIDATION_FAILED, MISSING_REQUIRED_COLUMN on ProviderName', async () => {
    const s = await awsSource();
    const header = FOCUS_HEADER.filter((c) => c !== 'ProviderName');
    const r = await sync(s, new FakeFocusSource([period([['run/x.csv.gz', csvGz([row('AWS', '1.00', 'a1')], header)]])]));
    expect(r.periods[0]).toMatchObject({ outcome: 'quarantined', code: 'VALIDATION_FAILED' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
    const [b] = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    const shown = await showBatch(t.pool, s.tenantId, b.id);
    expect(shown.errors.map((e) => [e.rowOrdinal, e.column, e.code])).toEqual([[null, 'ProviderName', 'MISSING_REQUIRED_COLUMN']]);
  });
});

describe('D4 the match is exact end to end', () => {
  it('case and whitespace variants and the long name are excluded', async () => {
    const s = await awsSource();
    const r = await sync(
      s,
      new FakeFocusSource([
        period([
          [
            'run/x.csv.gz',
            csvGz([
              row('AWS', '1.00', 'ok'),
              row('aws', '2.00', 'lower'),
              row('AWS ', '3.00', 'trailing'),
              row(' AWS', '4.00', 'leading'),
              row('Amazon Web Services', '5.00', 'long'),
              row('AWSX', '6.00', 'prefix'),
            ]),
          ],
        ]),
      ]),
    );
    expect(r.periods[0]).toMatchObject({ outcome: 'published', rowCount: '1', billedTotal: '1.00', excludedRows: '5' });
    const shown = await showBatch(t.pool, s.tenantId, r.periods[0].batchId!);
    expect(shown.errors.map((e) => [e.rowOrdinal, e.code])).toEqual([
      ['2', 'PROVIDER_MISMATCH'],
      ['3', 'PROVIDER_MISMATCH'],
      ['4', 'PROVIDER_MISMATCH'],
      ['5', 'PROVIDER_MISMATCH'],
      ['6', 'PROVIDER_MISMATCH'],
    ]);
  });
});

describe('D5 a mismatch together with another error', () => {
  it('quarantines the whole batch VALIDATION_FAILED and counts both', async () => {
    const s = await awsSource();
    const r = await sync(s, new FakeFocusSource([period([['run/x.csv.gz', csvGz([row('Microsoft', '1.00', 'm1'), row('AWS', 'abc', 'bad'), row('AWS', '1.00', 'a1')])]])]));
    expect(r.periods[0]).toMatchObject({ outcome: 'quarantined', code: 'VALIDATION_FAILED' });
    const [b] = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(b).toMatchObject({ status: 'quarantined', error_count: '2' });
    expect(b.quarantine_reason).toBe('VALIDATION_FAILED: 2 validation error(s) (PROVIDER_MISMATCH x1, UNPARSEABLE_NUMBER x1)');
    const shown = await showBatch(t.pool, s.tenantId, b.id);
    expect(shown.errors.map((e) => [e.rowOrdinal, e.column, e.code])).toEqual([
      ['1', 'ProviderName', 'PROVIDER_MISMATCH'],
      ['2', 'BilledCost', 'UNPARSEABLE_NUMBER'],
    ]);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
  });

  it('an unsupported artifact still names the batch UNSUPPORTED_FORMAT when a mismatch was recorded first', async () => {
    const s = await awsSource();
    const r = await sync(s, new FakeFocusSource([period([['a/x.csv.gz', csvGz([row('Oracle', '1.00', 'o1'), row('AWS', '1.00', 'a1')])], ['b/y.parquet', Buffer.from('PAR1')]])]));
    expect(r.periods[0]).toMatchObject({ outcome: 'quarantined', code: 'UNSUPPORTED_FORMAT' });
    expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId))[0]).toMatchObject({ error_count: '2' });
  });
});

describe('D6 manifest controls that count the foreign rows', () => {
  it('disagree with the loaded batch ⇒ RECONCILIATION_VARIANCE (fail closed), nothing published', async () => {
    const s = await awsSource();
    const r = await sync(s, new FakeFocusSource([period([['run/x.csv.gz', csvGz([row('AWS', '1.00', 'a1'), row('Microsoft', '2.00', 'm1')])]], { rowCount: 2, billedTotal: '3.00' })]));
    expect(r.periods[0]).toMatchObject({ outcome: 'quarantined', code: 'RECONCILIATION_VARIANCE', reconciliation: 'variance' });
    const [b] = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(b).toMatchObject({ status: 'quarantined', error_count: '1', row_count: '1', loaded: '1.00' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
  });
});

describe('D11 which controls see the exclusions (challenger L1)', () => {
  const mixed = () => csvGz([row('AWS', '1.00', 'a1'), row('Microsoft', '2.00', 'm1')]);

  it('set-level controls (rowCount, billedTotal) count PUBLISHED rows: controls equal to the AWS subset reconcile', async () => {
    const s = await awsSource();
    const r = await sync(s, new FakeFocusSource([period([['run/x.csv.gz', mixed()]], { rowCount: 1, billedTotal: '1.00' })]));
    expect(r.periods[0]).toMatchObject({ outcome: 'published', rowCount: '1', billedTotal: '1.00', reconciliation: 'reconciled', excludedRows: '1' });
  });

  it('per-artifact artifactRowCounts count EVERY row seen, excluded rows included: a count of all records matches', async () => {
    const s = await awsSource();
    // Only one of two artifacts has a count, so no set-level row count is derived from them.
    const r = await sync(
      s,
      new FakeFocusSource([period([['run/a.csv.gz', mixed()], ['run/b.csv.gz', csvGz([row('AWS', '3.00', 'a2')])]], { artifactRowCounts: { 'run/a.csv.gz': 2 } })]),
    );
    expect(r.periods[0]).toMatchObject({ outcome: 'published', rowCount: '2', billedTotal: '4.00', reconciliation: 'unverified', excludedRows: '1' });
  });

  it('per-artifact counts of the AWS rows only do NOT match (they must count every record)', async () => {
    const s = await awsSource();
    const r = await sync(
      s,
      new FakeFocusSource([period([['run/a.csv.gz', mixed()], ['run/b.csv.gz', csvGz([row('AWS', '3.00', 'a2')])]], { artifactRowCounts: { 'run/a.csv.gz': 1 } })]),
    );
    expect(r.periods[0]).toMatchObject({ outcome: 'quarantined', code: 'RECONCILIATION_VARIANCE' });
  });

  it('per-artifact counts covering EVERY artifact define the set-level row count (all records) ⇒ with exclusions, RECONCILIATION_VARIANCE', async () => {
    const s = await awsSource();
    const r = await sync(s, new FakeFocusSource([period([['run/x.csv.gz', mixed()]], { artifactRowCounts: { 'run/x.csv.gz': 2 } })]));
    expect(r.periods[0]).toMatchObject({ outcome: 'quarantined', code: 'RECONCILIATION_VARIANCE', reconciliation: 'variance' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
  });
});

describe('D12 a batch published under an earlier policy is not re-checked (challenger L4; documents the gap)', () => {
  it('identical bytes stay published after the policy tightens: sync skips, backfill and replay --period find the batch unchanged', async () => {
    const s = await awsSource();
    const source = new FakeFocusSource([period([['run/x.csv.gz', csvGz([row('SyntheticCloud', '1.00', 's1'), row('AWS', '2.00', 'a1')])]])]);
    expect((await sync(s, source, { settings: { allowSyntheticProviders: true } })).periods[0]).toMatchObject({ outcome: 'published', rowCount: '2' });
    const off = { settings: { allowSyntheticProviders: false } };
    expect((await sync(s, source, off)).periods[0]).toMatchObject({ outcome: 'skipped_unchanged' });
    expect((await sync(s, source, { ...off, mode: 'backfill', range: { from: P, to: P } })).periods[0]).toMatchObject({ outcome: 'unchanged' });
    expect((await sync(s, source, { ...off, mode: 'replay_period', range: { from: P, to: P } })).periods[0]).toMatchObject({ outcome: 'unchanged' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 2, total: '3.00' } });
  });

  it('new bytes for the period ARE checked under the current policy', async () => {
    const s = await awsSource();
    const source = new FakeFocusSource([period([['run1/x.csv.gz', csvGz([row('SyntheticCloud', '1.00', 's1'), row('AWS', '2.00', 'a1')])]])]);
    await sync(s, source, { settings: { allowSyntheticProviders: true } });
    // A re-delivered export: different bytes (the batch key is the data fingerprint, not the name).
    source.setPeriods([period([['run2/x.csv.gz', csvGz([row('SyntheticCloud', '1.00', 's1-v2'), row('AWS', '2.00', 'a1')])]])]);
    expect((await sync(s, source, { settings: { allowSyntheticProviders: false } })).periods[0]).toMatchObject({ outcome: 'published', rowCount: '1', excludedRows: '1' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 1, total: '2.00' } });
  });
});

describe('D7 the fake (synthetic) source type', () => {
  it('excludes AWS rows: only the synthetic provider is allowed', async () => {
    const s = await seedTenantSource(t.db.pool, { kind: 'fake', config: { fixture: 'synthetic-base' } });
    const r = await sync(s, new FakeFocusSource([period([['run/x.csv.gz', csvGz([row('SyntheticCloud', '1.00', 's1'), row('AWS', '2.00', 'a1')])]])]), {
      settings: { allowSyntheticProviders: true },
    });
    expect(r.periods[0]).toMatchObject({ outcome: 'published', rowCount: '1', billedTotal: '1.00', excludedRows: '1' });
    const shown = await showBatch(t.pool, s.tenantId, r.periods[0].batchId!);
    expect(shown.errors.map((e) => [e.rowOrdinal, e.code, e.message])).toEqual([
      ['2', 'PROVIDER_MISMATCH', 'ProviderName is not allowed for source type fake (allowed: SyntheticCloud, SyntheticAWS, SyntheticAzure, SyntheticGCP); row excluded'],
    ]);
  });
});

describe('D8 a source without a recognised type is not checked (DESIGN §8 D4)', () => {
  it('focus_file without the aws-data-exports layout (unreachable from the CLI) keeps the Slice 1 behaviour', async () => {
    const s = await seedTenantSource(t.db.pool, { kind: 'focus_file', config: {} });
    const r = await sync(s, new FakeFocusSource([period([['run/x.csv.gz', csvGz([row('Microsoft', '2.00', 'm1'), row('', '1.00', 'n1')])]])]));
    expect(r.periods[0]).toMatchObject({ outcome: 'published', rowCount: '2', billedTotal: '3.00' });
    expect(r.periods[0]).not.toHaveProperty('excludedRows');
  });
});

describe('D9 synthetic providers need the explicit opt-in (orchestrator decision D1, 2026-10-04)', () => {
  const synthetic = () => new FakeFocusSource([period([['run/x.csv.gz', csvGz([row('SyntheticCloud', '1.00', 's1'), row('AWS', '2.00', 'a1')])]])]);

  it('opt-in OFF: SyntheticCloud under aws-data-exports is excluded (PROVIDER_MISMATCH); AWS is published', async () => {
    const s = await awsSource();
    const r = await sync(s, synthetic(), { settings: { allowSyntheticProviders: false } });
    expect(r.periods[0]).toMatchObject({ outcome: 'published', rowCount: '1', billedTotal: '2.00', excludedRows: '1' });
    const shown = await showBatch(t.pool, s.tenantId, r.periods[0].batchId!);
    expect(shown.errors.map((e) => [e.rowOrdinal, e.code, e.message])).toEqual([
      ['1', 'PROVIDER_MISMATCH', 'ProviderName is not allowed for source type aws-data-exports (allowed: AWS); row excluded'],
    ]);
  });

  it('opt-in OFF: an all-synthetic batch is quarantined PROVIDER_MISMATCH, never published', async () => {
    const s = await awsSource();
    const r = await sync(s, new FakeFocusSource([period([['run/x.csv.gz', csvGz([row('SyntheticCloud', '1.00', 's1')])]])]), { settings: { allowSyntheticProviders: false } });
    expect(r.periods[0]).toMatchObject({ outcome: 'quarantined', code: 'PROVIDER_MISMATCH' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
  });

  it('opt-in ON: SyntheticCloud is accepted', async () => {
    const s = await awsSource();
    const r = await sync(s, synthetic(), { settings: { allowSyntheticProviders: true } });
    expect(r.periods[0]).toMatchObject({ outcome: 'published', rowCount: '2', billedTotal: '3.00' });
    expect(r.periods[0]).not.toHaveProperty('excludedRows');
  });

  it('the fixed synthetic set: OFF ⇒ each excluded; ON ⇒ each accepted; real foreign names still excluded with it ON', async () => {
    const rows = [
      row('SyntheticCloud', '1.00', 's1'),
      row('SyntheticAWS', '2.00', 's2'),
      row('SyntheticAzure', '3.00', 's3'),
      row('SyntheticGCP', '4.00', 's4'),
      row('AWS', '5.00', 'a1'),
      row('Microsoft', '6.00', 'm1'),
      row('Amazon Web Services', '7.00', 'l1'),
    ];
    const off = await awsSource();
    const rOff = await sync(off, new FakeFocusSource([period([['run/x.csv.gz', csvGz(rows)]])]), { settings: { allowSyntheticProviders: false } });
    expect(rOff.periods[0]).toMatchObject({ outcome: 'published', rowCount: '1', billedTotal: '5.00', excludedRows: '6' });
    const on = await awsSource();
    const rOn = await sync(on, new FakeFocusSource([period([['run/x.csv.gz', csvGz(rows)]])]), { settings: { allowSyntheticProviders: true } });
    expect(rOn.periods[0]).toMatchObject({ outcome: 'published', rowCount: '5', billedTotal: '15.00', excludedRows: '2' });
    const shown = await showBatch(t.pool, on.tenantId, rOn.periods[0].batchId!);
    expect(shown.errors.map((e) => [e.rowOrdinal, e.code])).toEqual([
      ['6', 'PROVIDER_MISMATCH'],
      ['7', 'PROVIDER_MISMATCH'],
    ]);
  });

  it('library default: follows RATIO_ALLOW_SYNTHETIC_PROVIDERS of the process (the DB suites set it in their vitest config); unset ⇒ OFF', async () => {
    expect(process.env.RATIO_ALLOW_SYNTHETIC_PROVIDERS).toBe('1');
    const run = (s: SeededSource) =>
      runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source: synthetic(), evidence: new MemoryEvidenceStore(), mode: 'sync', hooks: noSleep });
    const on = await awsSource();
    expect((await run(on)).periods[0]).toMatchObject({ outcome: 'published', rowCount: '2' });
    const prev = process.env.RATIO_ALLOW_SYNTHETIC_PROVIDERS;
    delete process.env.RATIO_ALLOW_SYNTHETIC_PROVIDERS;
    try {
      const off = await awsSource();
      expect((await run(off)).periods[0]).toMatchObject({ outcome: 'published', rowCount: '1', excludedRows: '1' });
    } finally {
      process.env.RATIO_ALLOW_SYNTHETIC_PROVIDERS = prev;
    }
  });

  it('L3 library default: the process opt-in without an explicit development/test RATIO_ENV refuses the run', async () => {
    expect(process.env.RATIO_ENV).toBe('test');
    const prev = process.env.RATIO_ENV;
    for (const ratioEnv of [undefined, 'staging', 'production']) {
      if (ratioEnv === undefined) delete process.env.RATIO_ENV;
      else process.env.RATIO_ENV = ratioEnv;
      try {
        const s = await awsSource();
        await expect(
          runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source: synthetic(), evidence: new MemoryEvidenceStore(), mode: 'sync', hooks: noSleep }),
          String(ratioEnv),
        ).rejects.toMatchObject({ code: 'SYNTHETIC_PROVIDERS_NOT_ALLOWED' });
        expect(await batchesOf(t.db.pool, s.tenantId, s.sourceId), String(ratioEnv)).toEqual([]);
      } finally {
        process.env.RATIO_ENV = prev;
      }
    }
  });
});

describe('D10 the worker CLI: the opt-in comes from its env only, and is logged once at startup', () => {
  let evidence: TestBucket;
  beforeAll(async () => {
    requireTestS3Endpoint();
    evidence = await createTestBucket('ev62');
  });
  afterAll(async () => {
    await evidence?.destroy();
  });
  const cliEnv = (optIn: string) => ({
    RATIO_DATABASE_URL: t.login.url,
    ...testS3Env(evidence),
    NODE_ENV: 'test',
    RATIO_ALLOW_FAKE_SOURCE: '1',
    RATIO_ALLOW_SYNTHETIC_PROVIDERS: optIn,
  });
  const optInLogs = (err: string[]) => err.map((l) => JSON.parse(l)).filter((l) => l.event === 'config.synthetic_providers_allowed');

  it('L3: the opt-in with RATIO_ENV staging, production or unset is refused at startup (config error), nothing ingested', async () => {
    expect(testS3Env(evidence).RATIO_ENV).toBe('development');
    const s = await seedTenantSource(t.db.pool, { kind: 'fake', config: { fixture: 'synthetic-base' } });
    for (const ratioEnv of ['staging', 'production', undefined]) {
      const env: Record<string, string | undefined> = { ...cliEnv('1'), RATIO_ENV: ratioEnv };
      const r = await cli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], env);
      expect(r.code, String(ratioEnv)).toBe(2);
      expect(r.out.concat(r.err).join('\n'), String(ratioEnv)).toContain('SYNTHETIC_PROVIDERS_NOT_ALLOWED');
    }
    expect(await batchesOf(t.db.pool, s.tenantId, s.sourceId)).toEqual([]);
  });

  it('OFF ("0"): the synthetic fixture is quarantined PROVIDER_MISMATCH, nothing is published, no opt-in log', async () => {
    const s = await seedTenantSource(t.db.pool, { kind: 'fake', config: { fixture: 'synthetic-base' } });
    const r = await cli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], cliEnv('0'));
    expect(r.code).toBe(1);
    const periods = (r.record.results as { periods: Array<{ outcome: string; code?: string }> }).periods;
    expect(periods.length).toBeGreaterThan(0);
    for (const p of periods) expect(p).toMatchObject({ outcome: 'quarantined', code: 'PROVIDER_MISMATCH' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
    expect(optInLogs(r.err)).toEqual([]);
  });

  it('ON ("1"): published, and the opt-in is logged exactly once, with the size of the set but no provider name (Slice 1 K1: logs carry no row values)', async () => {
    const s = await seedTenantSource(t.db.pool, { kind: 'fake', config: { fixture: 'synthetic-base' } });
    const r = await cli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], cliEnv('1'));
    expect(r.code).toBe(0);
    const logs = optInLogs(r.err);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'warn', syntheticProviderCount: 4 });
    const all = r.out.concat(r.err).join('\n');
    for (const name of ['SyntheticCloud', 'SyntheticAWS', 'SyntheticAzure', 'SyntheticGCP']) expect(all).not.toContain(name);
  });
});

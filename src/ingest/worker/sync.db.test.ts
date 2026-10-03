// Worker library against real Postgres (as a real ratio_worker login) with the
// deterministic FakeFocusSource and an in-memory evidence store.
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource, type FakePeriod } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { runSync, type RunSyncOptions } from './pipeline';
import { showBatch } from './quarantine';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations } from '../db/migrationFiles';
import { migrationStatus } from '../db/migrate';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import { batchesOf, checkpointOf, publishedAs, publishedTotals, runsOf, seedTenantSource, type SeededSource } from '../testing/db';
import { FOCUS_HEADER, csvGz, focusRow, gz, rowsOf, toCsv } from '../testing/focusCsv';

let t: WorkerTestDb;
beforeAll(async () => {
  t = await workerTestDb();
});
afterAll(async () => {
  await t.close();
});

const P = '2026-07-01';
const P2 = '2026-08-01';
const P3 = '2026-09-01';
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const setFingerprint = (parts: Buffer[]) => sha(Buffer.from(parts.map(sha).sort().join('\n')));

function period(billingPeriod: string, artifacts: Array<[string, Buffer]>, control?: FakePeriod['control']): FakePeriod {
  return { billingPeriod, artifacts: artifacts.map(([name, bytes]) => ({ name, bytes })), control };
}

async function sync(s: SeededSource, source: FakeFocusSource, extra: Partial<RunSyncOptions> = {}, evidence = new MemoryEvidenceStore()) {
  return runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source, evidence, mode: 'sync', hooks: noSleep, ...extra });
}

describe('sync: publish path', () => {
  it('W1 clean load publishes one batch; evidence stored and re-hashes; checkpoint records the fingerprint; logs carry no row contents', async () => {
    const s = await seedTenantSource(t.db.pool);
    const a1 = csvGz(rowsOf(P, 3, '1.10', 'secretres'));
    const a2 = csvGz(rowsOf(P, 2, '0.2', 'other'));
    const source = new FakeFocusSource([period(P, [['run-1/part-1.csv.gz', a1], ['run-1/part-2.csv.gz', a2]])]);
    const evidence = new MemoryEvidenceStore();
    const logs: string[] = [];
    const r = await sync(s, source, { log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })) }, evidence);

    expect(r.status).toBe('succeeded');
    expect(r.periods).toEqual([expect.objectContaining({ billingPeriod: P, outcome: 'published', reconciliation: 'unverified' })]);
    const batches = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ status: 'published', reconciliation: 'unverified', row_count: '5', loaded: '3.70', is_provisional: false });
    expect(batches[0].fingerprint).toBe(setFingerprint([a1, a2]));
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 5, total: '3.70' } });
    expect(await publishedAs(t.db.pool, 'ratio_reader', s.tenantId)).toMatchObject({ rows: 5, total: '3.70' });

    const arts = await t.db.pool.query(
      `SELECT artifact_name, sha256, byte_size::int AS size, row_count::int AS rows, evidence_key FROM ratio.ingest_artifacts WHERE tenant_id = $1 ORDER BY artifact_name`,
      [s.tenantId],
    );
    expect(arts.rows).toEqual([
      { artifact_name: 'run-1/part-1.csv.gz', sha256: sha(a1), size: a1.length, rows: 3, evidence_key: `evidence/${s.tenantId}/${s.sourceId}/${sha(a1)}` },
      { artifact_name: 'run-1/part-2.csv.gz', sha256: sha(a2), size: a2.length, rows: 2, evidence_key: `evidence/${s.tenantId}/${s.sourceId}/${sha(a2)}` },
    ]);
    for (const a of arts.rows) {
      const stored = evidence.objects.get(a.evidence_key)!;
      expect(sha(stored)).toBe(a.sha256);
    }
    const cp = await checkpointOf(t.db.pool, s.tenantId, s.sourceId);
    expect(cp?.[P]).toMatchObject({ fingerprint: setFingerprint([a1, a2]), batchId: batches[0].id });
    const runs = await runsOf(t.db.pool, s.tenantId, s.sourceId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ run_kind: 'scheduled', status: 'succeeded', error_code: null });

    const allLogs = logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(allLogs).not.toContain('secretres');
    expect(allLogs).not.toContain('SyntheticCloud');
    expect(allLogs).not.toContain('Synthetic Compute');
  });

  it('W2 idempotency: same input twice ⇒ one batch, identical totals, second run skips without downloading; backfill ⇒ unchanged', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([period(P, [['run-1/a.csv.gz', csvGz(rowsOf(P, 4, '2.5'))]])]);
    const evidence = new MemoryEvidenceStore();
    const first = await sync(s, source, {}, evidence);
    const totals1 = await publishedTotals(t.db.pool, s.tenantId, s.sourceId);
    const opened = source.opened.length;
    const second = await sync(s, source, {}, evidence);
    expect(first.periods[0].outcome).toBe('published');
    expect(second.status).toBe('succeeded');
    expect(second.periods[0].outcome).toBe('skipped_unchanged');
    expect(source.opened.length).toBe(opened);
    const third = await sync(s, source, { mode: 'backfill', range: { from: P, to: P } }, evidence);
    expect(third.periods[0].outcome).toBe('unchanged');
    expect(await batchesOf(t.db.pool, s.tenantId, s.sourceId)).toHaveLength(1);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual(totals1);
    expect(totals1).toEqual({ [P]: { rows: 4, total: '10.0' } });
    expect((await runsOf(t.db.pool, s.tenantId, s.sourceId)).map((r) => [r.run_kind, r.status])).toEqual([
      ['scheduled', 'succeeded'],
      ['scheduled', 'succeeded'],
      ['backfill', 'succeeded'],
    ]);
  });

  it('W3 duplicate legitimate rows (same file and across files) are all stored and summed', async () => {
    const s = await seedTenantSource(t.db.pool);
    const same = focusRow(P, { BilledCost: '1.25' });
    const a1 = csvGz([same, same, same]);
    const a2 = csvGz([same, focusRow(P, { BilledCost: '0.75', ResourceId: 'x' })]);
    const r = await sync(s, new FakeFocusSource([period(P, [['r/a.csv.gz', a1], ['r/b.csv.gz', a2]])]));
    expect(r.periods[0].outcome).toBe('published');
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 5, total: '5.75' } });
    const identical = await t.db.pool.query(
      `SELECT count(*)::int AS n FROM ratio.cost_facts WHERE tenant_id = $1 AND billed_cost = 1.25 AND resource_id = 'res-synthetic-1'`,
      [s.tenantId],
    );
    expect(identical.rows[0].n).toBe(4);
  });

  it('W4 restatement supersedes the period (no double count); W5 a revert re-publishes the retained batch', async () => {
    const s = await seedTenantSource(t.db.pool);
    const v1 = csvGz(rowsOf(P, 2, '10.00'));
    const v2 = csvGz([...rowsOf(P, 2, '10.00'), focusRow(P, { BilledCost: '-3.50', ChargeCategory: 'Credit', ResourceId: 'credit' })]);
    const source = new FakeFocusSource([period(P, [['run-1/a.csv.gz', v1]])]);
    await sync(s, source);
    source.setPeriods([period(P, [['run-2/a.csv.gz', v2]])]);
    const r2 = await sync(s, source);
    expect(r2.periods[0].outcome).toBe('published');
    let batches = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(batches.map((b) => b.status)).toEqual(['superseded', 'published']);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 3, total: '16.50' } });
    expect(await publishedAs(t.db.pool, 'ratio_reader', s.tenantId)).toMatchObject({ rows: 3, total: '16.50', batches: [batches[1].id] });
    expect((await checkpointOf(t.db.pool, s.tenantId, s.sourceId))?.[P]).toMatchObject({ fingerprint: setFingerprint([v2]), batchId: batches[1].id });

    source.setPeriods([period(P, [['run-3/a.csv.gz', v1]])]);
    const r3 = await sync(s, source);
    expect(r3.periods[0].outcome).toBe('republished');
    batches = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(batches.map((b) => b.status)).toEqual(['published', 'superseded']);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 2, total: '20.00' } });
  });

  it('W12 provisional flag: current month true, previous month false', async () => {
    const s = await seedTenantSource(t.db.pool);
    const m = await t.db.pool.query(
      `SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS cur,
              to_char(date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month', 'YYYY-MM-DD') AS prev`,
    );
    const { cur, prev } = m.rows[0] as { cur: string; prev: string };
    await sync(s, new FakeFocusSource([period(prev, [['r/a.csv.gz', csvGz(rowsOf(prev, 1))]]), period(cur, [['r/b.csv.gz', csvGz(rowsOf(cur, 1))]])]));
    const batches = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(Object.fromEntries(batches.map((b) => [b.period, b.is_provisional]))).toEqual({ [prev]: false, [cur]: true });
  });

  it('W13 incremental skips unchanged periods without opening them; backfill touches only the range', async () => {
    const s = await seedTenantSource(t.db.pool);
    const p1 = csvGz(rowsOf(P, 1, '1'));
    const source = new FakeFocusSource([period(P, [['r/p1.csv.gz', p1]]), period(P2, [['r/p2.csv.gz', csvGz(rowsOf(P2, 1, '2'))]])]);
    await sync(s, source);
    source.setPeriods([
      period(P, [['r/p1.csv.gz', p1]]),
      period(P2, [['r2/p2.csv.gz', csvGz(rowsOf(P2, 2, '2'))]]),
      period(P3, [['r/p3.csv.gz', csvGz(rowsOf(P3, 1, '3'))]]),
    ]);
    source.opened.length = 0;
    const r = await sync(s, source);
    expect(Object.fromEntries(r.periods.map((p) => [p.billingPeriod, p.outcome]))).toEqual({ [P]: 'skipped_unchanged', [P2]: 'published', [P3]: 'published' });
    expect(source.opened.sort()).toEqual(['r/p3.csv.gz', 'r2/p2.csv.gz']);

    source.opened.length = 0;
    const b = await sync(s, source, { mode: 'backfill', range: { from: P2, to: P2 } });
    expect(b.periods.map((p) => [p.billingPeriod, p.outcome])).toEqual([[P2, 'unchanged']]);
    expect(source.opened).toEqual(['r2/p2.csv.gz']);
    const run = (await runsOf(t.db.pool, s.tenantId, s.sourceId)).at(-1)!;
    expect(run).toMatchObject({ run_kind: 'backfill', period_from: P2, period_to: P2 });
  });

  it('W14 a listing failure fails the run visibly, other periods still publish, failed period not checkpointed', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([
      { billingPeriod: P, error: { code: 'MANIFEST_INVALID', message: 'manifest refers to s3://other/x?X-Amz-Signature=leak' } },
      period(P2, [['r/a.csv.gz', csvGz(rowsOf(P2, 1))]]),
    ]);
    const r = await sync(s, source);
    expect(r.status).toBe('failed');
    expect(r.errorCode).toBe('MANIFEST_INVALID');
    expect(Object.fromEntries(r.periods.map((p) => [p.billingPeriod, p.outcome]))).toEqual({ [P]: 'failed', [P2]: 'published' });
    const cp = await checkpointOf(t.db.pool, s.tenantId, s.sourceId);
    expect(Object.keys(cp ?? {})).toEqual([P2]);
    const run = (await runsOf(t.db.pool, s.tenantId, s.sourceId))[0];
    expect(run).toMatchObject({ status: 'failed', error_code: 'MANIFEST_INVALID' });
    expect(run.error_detail).not.toContain('leak');
    expect(JSON.stringify(run.stats)).not.toContain('X-Amz-Signature=leak');
  });

  it('W16 the worker runs against exactly the shipped schema version', async () => {
    const c = await t.db.pool.connect();
    try {
      const st = await migrationStatus(c);
      expect(st.matches).toBe(true);
      expect(st.currentVersion).toBe(loadMigrations(DEFAULT_MIGRATIONS_DIR).at(-1)!.version);
    } finally {
      c.release();
    }
    const s = await seedTenantSource(t.db.pool);
    const r = await sync(s, new FakeFocusSource([period(P, [['r/a.csv.gz', csvGz(rowsOf(P, 1))]])]));
    expect(r.status).toBe('succeeded');
  });
});

describe('sync: reconciliation', () => {
  it('W6 matching control ⇒ reconciled and published (numeric, not string, compare)', async () => {
    const s = await seedTenantSource(t.db.pool);
    const r = await sync(s, new FakeFocusSource([period(P, [['r/a.csv.gz', csvGz(rowsOf(P, 2, '1.25'))]], { rowCount: 2, billedTotal: '2.5' })]));
    expect(r.periods[0]).toMatchObject({ outcome: 'published', reconciliation: 'reconciled' });
    expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId))[0]).toMatchObject({ status: 'published', reconciliation: 'reconciled', control_rows: '2', control_total: '2.5' });
  });

  // Amended 0001 (orchestrator round 2): `reconciled` ⇔ at least one control and every present control matches.
  it('W8 no control ⇒ unverified and published; a partial (row-count only) agreeing control ⇒ reconciled', async () => {
    const s = await seedTenantSource(t.db.pool);
    await sync(s, new FakeFocusSource([period(P, [['r/a.csv.gz', csvGz(rowsOf(P, 2))]]), period(P2, [['r/b.csv.gz', csvGz(rowsOf(P2, 2))]], { rowCount: 2 })]));
    const b = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(b.map((x) => [x.period, x.status, x.reconciliation])).toEqual([
      [P, 'published', 'unverified'],
      [P2, 'published', 'reconciled'],
    ]);
  });

  const variances: Array<[string, FakePeriod['control']]> = [
    ['row count', { rowCount: 3, billedTotal: '2.50' }],
    ['billed total', { rowCount: 2, billedTotal: '2.51' }],
    ['row count only', { rowCount: 1 }],
    ['billed total only', { billedTotal: '2.49' }],
    ['per-artifact row count', { artifactRowCounts: { 'r2/a.csv.gz': 3 } }],
  ];
  for (const [name, control] of variances) {
    it(`W7 ${name} mismatch ⇒ quarantined variance, prior publication and checkpoint untouched`, async () => {
      const s = await seedTenantSource(t.db.pool);
      const good = csvGz(rowsOf(P, 1, '9.99'));
      const source = new FakeFocusSource([period(P, [['r1/a.csv.gz', good]])]);
      await sync(s, source);
      const before = await publishedTotals(t.db.pool, s.tenantId, s.sourceId);
      const cpBefore = await checkpointOf(t.db.pool, s.tenantId, s.sourceId);
      source.setPeriods([period(P, [['r2/a.csv.gz', csvGz(rowsOf(P, 2, '1.25'))]], control)]);
      const r = await sync(s, source);
      expect(r.status).toBe('failed');
      expect(r.periods[0]).toMatchObject({ outcome: 'quarantined', code: 'RECONCILIATION_VARIANCE', reconciliation: 'variance' });
      const b = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
      expect(b.map((x) => [x.status, x.reconciliation])).toEqual([
        ['published', 'unverified'],
        ['quarantined', 'variance'],
      ]);
      expect(b[1].quarantine_reason).toContain('RECONCILIATION_VARIANCE');
      expect(b[1].loaded).toBe('2.50');
      expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual(before);
      expect(await checkpointOf(t.db.pool, s.tenantId, s.sourceId)).toEqual(cpBefore);
    });
  }

  it('W7b a per-artifact count for only some artifacts that disagrees ⇒ quarantined (no set-level control to store, so reconciliation stays unverified)', async () => {
    const s = await seedTenantSource(t.db.pool);
    const r = await sync(
      s,
      new FakeFocusSource([period(P, [['r/a.csv.gz', csvGz(rowsOf(P, 2))], ['r/b.csv.gz', csvGz(rowsOf(P, 1, '1.25', 'b'))]], { artifactRowCounts: { 'r/a.csv.gz': 5 } })]),
    );
    expect(r.periods[0]).toMatchObject({ outcome: 'quarantined', code: 'RECONCILIATION_VARIANCE' });
    const b = (await batchesOf(t.db.pool, s.tenantId, s.sourceId))[0];
    expect(b).toMatchObject({ status: 'quarantined', reconciliation: 'unverified', control_rows: null });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
  });

  it('W7c per-artifact counts covering every artifact become the set-level control row count', async () => {
    const s = await seedTenantSource(t.db.pool);
    const r = await sync(
      s,
      new FakeFocusSource([period(P, [['r/a.csv.gz', csvGz(rowsOf(P, 2))], ['r/b.csv.gz', csvGz(rowsOf(P, 1, '1.25', 'b'))]], { artifactRowCounts: { 'r/a.csv.gz': 2, 'r/b.csv.gz': 1 } })]),
    );
    expect(r.periods[0]).toMatchObject({ outcome: 'published', reconciliation: 'reconciled' });
    expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId))[0]).toMatchObject({ control_rows: '3', reconciliation: 'reconciled' });
  });

  it('W15 same bytes but a disagreeing control ⇒ failed visibly, publication untouched', async () => {
    const s = await seedTenantSource(t.db.pool);
    const a = csvGz(rowsOf(P, 2, '1.25'));
    const source = new FakeFocusSource([period(P, [['r/a.csv.gz', a]], { rowCount: 2, billedTotal: '2.50' })]);
    await sync(s, source);
    source.setPeriods([period(P, [['r/a.csv.gz', a]], { rowCount: 3, billedTotal: '2.50' })]);
    const r = await sync(s, source, { mode: 'backfill', range: { from: P, to: P } });
    expect(r.status).toBe('failed');
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'CONTROL_VARIANCE_ON_UNCHANGED' });
    expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId)).map((b) => b.status)).toEqual(['published']);
  });
});

describe('sync: bad input ⇒ quarantined, nothing published', () => {
  const header = [...FOCUS_HEADER];
  const without = (col: string) => header.filter((h) => h !== col);
  type Case = { name: string; artifacts: () => Array<[string, Buffer]>; code: string; rowLevel: boolean; limits?: Record<string, number>; leak?: string };
  const cases: Case[] = [
    ...['BilledCost', 'BillingCurrency', 'ChargePeriodStart', 'ChargePeriodEnd', 'BillingPeriodStart'].map((col) => ({
      name: `missing column ${col}`,
      artifacts: (): Array<[string, Buffer]> => [['r/a.csv.gz', csvGz(rowsOf(P, 2), without(col))]],
      code: 'MISSING_REQUIRED_COLUMN',
      rowLevel: true,
    })),
    { name: 'unparseable BilledCost', artifacts: () => [['r/a.csv.gz', csvGz([focusRow(P), focusRow(P, { BilledCost: '1,5' })])]], code: 'UNPARSEABLE_NUMBER', rowLevel: true },
    { name: 'NaN BilledCost', artifacts: () => [['r/a.csv.gz', csvGz([focusRow(P, { BilledCost: 'NaN' })])]], code: 'UNPARSEABLE_NUMBER', rowLevel: true },
    { name: 'unparseable date', artifacts: () => [['r/a.csv.gz', csvGz([focusRow(P, { ChargePeriodStart: 'tomorrow' })])]], code: 'UNPARSEABLE_TIMESTAMP', rowLevel: true },
    { name: 'impossible date', artifacts: () => [['r/a.csv.gz', csvGz([focusRow(P, { ChargePeriodEnd: '2026-07-32T00:00:00Z' })])]], code: 'UNPARSEABLE_TIMESTAMP', rowLevel: true },
    { name: 'row of another billing period', artifacts: () => [['r/a.csv.gz', csvGz([focusRow(P), focusRow(P, { BillingPeriodStart: '2026-06-01T00:00:00Z' })])]], code: 'PERIOD_MISMATCH', rowLevel: true },
    { name: 'inverted charge period', artifacts: () => [['r/a.csv.gz', csvGz([focusRow(P, { ChargePeriodStart: '2026-07-05T00:00:00Z', ChargePeriodEnd: '2026-07-04T00:00:00Z' })])]], code: 'CHARGE_PERIOD_INVERTED', rowLevel: true },
    { name: 'bad currency', artifacts: () => [['r/a.csv.gz', csvGz([focusRow(P, { BillingCurrency: 'US$' })])]], code: 'INVALID_CURRENCY', rowLevel: true },
    // Challenger M-2: values JS used to accept that Postgres rejects.
    { name: 'year 0000 timestamp', artifacts: () => [['r/a.csv.gz', csvGz([focusRow(P, { ChargePeriodStart: '0000-07-02T00:00:00Z' })])]], code: 'UNPARSEABLE_TIMESTAMP', rowLevel: true, leak: '0000-07-02' },
    { name: 'NUL in a mapped column', artifacts: () => [['r/a.csv.gz', csvGz([focusRow(P, { ResourceId: 'leakmarker-res\u0000x' })])]], code: 'INVALID_CHARACTER', rowLevel: true, leak: 'leakmarker-res' },
    { name: 'NUL in an extra column', artifacts: () => [['r/a.csv.gz', csvGz([focusRow(P, { Tags: '{"k":"leakmarker-tag\u0000"}' })])]], code: 'INVALID_CHARACTER', rowLevel: true, leak: 'leakmarker-tag' },
    { name: 'inconsistent column count', artifacts: () => [['r/a.csv.gz', gz(toCsv([focusRow(P)]) + '1.00,short\n')]], code: 'CSV_PARSE_ERROR', rowLevel: true },
    { name: 'invalid gzip', artifacts: () => [['r/a.csv.gz', Buffer.from('this is not gzip at all')]], code: 'INVALID_GZIP', rowLevel: true },
    { name: 'parquet artifact', artifacts: () => [['r/a.snappy.parquet', Buffer.from('PAR1....PAR1')]], code: 'UNSUPPORTED_FORMAT', rowLevel: true },
    { name: 'row limit exceeded', artifacts: () => [['r/a.csv.gz', csvGz(rowsOf(P, 3))]], code: 'ROW_LIMIT_EXCEEDED', rowLevel: true, limits: { maxRowsPerBatch: 2 } },
    { name: 'empty artifact set', artifacts: () => [], code: 'EMPTY_ARTIFACT_SET', rowLevel: false },
    { name: 'zero data rows', artifacts: () => [['r/a.csv.gz', csvGz([])]], code: 'EMPTY_BATCH', rowLevel: false },
    { name: 'mixed billing currencies', artifacts: () => [['r/a.csv.gz', csvGz([focusRow(P), focusRow(P, { BillingCurrency: 'EUR' })])]], code: 'MIXED_BILLING_CURRENCY', rowLevel: false },
    {
      name: 'byte-identical duplicate artifacts',
      artifacts: () => {
        const b = csvGz(rowsOf(P, 1));
        return [
          ['r/a.csv.gz', b],
          ['r/b.csv.gz', b],
        ];
      },
      code: 'DUPLICATE_ARTIFACT',
      rowLevel: false,
    },
  ];

  for (const c of cases) {
    it(`W9 ${c.name} ⇒ quarantined (${c.code}); prior publication, view and checkpoint untouched; no facts kept`, async () => {
      const s = await seedTenantSource(t.db.pool);
      const source = new FakeFocusSource([period(P, [['r0/good.csv.gz', csvGz(rowsOf(P, 1, '7.77'))]])]);
      await sync(s, source);
      const before = await publishedTotals(t.db.pool, s.tenantId, s.sourceId);
      const viewBefore = await publishedAs(t.db.pool, 'ratio_reader', s.tenantId);
      const cpBefore = await checkpointOf(t.db.pool, s.tenantId, s.sourceId);

      source.setPeriods([period(P, c.artifacts())]);
      const r = await sync(s, source, c.limits ? { settings: { limits: c.limits } } : {});
      expect(r.status).toBe('failed');
      expect(r.periods[0].outcome).toBe('quarantined');
      const b = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
      expect(b.map((x) => x.status)).toEqual(['published', 'quarantined']);
      expect(b[1].quarantine_reason).toContain(c.code);
      const facts = await t.db.pool.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE tenant_id = $1 AND batch_id = $2`, [s.tenantId, b[1].id]);
      expect(facts.rows[0].n).toBe(0);
      if (c.rowLevel) {
        const errs = await t.db.pool.query(`SELECT code FROM ratio.ingest_validation_errors WHERE tenant_id = $1 AND batch_id = $2`, [s.tenantId, b[1].id]);
        expect(errs.rows.map((e) => e.code)).toContain(c.code);
        expect(Number(b[1].error_count)).toBeGreaterThanOrEqual(1);
      }
      expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual(before);
      expect(await publishedAs(t.db.pool, 'ratio_reader', s.tenantId)).toEqual(viewBefore);
      expect(await checkpointOf(t.db.pool, s.tenantId, s.sourceId)).toEqual(cpBefore);
      const run = (await runsOf(t.db.pool, s.tenantId, s.sourceId)).at(-1)!;
      expect(run.status).toBe('failed');
      if (c.leak) {
        const persisted = await t.db.pool.query(
          `SELECT coalesce(string_agg(x, ' '), '') AS t FROM (
             SELECT error_detail || ' ' || stats::text AS x FROM ratio.sync_runs WHERE tenant_id = $1
             UNION ALL SELECT quarantine_reason FROM ratio.ingest_batches WHERE tenant_id = $1
             UNION ALL SELECT message FROM ratio.ingest_validation_errors WHERE tenant_id = $1) q`,
          [s.tenantId],
        );
        expect(persisted.rows[0].t).not.toContain(c.leak);
        expect(JSON.stringify(r)).not.toContain(c.leak);
      }

      // Deterministic: the same bad set again is not re-processed into a second batch.
      const again = await sync(s, source, c.limits ? { settings: { limits: c.limits } } : {});
      expect(again.periods[0]).toMatchObject({ outcome: 'failed', code: 'BATCH_QUARANTINED' });
      expect(await batchesOf(t.db.pool, s.tenantId, s.sourceId)).toHaveLength(2);
    });
  }

  it('W10 oversize artifact (by listing) ⇒ failed before download; nothing captured; checkpoint not advanced', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([period(P, [['r/a.csv.gz', csvGz(rowsOf(P, 50))]])]);
    const evidence = new MemoryEvidenceStore();
    const r = await sync(s, source, { settings: { limits: { maxArtifactBytes: 64 } } }, evidence);
    expect(r.status).toBe('failed');
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'ARTIFACT_SET_TOO_LARGE' });
    expect(source.opened).toEqual([]);
    expect(evidence.objects.size).toBe(0);
    expect(await batchesOf(t.db.pool, s.tenantId, s.sourceId)).toEqual([]);
    expect(await checkpointOf(t.db.pool, s.tenantId, s.sourceId)).toBeNull();
  });

  it('W11 validation errors: 1000 stored, true total counted; quarantine show returns them inspectably', async () => {
    const s = await seedTenantSource(t.db.pool);
    const rows = [...rowsOf(P, 5), ...Array.from({ length: 1205 }, (_, i) => focusRow(P, { BilledCost: 'bad', ResourceId: `b${i}` }))];
    const r = await sync(s, new FakeFocusSource([period(P, [['r/a.csv.gz', csvGz(rows)]])]));
    expect(r.periods[0].outcome).toBe('quarantined');
    const b = (await batchesOf(t.db.pool, s.tenantId, s.sourceId))[0];
    expect(b.error_count).toBe('1205');
    const report = await showBatch(t.pool, s.tenantId, b.id);
    expect(report.batch).toMatchObject({ id: b.id, status: 'quarantined', validationErrorCount: '1205', storedErrorCount: 1000, billingPeriod: P });
    expect(report.errors).toHaveLength(1000);
    expect(report.errors[0]).toMatchObject({ ordinal: 1, rowOrdinal: '6', column: 'BilledCost', code: 'UNPARSEABLE_NUMBER' });
    expect(report.errors[0].artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.batch.artifacts).toEqual([expect.objectContaining({ name: 'r/a.csv.gz', evidenceKey: expect.stringMatching(/^evidence\//) })]);
    expect(JSON.stringify(report)).not.toContain('"bad"');
  });
});

describe('Postgres-rejected values never leak and never strand a batch (M-2)', () => {
  // Superuser-installed test triggers make Postgres itself reject marked rows, so
  // these cover values the validator does not catch. Message text includes the value.
  beforeAll(async () => {
    await t.db.pool.query(`
      CREATE FUNCTION public.s1_poison() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.resource_id LIKE 'poison22-%' THEN RAISE EXCEPTION 'value % is out of range', NEW.resource_id USING ERRCODE = '22003'; END IF;
        IF NEW.resource_id LIKE 'poisonxx-%' THEN RAISE EXCEPTION 'value % is not allowed here', NEW.resource_id USING ERRCODE = 'P0001'; END IF;
        RETURN NEW;
      END $fn$`);
    await t.db.pool.query(`CREATE TRIGGER s1_poison BEFORE INSERT ON ratio.cost_facts FOR EACH ROW EXECUTE FUNCTION public.s1_poison()`);
  });

  // The runner's catalog check (Slice 0 round 4) rejects any non-reviewed trigger:
  // while this test-only trigger exists, status must say so; once dropped, the
  // database must be back to a clean, matching state (no order dependence).
  afterAll(async () => {
    const c = await t.db.pool.connect();
    try {
      const during = await migrationStatus(c);
      expect(during.problems).toContain('PRIVILEGE_MODEL_VIOLATION');
      await c.query(`DROP TRIGGER s1_poison ON ratio.cost_facts`);
      await c.query(`DROP FUNCTION public.s1_poison()`);
      const after = await migrationStatus(c);
      expect(after.problems).toEqual([]);
      expect(after.matches).toBe(true);
    } finally {
      c.release();
    }
  });

  async function persistedText(tenantId: string): Promise<string> {
    const r = await t.db.pool.query(
      `SELECT coalesce(string_agg(x, ' '), '') AS t FROM (
         SELECT coalesce(error_detail, '') || ' ' || stats::text AS x FROM ratio.sync_runs WHERE tenant_id = $1
         UNION ALL SELECT coalesce(quarantine_reason, '') FROM ratio.ingest_batches WHERE tenant_id = $1
         UNION ALL SELECT message FROM ratio.ingest_validation_errors WHERE tenant_id = $1) q`,
      [tenantId],
    );
    return r.rows[0].t;
  }

  it('M2-backstop: a class-22 rejection by Postgres quarantines the batch with a code-only error; the value is never persisted', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([period(P, [['r0/good.csv.gz', csvGz(rowsOf(P, 1, '7.77'))]])]);
    await sync(s, source);
    const before = await publishedTotals(t.db.pool, s.tenantId, s.sourceId);
    source.setPeriods([period(P, [['r1/a.csv.gz', csvGz([...rowsOf(P, 2), focusRow(P, { ResourceId: 'poison22-SECRETVALUE' })])]])]);
    const r = await sync(s, source);
    expect(r.status).toBe('failed');
    expect(r.periods[0]).toMatchObject({ outcome: 'quarantined' });
    const b = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(b.map((x) => x.status)).toEqual(['published', 'quarantined']);
    const errs = await t.db.pool.query(`SELECT code, message FROM ratio.ingest_validation_errors WHERE batch_id = $1`, [b[1].id]);
    expect(errs.rows).toEqual([expect.objectContaining({ code: 'DB_REJECTED_VALUE' })]);
    expect(errs.rows[0].message).toMatch(/SQLSTATE 22003/);
    expect(await persistedText(s.tenantId)).not.toContain('SECRETVALUE');
    expect(JSON.stringify(r)).not.toContain('SECRETVALUE');
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual(before);
  });

  it('M2-generic: any other database error fails the period with a code and generic text only (no raw pg message anywhere)', async () => {
    const s = await seedTenantSource(t.db.pool);
    const r = await sync(s, new FakeFocusSource([period(P, [['r/a.csv.gz', csvGz([focusRow(P, { ResourceId: 'poisonxx-SECRETVALUE' })])]])]));
    expect(r.status).toBe('failed');
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'DB_P0001' });
    expect(r.periods[0].message).toMatch(/SQLSTATE P0001/);
    expect(JSON.stringify(r)).not.toContain('SECRETVALUE');
    expect(JSON.stringify(r)).not.toContain('not allowed here');
    const persisted = await persistedText(s.tenantId);
    expect(persisted).not.toContain('SECRETVALUE');
    expect(persisted).not.toContain('not allowed here');
  });
});


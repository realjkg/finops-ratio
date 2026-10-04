// PR #69 Copilot r4178626016 through the real pipeline: a sub-millisecond inverted charge
// period is a clean validation error (quarantine VALIDATION_FAILED, CHARGE_PERIOD_INVERTED)
// and never reaches the cost_facts_charge_period CHECK at insert. Also: the worker's
// microsecond rounding equals what Postgres stores, for many 7-9 digit fractions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { runSync } from './pipeline';
import { showBatch } from './quarantine';
import { parseFocusTimestamp } from '../focus/timestamp';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import { batchesOf, publishedTotals, seedTenantSource } from '../testing/db';
import { csvGz, focusRow } from '../testing/focusCsv';

let t: WorkerTestDb;
beforeAll(async () => {
  t = await workerTestDb();
});
afterAll(async () => {
  await t.close();
});

const P = '2026-07-01';
const BASE = '2026-07-02T00:00:00';

describe('a sub-millisecond inverted charge period through the worker', () => {
  it('is quarantined VALIDATION_FAILED with CHARGE_PERIOD_INVERTED on that row; nothing published; no constraint error', async () => {
    const s = await seedTenantSource(t.db.pool, { kind: 'focus_file', config: { layout: 'aws-data-exports', bucket: 'unused-bucket', prefix: 'p69', exportName: 'x' } });
    const rows = [
      focusRow(P, { ProviderName: 'AWS', ResourceId: 'ok' }),
      focusRow(P, { ProviderName: 'AWS', ResourceId: 'sub-ms', ChargePeriodStart: `${BASE}.000500Z`, ChargePeriodEnd: `${BASE}.000100Z` }),
    ];
    const r = await runSync({
      pool: t.pool,
      tenantId: s.tenantId,
      sourceKey: s.sourceKey,
      source: new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'run/x.csv.gz', bytes: csvGz(rows) }] }]),
      evidence: new MemoryEvidenceStore(),
      mode: 'sync',
      settings: { allowSyntheticProviders: false },
      hooks: noSleep,
    });
    expect(r.status).toBe('failed');
    expect(r.periods[0]).toMatchObject({ outcome: 'quarantined', code: 'VALIDATION_FAILED' });
    const [b] = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(b).toMatchObject({ status: 'quarantined', error_count: '1' });
    const shown = await showBatch(t.pool, s.tenantId, b.id);
    expect(shown.errors.map((e) => [e.rowOrdinal, e.column, e.code])).toEqual([['2', 'ChargePeriodEnd', 'CHARGE_PERIOD_INVERTED']]);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
  });
});

describe('the worker rounds fraction digits exactly as Postgres stores them', () => {
  it('epochUs equals Postgres microseconds for 2000 fractions of 7-9 digits (ties included)', async () => {
    const fracs: string[] = [];
    for (let i = 0; i < 1000; i++) fracs.push(`.${String(i * 997 % 10_000_000).padStart(7, '0')}`); // 7 digits, many …5 ties
    for (let i = 0; i < 1000; i++) fracs.push(`.${String((i * 7_919_993) % 1_000_000_000).padStart(9, '0')}`);
    fracs.push('.0000005', '.0000015', '.0000025', '.9999995', '.999999500', '.000000500');
    const values = fracs.map((f) => `${BASE}${f}Z`);
    const r = await t.db.pool.query(
      `SELECT ((extract(epoch FROM v::timestamptz) * 1000000)::numeric)::text AS us FROM unnest($1::text[]) WITH ORDINALITY AS u(v, i) ORDER BY i`,
      [values],
    );
    const mismatches = values.filter((v, i) => parseFocusTimestamp(v)!.epochUs !== BigInt(r.rows[i].us.split('.')[0]));
    expect(mismatches).toEqual([]);
  });
});

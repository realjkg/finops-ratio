// A large generated file is streamed from the evidence copy and loaded in
// bounded chunks — proven structurally (chunk sizes and the evidence bytes
// consumed when the first chunk lands), not by timing.
import { PassThrough, type Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { runSync } from './pipeline';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import { publishedTotals, seedTenantSource } from '../testing/db';
import { gz } from '../testing/focusCsv';

let t: WorkerTestDb;
beforeAll(async () => {
  t = await workerTestDb();
});
afterAll(async () => {
  await t.close();
});

const P = '2026-07-01';
const ROWS = 200_000;

class CountingEvidence extends MemoryEvidenceStore {
  bytesRead = 0;
  async open(key: string): Promise<Readable> {
    const inner = await super.open(key);
    const counter = new PassThrough();
    inner.on('data', (c: Buffer) => {
      this.bytesRead += c.length;
    });
    inner.on('error', (e) => counter.destroy(e));
    inner.pipe(counter);
    return counter;
  }
}

function bigCsv(): Buffer {
  const lines = ['BilledCost,BillingCurrency,BillingPeriodStart,ChargePeriodStart,ChargePeriodEnd,ResourceId'];
  for (let i = 0; i < ROWS; i++) {
    lines.push(`0.${String(i % 1000).padStart(3, '0')},USD,${P}T00:00:00Z,2026-07-02T00:00:00Z,2026-07-02T01:00:00Z,res-${i}`);
  }
  return gz(lines.join('\n') + '\n');
}

describe('streaming load', () => {
  // Generous ceiling for a 200k-row load on a shared CI runner; every assertion
  // below is structural, so this bounds total work, it does not mask a race.
  it('S1 200,000 rows load in bounded chunks while the evidence stream is still being read', { timeout: 180_000 }, async () => {
    const s = await seedTenantSource(t.db.pool);
    const bytes = bigCsv();
    const evidence = new CountingEvidence();
    const chunks: Array<{ rows: number; bytesReadAtChunk: number }> = [];
    const r = await runSync({
      pool: t.pool,
      tenantId: s.tenantId,
      sourceKey: s.sourceKey,
      source: new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/big.csv.gz', bytes }] }]),
      evidence,
      mode: 'sync',
      settings: { limits: { insertChunkRows: 1000 } },
      hooks: {
        ...noSleep,
        afterChunk: (info) => {
          chunks.push({ rows: info.chunkRows, bytesReadAtChunk: evidence.bytesRead });
        },
      },
    });
    expect(r.status).toBe('succeeded');
    expect(chunks).toHaveLength(ROWS / 1000);
    expect(Math.max(...chunks.map((c) => c.rows))).toBe(1000);
    expect(chunks.reduce((a, c) => a + c.rows, 0)).toBe(ROWS);
    // The first chunk was inserted long before the whole evidence object had been read.
    expect(chunks[0].bytesReadAtChunk).toBeGreaterThan(0);
    expect(chunks[0].bytesReadAtChunk).toBeLessThan(bytes.length / 4);
    expect(evidence.bytesRead).toBe(bytes.length);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: ROWS, total: '99900.000' } });
  });
});

// Published data is immutable; batch lifecycle and the publication pointer are
// enforced by the database itself (challenger findings H2 and M4).
//
// SQLSTATEs raised by the 0001 triggers:
//   RT001  write to a fact / artifact / validation error of a non-staged batch (or TRUNCATE)
//   RT002  illegal batch status transition or change to a frozen batch column
//   RT003  publication pointer and published batch disagree at COMMIT
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { attempt, createTestDatabase, withRole, type TestDatabase } from './testing/harness';
import { artifactSha, fp, seedTwoTenants, type Seeded } from './testing/fixtures';

let db: TestDatabase;
let seed: Seeded;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  seed = await seedTwoTenants(db.pool);
});
afterAll(async () => {
  await db?.close();
});

/** Superuser transaction that is always rolled back: triggers must bind even the superuser. */
async function superTxn<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** Runs fn in a transaction as ratio_worker for tenant A and then tries to COMMIT. */
async function workerCommit(fn: (c: PoolClient) => Promise<void>): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE ratio_worker');
    await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [seed.a.tenantId]);
    await fn(c);
    try {
      await c.query('COMMIT');
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code ?? 'UNKNOWN', message: err.message ?? String(e) };
    }
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

const factInsert = (batchId: string, ordinal: number, cost = '999') => ({
  sql: `INSERT INTO ratio.cost_facts (tenant_id, batch_id, source_id, artifact_sha256, row_ordinal, billing_period,
          charge_period_start, charge_period_end, billed_cost, billing_currency)
        VALUES ($1, $2, $3, $4, $5, $6, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', $7, 'USD')`,
  params: [seed.a.tenantId, batchId, seed.a.sourceId, artifactSha(seed.a.slug, batchId), ordinal, seed.a.period, cost],
});

async function publishedView(c: PoolClient): Promise<{ n: number; total: string | null; batches: string[] | null }> {
  const r = await c.query(
    `SELECT count(*)::int AS n, sum(billed_cost)::text AS total, array_agg(DISTINCT batch_id::text) AS batches FROM ratio.cost_facts_published`,
  );
  return r.rows[0];
}

describe('facts, artifacts and validation errors of a non-staged batch are immutable', () => {
  it('appending a fact to the published batch is refused (challenger repro), for worker and superuser', async () => {
    const a = seed.a;
    const ins = factInsert(a.batchPublished, 50);
    await withRole(db.pool, 'ratio_worker', a.tenantId, async (c) => {
      expect(await attempt(c, ins.sql, ins.params)).toMatchObject({ ok: false, code: 'RT001' });
      expect(await publishedView(c)).toMatchObject({ n: a.publishedRows, total: a.publishedTotal });
    });
    await superTxn(async (c) => {
      expect(await attempt(c, ins.sql, ins.params)).toMatchObject({ ok: false, code: 'RT001' });
    });
  });

  it('deleting or updating a fact of a published, superseded or quarantined batch is refused', async () => {
    const a = seed.a;
    for (const batch of [a.batchPublished, a.batchSuperseded, a.batchQuarantined]) {
      await withRole(db.pool, 'ratio_worker', a.tenantId, async (c) => {
        // challenger repro: DELETE FROM cost_facts WHERE batch_id = <published> AND row_ordinal = 0
        expect(await attempt(c, `DELETE FROM ratio.cost_facts WHERE batch_id = $1 AND row_ordinal = 0`, [batch]), batch).toMatchObject({
          ok: false,
          code: 'RT001',
        });
      });
      await superTxn(async (c) => {
        expect(await attempt(c, `UPDATE ratio.cost_facts SET billed_cost = 0 WHERE batch_id = $1`, [batch]), batch).toMatchObject({
          ok: false,
          code: 'RT001',
        });
        expect(await attempt(c, `DELETE FROM ratio.cost_facts WHERE batch_id = $1`, [batch]), batch).toMatchObject({
          ok: false,
          code: 'RT001',
        });
      });
    }
  });

  it('artifacts and validation errors of non-staged batches cannot be inserted, updated or deleted', async () => {
    const a = seed.a;
    for (const batch of [a.batchPublished, a.batchSuperseded, a.batchQuarantined]) {
      const sha = artifactSha(a.slug, batch);
      await superTxn(async (c) => {
        const cases: Array<[string, unknown[]]> = [
          [
            `INSERT INTO ratio.ingest_artifacts (tenant_id, source_id, batch_id, artifact_name, sha256, byte_size, row_count, evidence_key)
             VALUES ($1::uuid, $2::uuid, $3, 'late.csv.gz', $4::text, 1, 0, 'evidence/' || $1::text || '/' || $2::text || '/' || $4::text)`,
            [a.tenantId, a.sourceId, batch, fp(`late:${batch}`)],
          ],
          [`UPDATE ratio.ingest_artifacts SET row_count = 0 WHERE batch_id = $1`, [batch]],
          [`DELETE FROM ratio.ingest_artifacts WHERE batch_id = $1`, [batch]],
          [
            `INSERT INTO ratio.ingest_validation_errors (tenant_id, batch_id, error_ordinal, artifact_sha256, code, message)
             VALUES ($1, $2, 999, $3, 'LATE', 'late error')`,
            [a.tenantId, batch, sha],
          ],
          [`UPDATE ratio.ingest_validation_errors SET message = 'rewritten' WHERE batch_id = $1`, [batch]],
          [`DELETE FROM ratio.ingest_validation_errors WHERE batch_id = $1`, [batch]],
        ];
        for (const [sql, params] of cases) {
          const r = await attempt(c, sql, params);
          // UPDATE/DELETE that match no rows cannot fire a row trigger; only assert on statements that hit rows.
          if (r.ok) expect(r.rowCount, `${batch}: ${sql}`).toBe(0);
          else expect(r.code, `${batch}: ${sql} -> ${r.message}`).toBe('RT001');
        }
        // Rows that do exist: the published batch's artifact, the quarantined batch's errors.
        if (batch !== a.batchSuperseded) {
          const target = batch === a.batchQuarantined ? 'ingest_validation_errors' : 'ingest_artifacts';
          expect(await attempt(c, `DELETE FROM ratio.${target} WHERE batch_id = $1`, [batch])).toMatchObject({ ok: false, code: 'RT001' });
        }
      });
    }
  });

  it('a staged batch stays fully writable (positive control)', async () => {
    const a = seed.a;
    await withRole(db.pool, 'ratio_worker', a.tenantId, async (c) => {
      const ins = factInsert(a.batchStaged, 60, '1.23');
      expect(await attempt(c, ins.sql, ins.params)).toMatchObject({ ok: true, rowCount: 1 });
      expect(await attempt(c, `DELETE FROM ratio.cost_facts WHERE batch_id = $1`, [a.batchStaged])).toMatchObject({ ok: true, rowCount: 3 });
      expect(
        await attempt(
          c,
          `INSERT INTO ratio.ingest_validation_errors (tenant_id, batch_id, error_ordinal, artifact_sha256, code, message)
           VALUES ($1, $2, 1, $3, 'MISSING_COLUMN', 'x')`,
          [a.tenantId, a.batchStaged, artifactSha(a.slug, a.batchStaged)],
        ),
      ).toMatchObject({ ok: true });
      expect(await attempt(c, `DELETE FROM ratio.ingest_validation_errors WHERE batch_id = $1`, [a.batchStaged])).toMatchObject({ ok: true });
      expect(await attempt(c, `DELETE FROM ratio.ingest_artifacts WHERE batch_id = $1`, [a.batchStaged])).toMatchObject({ ok: true, rowCount: 1 });
      expect(await attempt(c, `DELETE FROM ratio.ingest_batches WHERE id = $1`, [a.batchStaged])).toMatchObject({ ok: true, rowCount: 1 });
    });
  });

  it('TRUNCATE of fact, evidence, batch and publication tables is refused even for the superuser', async () => {
    for (const t of ['cost_facts', 'ingest_artifacts', 'ingest_validation_errors', 'ingest_batches', 'period_publications']) {
      await superTxn(async (c) => {
        expect(await attempt(c, `TRUNCATE ratio.${t} CASCADE`), t).toMatchObject({ ok: false, code: 'RT001' });
      });
    }
  });
});

describe('batch status transitions', () => {
  it('new batches must start staged', async () => {
    const a = seed.a;
    for (const status of ['published', 'superseded', 'quarantined']) {
      await superTxn(async (c) => {
        const r = await attempt(
          c,
          `INSERT INTO ratio.ingest_batches (tenant_id, id, source_id, run_id, billing_period, artifact_set_fingerprint, status, row_count,
             loaded_billed_total, reconciliation, is_provisional, published_at, superseded_at, quarantine_reason)
           VALUES ($1, gen_random_uuid(), $2, $3, '2026-09-01', $4, $5, 0, 0, 'unverified', true, now(), now(), 'x')`,
          [a.tenantId, a.sourceId, a.runNew, fp(`new:${status}`), status],
        );
        expect(r, status).toMatchObject({ ok: false, code: 'RT002' });
      });
    }
  });

  it('refuses every transition outside staged->published|quarantined, published->superseded, superseded->published', async () => {
    const a = seed.a;
    const illegal: Array<[string, string, string]> = [
      [a.batchQuarantined, 'published', 'published_at = now()'], // challenger repro
      [a.batchQuarantined, 'staged', 'quarantine_reason = quarantine_reason'],
      [a.batchQuarantined, 'superseded', 'superseded_at = now()'],
      [a.batchPublished, 'staged', 'published_at = published_at'],
      [a.batchPublished, 'quarantined', "quarantine_reason = 'late'"],
      [a.batchSuperseded, 'staged', 'superseded_at = superseded_at'],
      [a.batchSuperseded, 'quarantined', "quarantine_reason = 'late'"],
      [a.batchStaged, 'superseded', 'superseded_at = now()'],
    ];
    for (const [batch, to, extra] of illegal) {
      await superTxn(async (c) => {
        const r = await attempt(c, `UPDATE ratio.ingest_batches SET status = $2, ${extra} WHERE id = $1`, [batch, to]);
        expect(r, `${batch} -> ${to}`).toMatchObject({ ok: false, code: 'RT002' });
      });
    }
  });

  it('challenger repro: superseding the live batch and publishing the quarantined one never exposes quarantined rows', async () => {
    const a = seed.a;
    await superTxn(async (c) => {
      expect(
        await attempt(c, `UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE id = $1`, [a.batchPublished]),
      ).toMatchObject({ ok: true, rowCount: 1 });
      expect(
        await attempt(c, `UPDATE ratio.ingest_batches SET status = 'published', published_at = now() WHERE id = $1`, [a.batchQuarantined]),
      ).toMatchObject({ ok: false, code: 'RT002' });
      await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [a.tenantId]);
      const v = await c.query(`SELECT count(*)::int AS n FROM ratio.cost_facts_published WHERE batch_id = $1`, [a.batchQuarantined]);
      expect(v.rows[0].n).toBe(0);
    });
  });

  it('data columns of a non-staged batch are frozen; identity columns are frozen always', async () => {
    const a = seed.a;
    const frozen: Array<[string, string]> = [
      [a.batchPublished, 'row_count = row_count + 1'],
      [a.batchPublished, "reconciliation = 'reconciled'"],
      [a.batchPublished, 'loaded_billed_total = 0'],
      [a.batchPublished, 'published_at = now() - interval \'1 year\''],
      [a.batchSuperseded, 'control_billed_total = 1'],
      [a.batchQuarantined, "reconciliation = 'unverified'"], // challenger repro: variance -> unverified
      [a.batchQuarantined, 'validation_error_count = 0'],
      [a.batchStaged, "billing_period = '2026-09-01'"],
      [a.batchStaged, `artifact_set_fingerprint = '${fp('other-set')}'`],
      [a.batchStaged, 'id = gen_random_uuid()'],
    ];
    for (const [batch, set] of frozen) {
      await superTxn(async (c) => {
        expect(await attempt(c, `UPDATE ratio.ingest_batches SET ${set} WHERE id = $1`, [batch]), `${batch}: ${set}`).toMatchObject({
          ok: false,
          code: 'RT002',
        });
      });
    }
    // An exact no-op update is harmless and allowed (challenger's `SET row_count = row_count`).
    await superTxn(async (c) => {
      expect(await attempt(c, `UPDATE ratio.ingest_batches SET row_count = row_count WHERE id = $1`, [a.batchPublished])).toMatchObject({
        ok: true,
        rowCount: 1,
      });
    });
  });

  it('only staged batches can be deleted', async () => {
    const a = seed.a;
    for (const batch of [a.batchPublished, a.batchSuperseded, a.batchQuarantined]) {
      await superTxn(async (c) => {
        // The BEFORE trigger refuses before the FK from its children is even checked.
        expect(await attempt(c, `DELETE FROM ratio.ingest_batches WHERE id = $1`, [batch]), batch).toMatchObject({ ok: false, code: 'RT002' });
      });
    }
  });
});

describe('reconciliation and money invariants', () => {
  it('reconciled requires a control that matches (challenger repro: reconciled with mismatched counts)', async () => {
    const a = seed.a;
    await superTxn(async (c) => {
      const set = (sql: string) => attempt(c, `UPDATE ratio.ingest_batches SET ${sql} WHERE id = $1`, [a.batchStaged]);
      expect(await set(`control_row_count = 5, row_count = 1, reconciliation = 'reconciled'`)).toMatchObject({ ok: false, code: '23514' });
      expect(await set(`control_row_count = NULL, control_billed_total = NULL, reconciliation = 'reconciled'`)).toMatchObject({
        ok: false,
        code: '23514',
      });
      expect(await set(`control_row_count = 2, control_billed_total = loaded_billed_total + 0.01, reconciliation = 'reconciled'`)).toMatchObject({
        ok: false,
        code: '23514',
      });
      expect(await set(`control_row_count = 2, control_billed_total = loaded_billed_total, reconciliation = 'reconciled'`)).toMatchObject({
        ok: true,
        rowCount: 1,
      });
    });
  });

  it('challenger repro: a batch with mismatching controls cannot be laundered via unverified and published', async () => {
    const a = seed.a;
    await superTxn(async (c) => {
      const set = (sql: string) => attempt(c, `UPDATE ratio.ingest_batches SET ${sql} WHERE id = $1`, [a.batchStaged]);
      expect(await set(`control_row_count = 5, reconciliation = 'variance'`)).toMatchObject({ ok: true });
      expect(await set(`reconciliation = 'unverified', status = 'published', published_at = now()`)).toMatchObject({ ok: false, code: '23514' });
      expect(await set(`status = 'published', published_at = now()`)).toMatchObject({ ok: false, code: '23514' });
    });
  });

  it('NaN, Infinity and -Infinity are rejected in every money / quantity / total column', async () => {
    // Postgres numeric sorts NaN above Infinity, so `abs(x) < 'Infinity'` is false for NaN too.
    const nan = await db.pool.query(`SELECT abs('NaN'::numeric) < 'Infinity'::numeric AS nan_ok, 'NaN'::numeric = 'NaN'::numeric AS nan_eq`);
    expect(nan.rows[0]).toEqual({ nan_ok: false, nan_eq: true });
    const a = seed.a;
    const factCols = ['billed_cost', 'effective_cost', 'list_cost', 'contracted_cost', 'usage_quantity', 'pricing_quantity'];
    const batchCols = ['control_billed_total', 'loaded_billed_total'];
    for (const v of ['NaN', 'Infinity', '-Infinity']) {
      await superTxn(async (c) => {
        for (const col of factCols) {
          const r = await attempt(c, `UPDATE ratio.cost_facts SET ${col} = $2::numeric WHERE batch_id = $1`, [a.batchStaged, v]);
          expect(r, `${col}=${v}`).toMatchObject({ ok: false, code: '23514' });
        }
        for (const col of batchCols) {
          const r = await attempt(c, `UPDATE ratio.ingest_batches SET ${col} = $2::numeric WHERE id = $1`, [a.batchStaged, v]);
          expect(r, `${col}=${v}`).toMatchObject({ ok: false, code: '23514' });
        }
        // challenger repro: NaN totals marked reconciled
        expect(
          await attempt(
            c,
            `UPDATE ratio.ingest_batches SET loaded_billed_total = 'NaN', control_billed_total = 'NaN', reconciliation = 'reconciled' WHERE id = $1`,
            [a.batchStaged],
          ),
        ).toMatchObject({ ok: false, code: '23514' });
      });
    }
    // Large finite values remain valid.
    await superTxn(async (c) => {
      const r = await attempt(c, `UPDATE ratio.cost_facts SET billed_cost = '-123456789012345678901234567890.000000001' WHERE batch_id = $1`, [
        a.batchStaged,
      ]);
      expect(r).toMatchObject({ ok: true, rowCount: 2 });
    });
  });
});

describe('publication pointer always names the one published batch', () => {
  it('pointer to a staged batch: the view never exposes its rows, and COMMIT is refused (challenger repro)', async () => {
    const a = seed.a;
    const r = await workerCommit(async (c) => {
      await c.query(`UPDATE ratio.period_publications SET batch_id = $1 WHERE source_id = $2`, [a.batchStaged, a.sourceId]);
      // Inside the transaction the pointer names a staged batch. The view's
      // status = 'published' predicate keeps the staged rows out (this is the
      // assertion that fails if that predicate is removed).
      const v = await publishedView(c);
      expect(v.n).toBe(0);
      const staged = await c.query(`SELECT count(*)::int AS n FROM ratio.cost_facts_published WHERE batch_id = $1`, [a.batchStaged]);
      expect(staged.rows[0].n).toBe(0);
    });
    expect(r).toMatchObject({ ok: false, code: 'RT003' });
  });

  it('COMMIT is refused when the pointer and the published batch disagree in any way', async () => {
    const a = seed.a;
    const scenarios: Record<string, (c: PoolClient) => Promise<void>> = {
      'pointer to a superseded batch': async (c) => {
        await c.query(`UPDATE ratio.period_publications SET batch_id = $1 WHERE source_id = $2`, [a.batchSuperseded, a.sourceId]);
      },
      'pointer to a quarantined batch': async (c) => {
        await c.query(`UPDATE ratio.period_publications SET batch_id = $1 WHERE source_id = $2`, [a.batchQuarantined, a.sourceId]);
      },
      'published batch superseded without a replacement': async (c) => {
        await c.query(`UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE id = $1`, [a.batchPublished]);
      },
      'staged batch published without moving the pointer': async (c) => {
        await c.query(`UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE id = $1`, [a.batchPublished]);
        await c.query(`UPDATE ratio.ingest_batches SET status = 'published', published_at = now() WHERE id = $1`, [a.batchStaged]);
      },
    };
    for (const [name, fn] of Object.entries(scenarios)) {
      expect(await workerCommit(fn), name).toMatchObject({ ok: false, code: 'RT003' });
    }
    // Deleting the pointer (only possible for the superuser) is refused too.
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`DELETE FROM ratio.period_publications WHERE tenant_id = $1`, [a.tenantId]);
      await expect(c.query('COMMIT')).rejects.toMatchObject({ code: 'RT003' });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    // Nothing changed.
    await withRole(db.pool, 'ratio_worker', a.tenantId, async (w) => {
      expect(await publishedView(w)).toEqual({ n: a.publishedRows, total: a.publishedTotal, batches: [a.batchPublished] });
    });
  });

  it('a publish (staged -> published + repoint) and a replay back to the retained batch both commit atomically', async () => {
    const b = seed.b;
    const asB = async (fn: (c: PoolClient) => Promise<void>) => {
      const c = await db.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE ratio_worker');
        await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [b.tenantId]);
        await fn(c);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    };
    const view = async () => {
      let out: Awaited<ReturnType<typeof publishedView>> | undefined;
      await withRole(db.pool, 'ratio_reader', b.tenantId, async (c) => {
        out = await publishedView(c);
      });
      return out!;
    };
    const original = await view();
    expect(original.batches).toEqual([b.batchPublished]);

    // Replay/rollback: re-point the period at the retained superseded batch.
    await asB(async (c) => {
      await c.query(`UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE id = $1`, [b.batchPublished]);
      await c.query(`UPDATE ratio.ingest_batches SET status = 'published', published_at = now() WHERE id = $1`, [b.batchSuperseded]);
      await c.query(`UPDATE ratio.period_publications SET batch_id = $1, published_by_run_id = $2, published_at = now() WHERE source_id = $3`, [
        b.batchSuperseded,
        b.runOld,
        b.sourceId,
      ]);
    });
    expect((await view()).batches).toEqual([b.batchSuperseded]);
    expect((await view()).total).toBe('5555.55');

    // And forward again.
    await asB(async (c) => {
      await c.query(`UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE id = $1`, [b.batchSuperseded]);
      await c.query(`UPDATE ratio.ingest_batches SET status = 'published', published_at = now() WHERE id = $1`, [b.batchPublished]);
      await c.query(`UPDATE ratio.period_publications SET batch_id = $1, published_by_run_id = $2, published_at = now() WHERE source_id = $3`, [
        b.batchPublished,
        b.runNew,
        b.sourceId,
      ]);
    });
    expect(await view()).toEqual(original);
  });

  it('the guarantee behind the view predicate: at every COMMIT each pointer names a published batch', async () => {
    // Catalog-level proof that the guarantee is enforced by a deferred constraint
    // trigger on both tables (not just by convention), plus a data check.
    const trig = await db.pool.query(
      `SELECT c.relname, t.tgname, t.tgdeferrable, t.tginitdeferred FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'ratio' AND t.tgname = 'publication_consistency' ORDER BY 1`,
    );
    expect(trig.rows).toEqual([
      { relname: 'ingest_batches', tgname: 'publication_consistency', tgdeferrable: true, tginitdeferred: true },
      { relname: 'period_publications', tgname: 'publication_consistency', tgdeferrable: true, tginitdeferred: true },
    ]);
    const bad = await db.pool.query(
      `SELECT pp.* FROM ratio.period_publications pp JOIN ratio.ingest_batches b ON b.tenant_id = pp.tenant_id AND b.id = pp.batch_id
       WHERE b.status <> 'published'`,
    );
    expect(bad.rows).toEqual([]);
  });
});

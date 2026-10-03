// Published data is immutable; batch lifecycle and the publication pointer are
// enforced by the database itself (challenger findings H2 and M4).
//
// SQLSTATEs raised by the 0001 triggers:
//   RT001  write to a fact / artifact / validation error of a non-staged batch (or TRUNCATE)
//   RT002  illegal batch status transition or change to a frozen batch column
//   RT003  publication pointer and published batch disagree at COMMIT
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { Client } from 'pg';
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

  it('worker may UPDATE ingest_artifacts.row_count only (column grant) and only while the batch is staged', async () => {
    const a = seed.a;
    await withRole(db.pool, 'ratio_worker', a.tenantId, async (c) => {
      expect(await attempt(c, `UPDATE ratio.ingest_artifacts SET row_count = 42 WHERE batch_id = $1`, [a.batchStaged])).toMatchObject({
        ok: true,
        rowCount: 1,
      });
      const back = await c.query(`SELECT row_count FROM ratio.ingest_artifacts WHERE batch_id = $1`, [a.batchStaged]);
      expect(back.rows[0].row_count).toBe('42');
      for (const batch of [a.batchPublished, a.batchQuarantined, a.batchSuperseded]) {
        expect(await attempt(c, `UPDATE ratio.ingest_artifacts SET row_count = 43 WHERE batch_id = $1`, [batch]), batch).toMatchObject({
          ok: false,
          code: 'RT001',
        });
      }
      for (const set of [
        `byte_size = 1`,
        `artifact_name = 'x.csv'`,
        `sha256 = sha256`,
        `evidence_key = evidence_key`,
        `batch_id = batch_id`,
        `tenant_id = tenant_id`,
        `source_id = source_id`,
        `row_count = 1, byte_size = 1`,
      ]) {
        expect(await attempt(c, `UPDATE ratio.ingest_artifacts SET ${set} WHERE batch_id = $1`, [a.batchStaged]), set).toMatchObject({
          ok: false,
          code: '42501',
        });
      }
    });
    const priv = await db.pool.query(
      `SELECT column_name FROM information_schema.column_privileges
       WHERE table_schema = 'ratio' AND table_name = 'ingest_artifacts' AND grantee = 'ratio_worker' AND privilege_type = 'UPDATE' ORDER BY 1`,
    );
    expect(priv.rows).toEqual([{ column_name: 'row_count' }]);
    const reader = await db.pool.query(
      `SELECT count(*)::int AS n FROM information_schema.column_privileges
       WHERE table_schema = 'ratio' AND table_name = 'ingest_artifacts' AND grantee = 'ratio_reader'`,
    );
    expect(reader.rows[0].n).toBe(0);
    await withRole(db.pool, 'ratio_reader', a.tenantId, async (c) => {
      expect(await attempt(c, `UPDATE ratio.ingest_artifacts SET row_count = 1`)).toMatchObject({ ok: false, code: '42501' });
      expect(await attempt(c, `SELECT row_count FROM ratio.ingest_artifacts`)).toMatchObject({ ok: false, code: '42501' });
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

  it("Slice 1's exact publish order and replay-rollback order commit in ONE transaction as ratio_worker", async () => {
    // Publish: prior published -> superseded, new staged -> published, upsert pointer.
    // Replay rollback: current published -> superseded, target superseded -> published, repoint.
    // Uses tenant B and restores its published batch; B's staged batch ends superseded.
    const b = seed.b;
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE ratio_worker');
      await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [b.tenantId]);
      const upsert = (batch: string, run: string) =>
        c.query(
          `INSERT INTO ratio.period_publications (tenant_id, source_id, billing_period, batch_id, published_at, published_by_run_id)
           VALUES ($1, $2, $3, $4, now(), $5)
           ON CONFLICT (tenant_id, source_id, billing_period)
           DO UPDATE SET batch_id = EXCLUDED.batch_id, published_at = EXCLUDED.published_at, published_by_run_id = EXCLUDED.published_by_run_id`,
          [b.tenantId, b.sourceId, b.period, batch, run],
        );
      // publish the staged batch
      await c.query(`UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE id = $1`, [b.batchPublished]);
      await c.query(`UPDATE ratio.ingest_batches SET status = 'published', published_at = now() WHERE id = $1`, [b.batchStaged]);
      await upsert(b.batchStaged, b.runNew);
      const mid = await publishedView(c);
      expect(mid.batches).toEqual([b.batchStaged]);
      expect(mid.total).toBe('11111.10');
      // replay rollback to the previously published batch
      await c.query(`UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE id = $1`, [b.batchStaged]);
      await c.query(`UPDATE ratio.ingest_batches SET status = 'published', published_at = now() WHERE id = $1`, [b.batchPublished]);
      await upsert(b.batchPublished, b.runNew);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    await withRole(db.pool, 'ratio_reader', b.tenantId, async (r) => {
      expect(await publishedView(r)).toEqual({ n: b.publishedRows, total: b.publishedTotal, batches: [b.batchPublished] });
    });
    const st = await db.pool.query(`SELECT status FROM ratio.ingest_batches WHERE id = $1`, [b.batchStaged]);
    expect(st.rows[0].status).toBe('superseded');
  });

});

describe('round 3: challenger round-2 findings', () => {
  it('H1: switching ratio.tenant_id before COMMIT cannot smuggle a pointer to a staged batch past RT003 (repro T1)', async () => {
    const a = seed.a;
    for (const switchTo of ['', seed.b.tenantId]) {
      const r = await workerCommit(async (c) => {
        await c.query(`UPDATE ratio.period_publications SET batch_id = $1 WHERE source_id = $2`, [a.batchStaged, a.sourceId]);
        await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [switchTo]);
      });
      expect(r, `switch to '${switchTo}'`).toMatchObject({ ok: false, code: 'RT003' });
    }
  });

  it('H1: switching tenant before COMMIT cannot supersede the published batch without a replacement (repro T2)', async () => {
    const a = seed.a;
    for (const switchTo of [seed.b.tenantId, '']) {
      const r = await workerCommit(async (c) => {
        await c.query(`UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE id = $1`, [a.batchPublished]);
        await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [switchTo]);
      });
      expect(r, `switch to '${switchTo}'`).toMatchObject({ ok: false, code: 'RT003' });
    }
    await withRole(db.pool, 'ratio_worker', a.tenantId, async (w) => {
      expect(await publishedView(w)).toEqual({ n: a.publishedRows, total: a.publishedTotal, batches: [a.batchPublished] });
    });
  });

  it('H1: a legitimate publish with a constant tenant still commits (positive control, fresh DB)', async () => {
    const fresh = await createTestDatabase({ migrate: true });
    try {
      const s2 = await seedTwoTenants(fresh.pool);
      const c = await fresh.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE ratio_worker');
        await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [s2.a.tenantId]);
        await c.query(`UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE id = $1`, [s2.a.batchPublished]);
        await c.query(`UPDATE ratio.ingest_batches SET status = 'published', published_at = now() WHERE id = $1`, [s2.a.batchStaged]);
        await c.query(`UPDATE ratio.period_publications SET batch_id = $1 WHERE source_id = $2`, [s2.a.batchStaged, s2.a.sourceId]);
        await c.query('COMMIT');
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
      const st = await fresh.pool.query(`SELECT status FROM ratio.ingest_batches WHERE id = $1`, [s2.a.batchStaged]);
      expect(st.rows[0].status).toBe('published');
    } finally {
      await fresh.close();
    }
  });

  it('H1: a child row whose parent batch is not found is refused by the trigger (RT001), not left to the FK', async () => {
    const a = seed.a;
    await superTxn(async (c) => {
      const missing = 'eeeeeeee-0000-4000-8000-000000000001';
      const ins = factInsert(missing, 1);
      expect(await attempt(c, ins.sql, ins.params)).toMatchObject({ ok: false, code: 'RT001' });
      expect(
        await attempt(
          c,
          `INSERT INTO ratio.ingest_validation_errors (tenant_id, batch_id, error_ordinal, artifact_sha256, code, message)
           VALUES ($1, $2, 1, $3, 'X', 'x')`,
          [a.tenantId, missing, fp('x')],
        ),
      ).toMatchObject({ ok: false, code: 'RT001' });
    });
  });

  it('M2: a fact insert racing an uncommitted publish waits on the batch row lock, then fails RT001 (two connections)', async () => {
    const fresh = await createTestDatabase({ migrate: true });
    const publisher = new Client({ connectionString: fresh.url });
    const zombie = new Client({ connectionString: fresh.url });
    const observer = new Client({ connectionString: fresh.url });
    for (const c of [publisher, zombie, observer]) c.on('error', () => undefined);
    try {
      const s2 = await seedTwoTenants(fresh.pool);
      const a = s2.a;
      await Promise.all([publisher.connect(), zombie.connect(), observer.connect()]);
      for (const c of [publisher, zombie]) {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE ratio_worker');
        await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [a.tenantId]);
      }
      // Publisher: publish the staged batch, uncommitted.
      await publisher.query(`UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE id = $1`, [a.batchPublished]);
      await publisher.query(`UPDATE ratio.ingest_batches SET status = 'published', published_at = now() WHERE id = $1`, [a.batchStaged]);
      await publisher.query(`UPDATE ratio.period_publications SET batch_id = $1 WHERE source_id = $2`, [a.batchStaged, a.sourceId]);
      // Zombie: append a fact to that (still staged, as far as it can see) batch.
      const zombiePid = (await zombie.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
      const insert = zombie
        .query(
          `INSERT INTO ratio.cost_facts (tenant_id, batch_id, source_id, artifact_sha256, row_ordinal, billing_period,
             charge_period_start, charge_period_end, billed_cost, billing_currency)
           VALUES ($1, $2, $3, $4, 77, $5, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', 1, 'USD')`,
          [a.tenantId, a.batchStaged, a.sourceId, artifactSha(a.slug, a.batchStaged), a.period],
        )
        .then(
          () => ({ ok: true as const }),
          (e: { code?: string }) => ({ ok: false as const, code: e.code }),
        );
      // Observe (bounded poll) that the zombie is blocked on a lock held by the publisher.
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i++) {
        const r = await observer.query(
          `SELECT wait_event_type = 'Lock' AS w FROM pg_stat_activity WHERE pid = $1`,
          [zombiePid],
        );
        waiting = r.rows[0]?.w === true;
        if (!waiting) await new Promise((res) => setTimeout(res, 25));
      }
      expect(waiting).toBe(true);
      const blockers = await observer.query(`SELECT pg_blocking_pids($1) AS b`, [zombiePid]);
      const publisherPid = (await publisher.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
      expect(blockers.rows[0].b).toEqual([publisherPid]);
      await publisher.query('COMMIT');
      expect(await insert).toEqual({ ok: false, code: 'RT001' });
      await zombie.query('ROLLBACK');
      const n = await fresh.pool.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE batch_id = $1 AND row_ordinal = 77`, [a.batchStaged]);
      expect(n.rows[0].n).toBe(0);
    } finally {
      for (const c of [publisher, zombie, observer]) await c.end().catch(() => undefined);
      await fresh.close();
    }
  });

  /**
   * Round 4 (challenger round 3, M2): the OLD-row path of tg_child_of_staged_batch
   * also takes FOR SHARE on the parent batch. A zombie DELETE / UPDATE of a
   * child row of the batch being published must wait for the publisher's
   * uncommitted status change and then fail RT001, leaving the rows untouched.
   */
  async function raceAgainstUncommittedPublish(
    zombieSql: (a: Seeded['a']) => { sql: string; params: unknown[] },
    snapshot: (pool: TestDatabase['pool'], a: Seeded['a']) => Promise<unknown>,
  ): Promise<void> {
    const fresh = await createTestDatabase({ migrate: true });
    const publisher = new Client({ connectionString: fresh.url });
    const zombie = new Client({ connectionString: fresh.url });
    const observer = new Client({ connectionString: fresh.url });
    for (const c of [publisher, zombie, observer]) c.on('error', () => undefined);
    try {
      const s2 = await seedTwoTenants(fresh.pool);
      const a = s2.a;
      const before = await snapshot(fresh.pool, a);
      await Promise.all([publisher.connect(), zombie.connect(), observer.connect()]);
      for (const c of [publisher, zombie]) {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE ratio_worker');
        await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [a.tenantId]);
      }
      // Publisher: publish the staged batch, uncommitted.
      await publisher.query(`UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE id = $1`, [a.batchPublished]);
      await publisher.query(`UPDATE ratio.ingest_batches SET status = 'published', published_at = now() WHERE id = $1`, [a.batchStaged]);
      await publisher.query(`UPDATE ratio.period_publications SET batch_id = $1 WHERE source_id = $2`, [a.batchStaged, a.sourceId]);
      // Zombie: change child rows of that (still staged, as far as it can see) batch.
      const zombiePid = (await zombie.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
      const z = zombieSql(a);
      const write = zombie.query(z.sql, z.params).then(
        (r) => ({ ok: true as const, rowCount: r.rowCount }),
        (e: { code?: string }) => ({ ok: false as const, code: e.code }),
      );
      // Observe (bounded poll) that the zombie is blocked on a lock held by the publisher.
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i++) {
        const r = await observer.query(`SELECT wait_event_type = 'Lock' AS w FROM pg_stat_activity WHERE pid = $1`, [zombiePid]);
        waiting = r.rows[0]?.w === true;
        if (!waiting) await new Promise((res) => setTimeout(res, 25));
      }
      expect(waiting).toBe(true);
      const blockers = await observer.query(`SELECT pg_blocking_pids($1) AS b`, [zombiePid]);
      const publisherPid = (await publisher.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
      expect(blockers.rows[0].b).toEqual([publisherPid]);
      await publisher.query('COMMIT');
      expect(await write).toEqual({ ok: false, code: 'RT001' });
      await zombie.query('ROLLBACK');
      expect(await snapshot(fresh.pool, a)).toEqual(before);
      const st = await fresh.pool.query(`SELECT status FROM ratio.ingest_batches WHERE id = $1`, [a.batchStaged]);
      expect(st.rows[0].status).toBe('published');
    } finally {
      for (const c of [publisher, zombie, observer]) await c.end().catch(() => undefined);
      await fresh.close();
    }
  }

  it('M2 (round 4): a fact DELETE racing an uncommitted publish waits on the batch row lock, then fails RT001; rows unchanged', async () => {
    await raceAgainstUncommittedPublish(
      (a) => ({ sql: `DELETE FROM ratio.cost_facts WHERE tenant_id = $1 AND batch_id = $2`, params: [a.tenantId, a.batchStaged] }),
      async (pool, a) => {
        const r = await pool.query(
          `SELECT count(*)::int AS n, sum(billed_cost)::text AS total FROM ratio.cost_facts WHERE tenant_id = $1 AND batch_id = $2`,
          [a.tenantId, a.batchStaged],
        );
        expect(r.rows[0].n).toBe(2); // the seed's staged batch carries two facts
        return r.rows[0];
      },
    );
  });

  it('M2 (round 4): an artifact UPDATE (worker column grant) racing an uncommitted publish waits, then fails RT001; row unchanged', async () => {
    await raceAgainstUncommittedPublish(
      (a) => ({
        sql: `UPDATE ratio.ingest_artifacts SET row_count = row_count + 1 WHERE tenant_id = $1 AND batch_id = $2`,
        params: [a.tenantId, a.batchStaged],
      }),
      async (pool, a) => {
        const r = await pool.query(`SELECT artifact_name, row_count::int AS n FROM ratio.ingest_artifacts WHERE tenant_id = $1 AND batch_id = $2`, [
          a.tenantId,
          a.batchStaged,
        ]);
        expect(r.rows).toHaveLength(1);
        return r.rows;
      },
    );
  });

  it('M3: data columns cannot ride along with a legal transition', async () => {
    const a = seed.a;
    const cases: Array<[string, string]> = [
      [a.batchPublished, `status = 'superseded', superseded_at = now(), loaded_billed_total = 0`],
      [a.batchPublished, `status = 'superseded', superseded_at = now(), row_count = row_count + 1`],
      [a.batchPublished, `status = 'superseded', superseded_at = now(), reconciliation = 'reconciled', control_row_count = row_count`],
      [a.batchSuperseded, `status = 'published', published_at = now(), row_count = 99`],
      [a.batchSuperseded, `status = 'published', published_at = now(), is_provisional = true`],
      [a.batchSuperseded, `status = 'published', published_at = now(), quarantine_reason = 'x'`],
    ];
    for (const [batch, set] of cases) {
      await superTxn(async (c) => {
        if (batch === a.batchSuperseded) {
          // make room for the replay: the live batch must leave 'published' first
          await c.query(`UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE id = $1`, [a.batchPublished]);
        }
        expect(await attempt(c, `UPDATE ratio.ingest_batches SET ${set} WHERE id = $1`, [batch]), set).toMatchObject({ ok: false, code: 'RT002' });
      });
    }
    // The same transitions without extra columns are legal.
    await superTxn(async (c) => {
      expect(
        await attempt(c, `UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE id = $1`, [a.batchPublished]),
      ).toMatchObject({ ok: true, rowCount: 1 });
      expect(
        await attempt(c, `UPDATE ratio.ingest_batches SET status = 'published', published_at = now() WHERE id = $1`, [a.batchSuperseded]),
      ).toMatchObject({ ok: true, rowCount: 1 });
    });
  });

  it('L2: the worker cannot call the publication check directly; the deferred trigger still works for it', async () => {
    const r = await db.pool.query(
      `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'ratio' AND p.proname LIKE '%publication%' AND p.prorettype <> 'trigger'::regtype
         AND has_function_privilege('ratio_worker', p.oid, 'EXECUTE')`,
    );
    expect(r.rows).toEqual([]);
    // Trigger path, as the worker: an inconsistent end state is still refused at COMMIT.
    const res = await workerCommit(async (c) => {
      await c.query(`UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE id = $1`, [seed.a.batchPublished]);
    });
    expect(res).toMatchObject({ ok: false, code: 'RT003' });
  });
});

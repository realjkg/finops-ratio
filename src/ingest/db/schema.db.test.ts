// Schema shape, roles and constraint invariants of migration 0001.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attempt, createTestDatabase, withRole, type TestDatabase } from './testing/harness';
import { TENANT_TABLES, artifactSha, evidenceKey, fp, seedTwoTenants, type Seeded } from './testing/fixtures';

let db: TestDatabase;
let seed: Seeded;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  seed = await seedTwoTenants(db.pool);
});
afterAll(async () => {
  await db?.close();
});

const q = async (sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows;

/** Runs one statement as the superuser inside a savepointed transaction that is rolled back. */
async function tryAsSuper(sql: string, params: unknown[] = []) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    return await attempt(c, sql, params);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

describe('schema shape', () => {
  it('every ratio table has RLS enabled and forced', async () => {
    const rows = await q(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ratio' AND c.relkind IN ('r','p') ORDER BY 1`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual(TENANT_TABLES.map((t) => t.table).sort());
    for (const r of rows) {
      expect(r.relrowsecurity, r.relname).toBe(true);
      expect(r.relforcerowsecurity, r.relname).toBe(true);
    }
    // Each table has at least one policy.
    const pol = await q(
      `SELECT c.relname, count(p.*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_policy p ON p.polrelid = c.oid WHERE n.nspname = 'ratio' AND c.relkind = 'r' GROUP BY 1`,
    );
    for (const r of pol) expect(r.n, r.relname).toBeGreaterThanOrEqual(1);
  });

  it('every tenant-owned table has tenant_id uuid not null', async () => {
    for (const { table } of TENANT_TABLES.filter((t) => t.table !== 'tenants')) {
      const rows = await q(
        `SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'ratio' AND table_name = $1 AND column_name = 'tenant_id'`,
        [table],
      );
      expect(rows, table).toEqual([{ data_type: 'uuid', is_nullable: 'NO' }]);
    }
  });

  it('every foreign key is composite and includes tenant_id', async () => {
    const fks = await q(
      `SELECT con.conname, con.conrelid::regclass::text AS tbl, con.confrelid::regclass::text AS ref,
              (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
              (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS refcols
       FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
       WHERE n.nspname = 'ratio' AND con.contype = 'f'`,
    );
    expect(fks.length).toBeGreaterThanOrEqual(10);
    for (const fk of fks) {
      const cols = fk.cols as string[];
      const refcols = fk.refcols as string[];
      const i = cols.indexOf('tenant_id');
      expect(i, `${fk.conname} must include tenant_id`).toBeGreaterThanOrEqual(0);
      const expectedRef = fk.ref === 'ratio.tenants' ? 'id' : 'tenant_id';
      expect(refcols[i], `${fk.conname}: tenant_id must map to ${fk.ref}.${expectedRef}`).toBe(expectedRef);
      if (fk.ref !== 'ratio.tenants') expect(cols.length, `${fk.conname} must be composite`).toBeGreaterThanOrEqual(2);
    }
  });

  it('exactly the expected composite foreign keys exist', async () => {
    // Guards against an FK being dropped or narrowed (the generic check above
    // only inspects FKs that exist).
    const fks = await q(
      `SELECT con.conrelid::regclass::text || '(' ||
              (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) || ') -> ' ||
              con.confrelid::regclass::text || '(' ||
              (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) || ')' AS fk
       FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
       WHERE n.nspname = 'ratio' AND con.contype = 'f' ORDER BY 1`,
    );
    expect(fks.map((r) => r.fk as string).sort()).toEqual(
      [
        'ratio.sources(tenant_id) -> ratio.tenants(id)',
        'ratio.sync_runs(tenant_id,source_id) -> ratio.sources(tenant_id,id)',
        'ratio.ingest_batches(tenant_id,source_id,run_id) -> ratio.sync_runs(tenant_id,source_id,id)',
        'ratio.ingest_artifacts(tenant_id,source_id,batch_id) -> ratio.ingest_batches(tenant_id,source_id,id)',
        'ratio.ingest_validation_errors(tenant_id,batch_id,artifact_sha256) -> ratio.ingest_artifacts(tenant_id,batch_id,sha256)',
        'ratio.cost_facts(tenant_id,source_id,billing_period,batch_id) -> ratio.ingest_batches(tenant_id,source_id,billing_period,id)',
        'ratio.cost_facts(tenant_id,batch_id,artifact_sha256) -> ratio.ingest_artifacts(tenant_id,batch_id,sha256)',
        'ratio.period_publications(tenant_id,source_id,billing_period,batch_id) -> ratio.ingest_batches(tenant_id,source_id,billing_period,id)',
        'ratio.period_publications(tenant_id,source_id,published_by_run_id) -> ratio.sync_runs(tenant_id,source_id,id)',
        'ratio.source_checkpoints(tenant_id,source_id) -> ratio.sources(tenant_id,id)',
        'ratio.source_checkpoints(tenant_id,source_id,last_run_id) -> ratio.sync_runs(tenant_id,source_id,id)',
      ].sort(),
    );
  });

  it('money columns are unconstrained numeric and no float types exist', async () => {
    const money = [
      ['cost_facts', 'billed_cost'],
      ['cost_facts', 'effective_cost'],
      ['cost_facts', 'list_cost'],
      ['cost_facts', 'contracted_cost'],
      ['cost_facts', 'usage_quantity'],
      ['cost_facts', 'pricing_quantity'],
      ['ingest_batches', 'control_billed_total'],
      ['ingest_batches', 'loaded_billed_total'],
    ];
    for (const [t, col] of money) {
      const rows = await q(
        `SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns
         WHERE table_schema = 'ratio' AND table_name = $1 AND column_name = $2`,
        [t, col],
      );
      expect(rows, `${t}.${col}`).toEqual([{ data_type: 'numeric', numeric_precision: null, numeric_scale: null }]);
    }
    const bad = await q(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'ratio' AND data_type IN ('real','double precision','money')`,
    );
    expect(bad).toEqual([]);
    const billed = await q(
      `SELECT is_nullable FROM information_schema.columns WHERE table_schema='ratio' AND table_name='cost_facts' AND column_name IN ('billed_cost','billing_currency')`,
    );
    expect(billed.map((r) => r.is_nullable)).toEqual(['NO', 'NO']);
  });

  it('all timestamp columns are timestamptz', async () => {
    const rows = await q(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'ratio' AND (data_type LIKE 'timestamp%' OR data_type LIKE 'time %' OR data_type = 'time without time zone')`,
    );
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) expect(r.data_type, `${r.table_name}.${r.column_name}`).toBe('timestamp with time zone');
  });

  it('view runs with definer rights of ratio_owner (not security_invoker) and all objects are owned by ratio_owner', async () => {
    // BOUNDARY v2 / D4: the reader is granted the view only; the view must run
    // as its non-superuser, non-BYPASSRLS owner so FORCE RLS still filters by tenant.
    const view = await q(
      `SELECT coalesce(c.reloptions, '{}') AS reloptions, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ratio' AND c.relname = 'cost_facts_published'`,
    );
    expect(view).toHaveLength(1);
    expect((view[0].reloptions as string[]).some((o) => /^security_invoker=(true|on|1)$/i.test(o))).toBe(false);
    expect(view[0].owner).toBe('ratio_owner');
    const owner = await q(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'ratio_owner'`);
    expect(owner).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const owners = await q(
      `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'ratio'`,
    );
    expect(owners).toEqual([{ owner: 'ratio_owner' }]);
    const schemaOwner = await q(`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'ratio'`);
    expect(schemaOwner).toEqual([{ owner: 'ratio_owner' }]);
    const funcs = await q(
      `SELECT DISTINCT pg_get_userbyid(p.proowner) AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'ratio'`,
    );
    expect(funcs).toEqual([{ owner: 'ratio_owner' }]);
  });

  it('sources has no secret-bearing column', async () => {
    const cols = await q(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='ratio' AND table_name='sources'`,
    );
    for (const { column_name } of cols) {
      expect(column_name).not.toMatch(/token|secret|password|credential|sas|sig/i);
    }
  });
});

describe('roles', () => {
  it('roles exist, are NOLOGIN, not superuser and not BYPASSRLS', async () => {
    const rows = await q(
      `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb FROM pg_roles
       WHERE rolname IN ('ratio_owner','ratio_worker','ratio_reader') ORDER BY 1`,
    );
    expect(rows.map((r) => r.rolname)).toEqual(['ratio_owner', 'ratio_reader', 'ratio_worker']);
    for (const r of rows) {
      expect(r.rolsuper, r.rolname).toBe(false);
      expect(r.rolbypassrls, r.rolname).toBe(false);
      expect(r.rolcanlogin, r.rolname).toBe(false);
      expect(r.rolcreaterole, r.rolname).toBe(false);
      expect(r.rolcreatedb, r.rolname).toBe(false);
    }
    const membership = await q(
      `SELECT pg_has_role('ratio_worker', 'ratio_owner', 'MEMBER') AS w, pg_has_role('ratio_reader', 'ratio_owner', 'MEMBER') AS r,
              pg_has_role('ratio_reader', 'ratio_worker', 'MEMBER') AS rw`,
    );
    expect(membership).toEqual([{ w: false, r: false, rw: false }]);
  });
});

describe('numeric precision', () => {
  it('numeric money round-trips exactly (0.1 + 0.2 = 0.3, 60-digit values, negatives)', async () => {
    // In JS floats this is the classic failure; Postgres numeric must not have it.
    expect(0.1 + 0.2).not.toBe(0.3);
    const a = seed.a;
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      const values = ['0.1', '0.2', '123456789012345678901234567890.123456789012345678901234567890', '-0.000000000000000001'];
      for (const [i, v] of values.entries()) {
        await c.query(
          `INSERT INTO ratio.cost_facts (tenant_id, batch_id, source_id, artifact_sha256, row_ordinal, billing_period,
             charge_period_start, charge_period_end, billed_cost, billing_currency)
           SELECT tenant_id, batch_id, $2, sha256, 1000 + $3, $4, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', $5, 'USD'
           FROM ratio.ingest_artifacts WHERE tenant_id = $1 AND batch_id = $6`,
          [a.tenantId, a.sourceId, i, a.period, v, a.batchStaged],
        );
      }
      const back = await c.query(
        `SELECT billed_cost FROM ratio.cost_facts WHERE tenant_id = $1 AND batch_id = $2 AND row_ordinal >= 1000 ORDER BY row_ordinal`,
        [a.tenantId, a.batchStaged],
      );
      // pg returns numeric as string: no float conversion on the way out.
      expect(back.rows.map((r) => r.billed_cost)).toEqual(values);
      const sum = await c.query(
        `SELECT sum(billed_cost)::text AS s FROM ratio.cost_facts WHERE tenant_id = $1 AND batch_id = $2 AND row_ordinal IN (1000, 1001)`,
        [a.tenantId, a.batchStaged],
      );
      expect(sum.rows[0].s).toBe('0.3');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

describe('sources.config secret guard', () => {
  const insertSource = (config: string) =>
    tryAsSuper(
      `INSERT INTO ratio.sources (tenant_id, id, source_key, kind, display_name, coverage, enabled, config)
       VALUES ($1, gen_random_uuid(), 'guard-' || gen_random_uuid(), 'focus_file', 'x', 'public_cloud', true, $2::jsonb)`,
      [seed.a.tenantId, config],
    );

  it('sources.config rejects secret-looking keys at any depth', async () => {
    const bad = [
      { token: 'x' },
      { api_key: 'x' },
      { apiKey: 'x' },
      { Password: 'x' },
      { passwd: 'x' },
      { clientSecret: 'x' },
      { sas: 'x' },
      { sas_url: 'x' },
      { sig: 'x' },
      { credentials: {} },
      { CREDENTIAL: 'x' },
      { authorization: 'x' },
      { private_key: 'x' },
      { nested: { deep: { accessToken: 'x' } } },
      { list: [{ ok: 1 }, { storage_key: 'x' }] },
      { list: [[{ secret: 'x' }]] },
      // widened vocabulary (challenger L3)
      { pass: 'hunter2' },
      { pw: 'x' },
      { bearer: 'eyJ' },
      { cert: '-----BEGIN' },
      { client_certificate: 'x' },
      { dsn: 'x' },
      { conn: 'x' },
      { connection_string: 'x' },
    ];
    for (const cfg of bad) {
      const r = await insertSource(JSON.stringify(cfg));
      expect(r.ok, JSON.stringify(cfg)).toBe(false);
      if (!r.ok) expect(r.code, JSON.stringify(cfg)).toBe('23514');
    }
  });

  it('sources.config accepts non-secret config', async () => {
    for (const cfg of [{}, { root: '/data/focus', max_rows: 1000, region: 'us-east-1' }, { files: [{ name: 'a.csv', rows: 2 }] }]) {
      const r = await insertSource(JSON.stringify(cfg));
      expect(r, JSON.stringify(cfg)).toMatchObject({ ok: true, rowCount: 1 });
    }
  });

  it('sources.config must be a JSON object', async () => {
    for (const cfg of ['[]', '"str"', '1', 'null']) {
      const r = await insertSource(cfg);
      expect(r.ok, cfg).toBe(false);
      if (!r.ok) expect(['23514', '23502']).toContain(r.code);
    }
  });

  it('updating sources.config to add a secret key is rejected', async () => {
    const r = await tryAsSuper(`UPDATE ratio.sources SET config = config || '{"token":"x"}' WHERE tenant_id = $1`, [
      seed.a.tenantId,
    ]);
    expect(r).toMatchObject({ ok: false, code: '23514' });
  });
});

describe('secret-looking values are rejected wherever free text or JSON is stored (L3)', () => {
  const SECRET_VALUES = [
    'https://bucket.s3.amazonaws.com/x?X-Amz-Signature=abc&X-Amz-Credential=AKIAABCDEFGHIJKLMNOP',
    'postgres://admin:hunter2@db/prod',
    'https://x.blob.core.windows.net/c?sv=2020&SIG=abc',
    'see signature=deadbeef',
    'key id AKIAABCDEFGHIJKLMNOP',
    'temp ASIAABCDEFGHIJKLMNOP',
    'Authorization: Bearer abc.def',
    'authorization: bearer abc',
  ];

  it('sources.config rejects secret values under innocuous keys (challenger repro)', async () => {
    for (const v of SECRET_VALUES) {
      for (const cfg of [{ endpoint: v }, { nested: { list: ['ok', v] } }]) {
        const r = await tryAsSuper(`UPDATE ratio.sources SET config = $2::jsonb WHERE tenant_id = $1`, [seed.a.tenantId, JSON.stringify(cfg)]);
        expect(r, JSON.stringify(cfg)).toMatchObject({ ok: false, code: '23514' });
      }
    }
    // Ordinary URLs and paths are fine.
    const ok = await tryAsSuper(`UPDATE ratio.sources SET config = $2::jsonb WHERE tenant_id = $1`, [
      seed.a.tenantId,
      JSON.stringify({ endpoint: 'https://s3.us-east-1.amazonaws.com', root: '/data/focus', email_contact: 'ops@example.com' }),
    ]);
    expect(ok).toMatchObject({ ok: true, rowCount: 1 });
  });

  it('error_detail, quarantine_reason, validation messages and artifact names reject secret values (challenger repro)', async () => {
    const a = seed.a;
    for (const v of SECRET_VALUES) {
      const cases: Array<[string, unknown[]]> = [
        [`UPDATE ratio.sync_runs SET error_detail = $2 WHERE tenant_id = $1`, [a.tenantId, `connect failed: ${v}`]],
        [`UPDATE ratio.ingest_batches SET status = 'quarantined', quarantine_reason = $2 WHERE id = $1`, [a.batchStaged, `bad: ${v}`]],
        [
          `INSERT INTO ratio.ingest_validation_errors (tenant_id, batch_id, error_ordinal, artifact_sha256, code, message)
           VALUES ($1, $2, 7, $3, 'X', $4)`,
          [a.tenantId, a.batchStaged, artifactSha(a.slug, a.batchStaged), `token ${v}`],
        ],
        [`UPDATE ratio.ingest_artifacts SET artifact_name = $2 WHERE batch_id = $1`, [a.batchStaged, `s3/a.csv;${v.replace(/[?#]/g, ';')}`]],
      ];
      for (const [sql, params] of cases) {
        const r = await tryAsSuper(sql, params);
        expect(r, `${sql} <- ${v}`).toMatchObject({ ok: false, code: '23514' });
      }
    }
  });

  it('sync_runs.stats rejects secret-looking keys and values', async () => {
    for (const stats of [{ token: 'abc' }, { nested: { apiKey: 'x' } }, { last_url: 'https://u:p@host/x' }, { note: 'sig=abc' }]) {
      const r = await tryAsSuper(`UPDATE ratio.sync_runs SET stats = $2::jsonb WHERE tenant_id = $1`, [seed.a.tenantId, JSON.stringify(stats)]);
      expect(r, JSON.stringify(stats)).toMatchObject({ ok: false, code: '23514' });
    }
    const ok = await tryAsSuper(`UPDATE ratio.sync_runs SET stats = $2::jsonb WHERE tenant_id = $1`, [
      seed.a.tenantId,
      JSON.stringify({ rows: 10, retries: 1, periods: ['2026-08-01'] }),
    ]);
    expect(ok).toMatchObject({ ok: true });
  });

  it('the worker (not only the superuser) gets the same rejection — it can execute the guard functions', async () => {
    await withRole(db.pool, 'ratio_worker', seed.a.tenantId, async (c) => {
      expect(await attempt(c, `UPDATE ratio.sync_runs SET error_detail = 'Bearer abc' WHERE id = $1`, [seed.a.runNew])).toMatchObject({
        ok: false,
        code: '23514',
      });
      expect(await attempt(c, `UPDATE ratio.sync_runs SET error_detail = 'timeout after 30s' WHERE id = $1`, [seed.a.runNew])).toMatchObject({
        ok: true,
        rowCount: 1,
      });
    });
  });
});

describe('function privileges (L4)', () => {
  it('PUBLIC can execute no function in schema ratio; reader only current_tenant_id', async () => {
    const pub = await q(
      `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'ratio' AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0))`,
    );
    expect(pub).toEqual([]);
    const reader = await q(
      `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'ratio' AND has_function_privilege('ratio_reader', p.oid, 'EXECUTE') ORDER BY 1`,
    );
    expect(reader).toEqual([{ fn: 'ratio.current_tenant_id()' }]);
    const worker = await q(
      `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'ratio' AND p.prorettype <> 'trigger'::regtype AND NOT has_function_privilege('ratio_worker', p.oid, 'EXECUTE')`,
    );
    expect(worker).toEqual([]);
    // Trigger functions are not callable directly by anyone but the owner.
    const trig = await q(
      `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'ratio' AND p.prorettype = 'trigger'::regtype
         AND (has_function_privilege('ratio_worker', p.oid, 'EXECUTE') OR has_function_privilege('ratio_reader', p.oid, 'EXECUTE'))`,
    );
    expect(trig).toEqual([]);
  });

  it('reader cannot call the secret-guard helpers', async () => {
    await withRole(db.pool, 'ratio_reader', seed.a.tenantId, async (c) => {
      expect(await attempt(c, `SELECT ratio.jsonb_has_secret_like_key('{"a":1}')`)).toMatchObject({ ok: false, code: '42501' });
    });
  });
});

describe('constraint invariants', () => {
  it('only one running sync run per source', async () => {
    const a = seed.a;
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      const ins = `INSERT INTO ratio.sync_runs (tenant_id, id, source_id, run_kind, status, lease_token, lease_expires_at, heartbeat_at, attempt, started_at)
                   VALUES ($1, gen_random_uuid(), $2, 'scheduled', 'running', gen_random_uuid(), now() + interval '5 min', now(), 1, now())`;
      expect(await attempt(c, ins, [a.tenantId, a.sourceId])).toMatchObject({ ok: true });
      expect(await attempt(c, ins, [a.tenantId, a.sourceId])).toMatchObject({ ok: false, code: '23505' });
      // A running run must carry a lease.
      expect(
        await attempt(
          c,
          `INSERT INTO ratio.sync_runs (tenant_id, id, source_id, run_kind, status, attempt, started_at)
           VALUES ($1, gen_random_uuid(), $2, 'scheduled', 'running', 1, now())`,
          [seed.b.tenantId, seed.b.sourceId],
        ),
      ).toMatchObject({ ok: false, code: '23514' });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('only one published batch per source+period', async () => {
    const r = await tryAsSuper(`UPDATE ratio.ingest_batches SET status = 'published', superseded_at = NULL WHERE id = $1`, [
      seed.a.batchSuperseded,
    ]);
    expect(r).toMatchObject({ ok: false, code: '23505' });
  });

  it('billing_period must be the first of the month', async () => {
    const a = seed.a;
    const r = await tryAsSuper(
      `INSERT INTO ratio.ingest_batches (tenant_id, id, source_id, run_id, billing_period, artifact_set_fingerprint, status, row_count, loaded_billed_total, reconciliation, is_provisional)
       VALUES ($1, gen_random_uuid(), $2, $3, '2026-08-15', repeat('a', 64), 'staged', 0, 0, 'unverified', false)`,
      [a.tenantId, a.sourceId, a.runNew],
    );
    expect(r).toMatchObject({ ok: false, code: '23514' });
  });

  it('billing_currency must be an ISO-4217-shaped code', async () => {
    const a = seed.a;
    const r = await tryAsSuper(`UPDATE ratio.cost_facts SET billing_currency = 'usd' WHERE tenant_id = $1 AND batch_id = $2`, [
      a.tenantId,
      a.batchStaged,
    ]);
    expect(r).toMatchObject({ ok: false, code: '23514' });
  });

  it('a quarantined batch must carry a reason; status rejected no longer exists', async () => {
    // Exercised on the staged batch: staged -> quarantined is a legal transition,
    // so these reach the CHECK constraints (non-staged batches are frozen, see immutability tests).
    expect(
      await tryAsSuper(`UPDATE ratio.ingest_batches SET status = 'quarantined', quarantine_reason = NULL WHERE id = $1`, [seed.a.batchStaged]),
    ).toMatchObject({ ok: false, code: '23514' });
    expect(
      await tryAsSuper(`UPDATE ratio.ingest_batches SET status = 'rejected', quarantine_reason = 'x' WHERE id = $1`, [seed.a.batchStaged]),
    ).toMatchObject({ ok: false, code: '23514' });
    expect(
      await tryAsSuper(`UPDATE ratio.ingest_batches SET validation_error_count = -1 WHERE id = $1`, [seed.a.batchStaged]),
    ).toMatchObject({ ok: false, code: '23514' });
    expect(
      await tryAsSuper(
        `UPDATE ratio.ingest_batches SET status = 'quarantined', quarantine_reason = 'MISSING_COLUMN', validation_error_count = 3 WHERE id = $1`,
        [seed.a.batchStaged],
      ),
    ).toMatchObject({ ok: true, rowCount: 1 });
  });

  it('validation errors are capped at 1000 stored rows per batch and need a known artifact', async () => {
    const a = seed.a;
    const sha = artifactSha(a.slug, a.batchStaged);
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      const ins = (ordinal: number, artifact: string, code = 'MISSING_COLUMN') =>
        attempt(
          c,
          `INSERT INTO ratio.ingest_validation_errors (tenant_id, batch_id, error_ordinal, artifact_sha256, code, message)
           VALUES ($1, $2, $3, $4, $5, 'BilledCost column missing')`,
          [a.tenantId, a.batchStaged, ordinal, artifact, code],
        );
      expect(await ins(1000, sha)).toMatchObject({ ok: true });
      expect(await ins(1, sha)).toMatchObject({ ok: true });
      expect(await ins(1001, sha)).toMatchObject({ ok: false, code: '23514' });
      expect(await ins(0, sha)).toMatchObject({ ok: false, code: '23514' });
      expect(await ins(1, sha)).toMatchObject({ ok: false, code: '23505' });
      expect(await ins(3, fp('unknown-artifact'))).toMatchObject({ ok: false, code: '23503' });
      expect(await ins(4, sha, 'lower case')).toMatchObject({ ok: false, code: '23514' });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('artifacts store a hex sha256 and the content-addressed evidence key only', async () => {
    const a = seed.a;
    const art = await q(`SELECT sha256, byte_size, evidence_key FROM ratio.ingest_artifacts WHERE batch_id = $1`, [a.batchPublished]);
    const sha = artifactSha(a.slug, a.batchPublished);
    expect(art).toEqual([{ sha256: sha, byte_size: '1024', evidence_key: evidenceKey(a.tenantId, a.sourceId, sha) }]);
    const bad: Array<[string, unknown[]]> = [
      [`UPDATE ratio.ingest_artifacts SET sha256 = 'XYZ' WHERE batch_id = $1`, [a.batchStaged]],
      [`UPDATE ratio.ingest_artifacts SET sha256 = upper(sha256) WHERE batch_id = $1`, [a.batchStaged]],
      [`UPDATE ratio.ingest_artifacts SET evidence_key = 'evidence/other/key' WHERE batch_id = $1`, [a.batchStaged]],
      [`UPDATE ratio.ingest_artifacts SET evidence_key = 's3://bucket/' || evidence_key WHERE batch_id = $1`, [a.batchStaged]],
      [`UPDATE ratio.ingest_artifacts SET evidence_key = evidence_key || '?X-Amz-Signature=abc' WHERE batch_id = $1`, [a.batchStaged]],
      [`UPDATE ratio.ingest_artifacts SET artifact_name = 'part.csv?sig=abc' WHERE batch_id = $1`, [a.batchStaged]],
      [`UPDATE ratio.ingest_artifacts SET byte_size = -1 WHERE batch_id = $1`, [a.batchStaged]],
    ];
    for (const [sql, params] of bad) {
      const r = await tryAsSuper(sql, params);
      expect(r.ok, sql).toBe(false);
      if (!r.ok) expect(['23514', '23503'], `${sql} -> ${r.code} ${r.message}`).toContain(r.code);
    }
  });

  it('a variance batch cannot be published', async () => {
    const r = await tryAsSuper(
      `UPDATE ratio.ingest_batches SET control_row_count = 99, reconciliation = 'variance', status = 'published', published_at = now() WHERE id = $1`,
      [seed.a.batchStaged],
    );
    expect(r).toMatchObject({ ok: false, code: '23514' });
  });
});

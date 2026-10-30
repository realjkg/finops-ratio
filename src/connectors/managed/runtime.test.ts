// M0a: the managed retrieval runtime. A registered retriever's ORIGINAL bytes
// are captured as evidence, then staged once per delivery through the import
// pipeline (stageAndSync, injected here as a fake). Failures carry a code and
// never fall back to sample or simulated data. SYNTHETIC data only.
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { OriginalsStore } from './evidence/capture';
import { RetrieverRegistry } from './registry';
import { ManagedError, managedSpecFrom, managedSpecFromEngagementFile, runManagedFetch, type Delivery, type FetchOptions, type ManagedRetriever, type RetrieverFactory } from './runtime';
import { SecretValue } from './secrets/resolve';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const SECRET = 'SYNTHETIC-api-key-9b1c77';
const CSV = Buffer.from('BilledCost,BillingCurrency\n1.23,USD\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function store(): OriginalsStore & { keys: string[]; bytes: Map<string, Buffer> } {
  const bytes = new Map<string, Buffer>();
  return {
    keys: [],
    bytes,
    async putBytes(key, b) {
      this.keys.push(key);
      if (bytes.has(key)) return 'exists';
      bytes.set(key, Buffer.from(b));
      return 'stored';
    },
  };
}

function fake(deliveries: Delivery[], over: Partial<ManagedRetriever> = {}): { factory: RetrieverFactory; seen: { params?: unknown; secret?: SecretValue } } {
  const seen: { params?: unknown; secret?: SecretValue } = {};
  const factory: RetrieverFactory = (ctx) => {
    seen.params = ctx.params;
    seen.secret = ctx.secret;
    return {
      describe: () => ({ connector: 'fake-connector', sourceKind: 'focus-export', schemaVersion: '1.0', dataset: 'SYNTHETIC export' }),
      probe: async () => ({}),
      listDeliveries: async () => deliveries,
      open: async (ref) => ({ bytes: CSV, identity: { kind: 'object', bucket: 'synthetic-bucket', key: String(ref), etag: 'etag-1' } }),
      ...over,
    };
  };
  return { factory, seen };
}

function setup(factory: RetrieverFactory, extra: Partial<FetchOptions> = {}) {
  const registry = new RetrieverRegistry();
  registry.register('fake-connector', factory);
  const originals = store();
  const stage = vi.fn(async () => ({ status: 'succeeded', periods: [{ billingPeriod: '2026-09-01', outcome: 'published' }] }));
  const resolveSecret = vi.fn((ref: string) => new SecretValue(ref, SECRET));
  const opts: FetchOptions = {
    tenantId: TENANT, sourceKey: 'managed-src', sourceId: SOURCE_ID, spec: { connector: 'fake-connector', params: { exportName: 'synthetic' }, secretRef: 'fake/key' },
    registry, originals, stage, resolveSecret, now: () => new Date('2026-10-28T00:00:00Z'), ...extra,
  };
  return { opts, originals, stage, resolveSecret };
}

const complete = (id = 'd1'): Delivery => ({ id, billingPeriod: '2026-09-01', completion: 'complete', objects: [{ name: 'part-1', ref: 'data/part-1.csv' }] });

describe('runManagedFetch', () => {
  it("a retriever's original bytes are captured, then normalized and staged exactly once", async () => {
    const { factory, seen } = fake([complete()]);
    const { opts, originals, stage, resolveSecret } = setup(factory);
    const r = await runManagedFetch(opts);
    expect(r.status).toBe('succeeded');
    expect(resolveSecret).toHaveBeenCalledWith('fake/key');
    expect(seen.secret?.reveal()).toBe(SECRET);
    expect(seen.params).toEqual({ exportName: 'synthetic' });
    expect(originals.keys).toEqual([`connector-originals/${TENANT}/${SOURCE_ID}/${sha(CSV)}`]);
    expect(stage).toHaveBeenCalledTimes(1);
    const arg = (stage.mock.calls[0] as unknown[])[0] as { objects: Array<{ name: string; bytes: Buffer }>; sourceKind: string; schemaVersion: string; provenance: Record<string, unknown>; secrets: string[] };
    expect(arg.objects).toEqual([{ name: 'part-1', bytes: CSV }]);
    expect(arg).toMatchObject({ sourceKind: 'focus-export', schemaVersion: '1.0', secrets: [SECRET] });
    expect(arg.provenance).toEqual({ connector: 'fake-connector', dataset: 'SYNTHETIC export', delivery: 'd1', originals: [{ sha256: sha(CSV), key: originals.keys[0], identity: { kind: 'object', bucket: 'synthetic-bucket', key: 'data/part-1.csv', etag: 'etag-1' }, retrievedAt: '2026-10-28T00:00:00.000Z' }] });
    expect(r.deliveries).toMatchObject([{ delivery: 'd1', outcome: 'staged', completion: 'complete', originals: [{ sha256: sha(CSV) }] }]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('a retriever error yields a code, nothing staged and no fallback; the secret is scrubbed', async () => {
    const { factory } = fake([], { listDeliveries: async () => { throw new ManagedError('LISTING_FAILED', `listing refused for key ${SECRET}`); } });
    const { opts, stage } = setup(factory);
    const r = await runManagedFetch(opts);
    expect(r).toMatchObject({ status: 'failed', error: { code: 'LISTING_FAILED', message: 'listing refused for key [redacted]' }, deliveries: [] });
    expect(stage).not.toHaveBeenCalled();
    // A foreign error is reported with fixed text (its message may carry payload values).
    const { factory: f2 } = fake([complete()], { open: async () => { throw new Error('row 7: 99.99 USD acct SYNTHETIC-123'); } });
    const s2 = setup(f2);
    const r2 = await runManagedFetch(s2.opts);
    expect(r2.status).toBe('failed');
    expect(r2.deliveries).toEqual([{ delivery: 'd1', billingPeriod: '2026-09-01', completion: 'complete', originals: [], outcome: 'failed', code: 'RETRIEVAL_FAILED', message: 'the connector failed while retrieving this delivery' }]);
    expect(s2.stage).not.toHaveBeenCalled();
  });

  it('an incomplete delivery is quarantined: originals kept as evidence, nothing staged', async () => {
    const { factory } = fake([{ ...complete(), completion: 'incomplete' }, { ...complete('d2'), billingPeriod: '2026-10-01' }]);
    const { opts, originals, stage } = setup(factory);
    const r = await runManagedFetch(opts);
    expect(r.status).toBe('failed');
    expect(r.deliveries.map((d) => [d.delivery, d.outcome, d.code ?? null])).toEqual([['d1', 'quarantined', 'DELIVERY_INCOMPLETE'], ['d2', 'staged', null]]);
    expect(originals.keys).toHaveLength(2);
    expect(stage).toHaveBeenCalledTimes(1);
  });

  it('staging outcomes are reported per delivery (refused, failed with its code)', async () => {
    const { factory } = fake([complete('d1'), { ...complete('d2'), billingPeriod: '2026-10-01' }]);
    const { opts, stage } = setup(factory);
    stage.mockResolvedValueOnce({ status: 'refused', error: { code: 'PERIOD_ALREADY_PUBLISHED' } } as never);
    stage.mockRejectedValueOnce(Object.assign(new Error(`bad ${SECRET}`), { code: 'DUPLICATE_ARTIFACT' }));
    const r = await runManagedFetch(opts);
    expect(r.status).toBe('failed');
    expect(r.deliveries.map((d) => [d.outcome, d.code])).toEqual([['refused', 'PERIOD_ALREADY_PUBLISHED'], ['failed', 'DUPLICATE_ARTIFACT']]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('an unregistered connector, an unresolvable secret or no deliveries never produce data', async () => {
    const { factory } = fake([complete()]);
    const a = setup(factory, { spec: { connector: 'not-registered', params: {} } });
    expect(await runManagedFetch(a.opts)).toMatchObject({ status: 'failed', error: { code: 'CONNECTOR_NOT_REGISTERED' } });
    const b = setup(factory, { resolveSecret: () => { throw Object.assign(new Error('secret fake/key is missing'), { code: 'SECRET_MISSING' }); } });
    expect(await runManagedFetch(b.opts)).toMatchObject({ status: 'failed', error: { code: 'SECRET_MISSING', message: 'secret fake/key is missing' } });
    expect(b.stage).not.toHaveBeenCalled();
    const s = setup(factory, { spec: () => { throw new ManagedError('SOURCE_NOT_IN_ENGAGEMENT_CONFIG', 'the engagement config has no source managed-src'); } });
    expect(await runManagedFetch(s.opts)).toMatchObject({ status: 'failed', connector: 'unknown', error: { code: 'SOURCE_NOT_IN_ENGAGEMENT_CONFIG' } });
    expect(s.stage).not.toHaveBeenCalled();
    const c = setup(fake([]).factory);
    expect(await runManagedFetch(c.opts)).toMatchObject({ status: 'succeeded', deliveries: [], note: 'the connector listed no deliveries for the range' });
  });
});

describe('managedSpecFrom', () => {
  it('reads the retrieval block of a source config, refusing anything that is not managed', () => {
    expect(managedSpecFrom({ layout: 'ratio-file-drop', retrieval: { kind: 'managed', connector: 'aws-data-exports', params: { a: 1 }, secretRef: 'aws/x' } })).toEqual({ connector: 'aws-data-exports', params: { a: 1 }, secretRef: 'aws/x' });
    expect(managedSpecFrom({ retrieval: { kind: 'managed', connector: 'opencost' } })).toEqual({ connector: 'opencost', params: {} });
    for (const bad of [{}, { retrieval: { kind: 'file-drop' } }, { retrieval: { kind: 'file-drop', connector: 'opencost' } }, { retrieval: { kind: 'managed' } }, { retrieval: { kind: 'managed', connector: 'x', secretRef: 7 } }, null]) {
      expect(() => managedSpecFrom(bad)).toThrow(ManagedError);
    }
  });
});

describe('managedSpecFromEngagementFile', () => {
  // The source row's config cannot hold the retrieval block (its CHECKs refuse keys such as
  // secretRef and connector), so the worker reads it from the engagement config (R1), by source id.
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-eng-'));
  const write = (dir: string, v: unknown) => {
    const f = path.join(dir, 'engagement.json');
    fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v));
    return f;
  };
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(SECRET);
      return (e as ManagedError).code;
    }
    return 'NO_ERROR';
  };

  it('returns the managed retrieval of the source with that id', () => {
    const d = tmp();
    try {
      const f = write(d, { tenantId: TENANT, sources: [{ id: 'other', retrieval: { kind: 'file-drop' } }, { id: 'managed-src', retrieval: { kind: 'managed', connector: 'opencost', params: { window: '1d' }, secretRef: 'k8s/opencost' } }] });
      expect(managedSpecFromEngagementFile(f, 'managed-src', TENANT)).toEqual({ connector: 'opencost', params: { window: '1d' }, secretRef: 'k8s/opencost' });
      expect(codeOf(() => managedSpecFromEngagementFile(f, 'other', TENANT))).toBe('SOURCE_NOT_MANAGED');
      expect(codeOf(() => managedSpecFromEngagementFile(f, 'missing', TENANT))).toBe('SOURCE_NOT_IN_ENGAGEMENT_CONFIG');
      expect(codeOf(() => managedSpecFromEngagementFile(write(d, `{"sources": [${SECRET}`), 'managed-src', TENANT))).toBe('ENGAGEMENT_CONFIG_INVALID');
      // A credential-looking secretRef is refused by the whole-config check (review rv149: as R1 does).
      expect(codeOf(() => managedSpecFromEngagementFile(write(d, { tenantId: TENANT, sources: [{ id: 'managed-src', retrieval: { kind: 'managed', connector: 'opencost', secretRef: 'A'.repeat(48) } }] }), 'managed-src', TENANT))).toBe('ENGAGEMENT_CONFIG_INVALID');
      expect(codeOf(() => managedSpecFromEngagementFile('relative.json', 'managed-src', TENANT))).toBe('ENGAGEMENT_CONFIG_INVALID');
      expect(codeOf(() => managedSpecFromEngagementFile(undefined, 'managed-src', TENANT))).toBe('ENGAGEMENT_CONFIG_INVALID');
      expect(codeOf(() => managedSpecFromEngagementFile(path.join(d, 'nope.json'), 'managed-src', TENANT))).toBe('ENGAGEMENT_CONFIG_INVALID');
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('runManagedFetch: review round (rv149)', () => {
  const withSecretIn = (s: string) => `x-${s}-y`;

  it('scrubs the secret from the WHOLE result, the logs and the staged provenance (ids, period, identity, describe)', async () => {
    const logs: unknown[] = [];
    const { factory } = fake([{ id: withSecretIn(SECRET), completion: 'complete', objects: [{ name: 'part-1', ref: 'r' }] }], {
      describe: () => ({ connector: 'fake-connector', sourceKind: 'focus-export', schemaVersion: '1.0', dataset: withSecretIn(SECRET) }),
      open: async () => ({ bytes: CSV, identity: { kind: 'object', bucket: withSecretIn(SECRET), key: `k?token=${SECRET}`, etag: SECRET } }),
    });
    const { opts, stage } = setup(factory, { log: (e, f) => logs.push([e, f]) });
    stage.mockResolvedValueOnce({ status: 'succeeded', note: `echo ${SECRET}` } as never);
    const r = await runManagedFetch(opts);
    expect(r.status).toBe('succeeded');
    const arg = (stage.mock.calls[0] as unknown[])[0] as { provenance: unknown };
    expect(JSON.stringify(arg.provenance)).not.toContain(SECRET);
    expect(JSON.stringify(arg.provenance)).toContain('[redacted]');
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r.deliveries[0].result)).toContain('[redacted]');
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it('a structured secret (key=value;...) is scrubbed by component; a connector can register derived secrets', async () => {
    const structured = 'client_id=SYNTHETIC-cid-1;private_key=PK-SYNTHETIC-SECRET-123';
    const derived = 'SYNTHETIC-derived-session-token';
    const seenValues: string[] = [];
    const factory: RetrieverFactory = (ctx) => {
      ctx.registerSecret(derived);
      return {
        describe: () => ({ connector: 'fake-connector', sourceKind: 'focus-export', schemaVersion: '1.0', dataset: 'd' }),
        probe: async () => ({}),
        listDeliveries: async () => {
          throw new ManagedError('AUTH_FAILED', `key PK-SYNTHETIC-SECRET-123 rejected; session ${derived}`);
        },
        open: async () => ({ bytes: CSV, identity: { kind: 'object', bucket: 'b', key: 'k' } }),
      };
    };
    const { opts } = setup(factory, { resolveSecret: (ref) => new SecretValue(ref, structured), onSecrets: (v) => seenValues.push(...v) });
    const r = await runManagedFetch(opts);
    expect(r.error).toEqual({ code: 'AUTH_FAILED', message: 'key [redacted] rejected; session [redacted]' });
    expect(seenValues).toEqual(expect.arrayContaining([structured, 'PK-SYNTHETIC-SECRET-123', derived]));
  });

  it('a secret straddling the message length cap is scrubbed before the cut (no fragment left)', async () => {
    const { factory } = fake([], { listDeliveries: async () => { throw new ManagedError('AUTH_FAILED', `${'x'.repeat(490)}${SECRET}`); } });
    const r = await runManagedFetch(setup(factory).opts);
    expect(r.error?.code).toBe('AUTH_FAILED');
    expect(r.error?.message).not.toContain(SECRET.slice(0, 8));
  });

  it('a retriever whose describe() throws is a failed result with a code, never a throw', async () => {
    const { factory } = fake([complete()], { describe: () => { throw new Error(`x ${SECRET}`); } });
    const { opts, stage } = setup(factory);
    const r = await runManagedFetch(opts);
    expect(r).toMatchObject({ status: 'failed', error: { code: 'RETRIEVAL_FAILED' } });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(stage).not.toHaveBeenCalled();
  });

  it('enforces --from/--to: out-of-range, period-less and duplicate-period deliveries are refused unopened', async () => {
    const opened: unknown[] = [];
    const { factory } = fake(
      [
        { id: 'old', billingPeriod: '2023-01-01', completion: 'complete', objects: [{ name: 'o', ref: 'old' }] },
        { id: 'none', completion: 'complete', objects: [{ name: 'o', ref: 'none' }] },
        { id: 'dupA', billingPeriod: '2026-09-01', completion: 'complete', objects: [{ name: 'o', ref: 'dupA' }] },
        { id: 'dupB', billingPeriod: '2026-09-01', completion: 'complete', objects: [{ name: 'o', ref: 'dupB' }] },
        { id: 'bad', billingPeriod: '2026-09-15', completion: 'complete', objects: [{ name: 'o', ref: 'bad' }] },
        { id: 'ok', billingPeriod: '2026-10-01', completion: 'complete', objects: [{ name: 'o', ref: 'ok' }] },
      ],
      { open: async (ref) => (opened.push(ref), { bytes: CSV, identity: { kind: 'object', bucket: 'b', key: String(ref) } }) },
    );
    const { opts, stage } = setup(factory, { range: { from: '2026-09', to: '2026-10' } });
    const r = await runManagedFetch(opts);
    expect(r.status).toBe('failed');
    expect(r.deliveries.map((d) => [d.delivery, d.outcome, d.code ?? null])).toEqual([
      ['old', 'refused', 'DELIVERY_OUT_OF_RANGE'],
      ['none', 'refused', 'DELIVERY_PERIOD_UNKNOWN'],
      ['dupA', 'refused', 'DELIVERY_PERIOD_DUPLICATE'],
      ['dupB', 'refused', 'DELIVERY_PERIOD_DUPLICATE'],
      ['bad', 'refused', 'DELIVERY_PERIOD_INVALID'],
      ['ok', 'staged', null],
    ]);
    expect(opened).toEqual(['ok']);
    expect(stage).toHaveBeenCalledTimes(1);
    expect((stage.mock.calls[0] as unknown[])[0]).toMatchObject({ period: '2026-10-01' });
  });

  it('a delivery listing no objects is refused, never staged as empty', async () => {
    const { factory } = fake([{ ...complete(), objects: [] }]);
    const { opts, stage } = setup(factory);
    const r = await runManagedFetch(opts);
    expect(r.deliveries[0]).toMatchObject({ outcome: 'refused', code: 'DELIVERY_EMPTY' });
    expect(stage).not.toHaveBeenCalled();
  });

  it('passes the delivery period to staging and reports rows of other periods it left out', async () => {
    const { factory } = fake([complete()]);
    const { opts, stage } = setup(factory);
    stage.mockResolvedValueOnce({ status: 'succeeded', files: [{ dataRows: 10 }], staged: [{ billingPeriod: '2026-09-01', records: 7 }] } as never);
    const r = await runManagedFetch(opts);
    expect((stage.mock.calls[0] as unknown[])[0]).toMatchObject({ period: '2026-09-01' });
    expect(r.deliveries[0]).toMatchObject({ outcome: 'staged', rowsOutsidePeriod: 3 });
  });

  it('a fetch that stages some deliveries and then fails says which were staged and published', async () => {
    const { factory } = fake([complete('d1'), { ...complete('d2'), billingPeriod: '2026-10-01' }]);
    const { opts, stage } = setup(factory);
    stage.mockResolvedValueOnce({ status: 'succeeded', periods: [{ billingPeriod: '2026-09-01', outcome: 'published' }] } as never);
    stage.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'STAGE_BROKE' }));
    const r = await runManagedFetch(opts);
    expect(r.status).toBe('failed');
    expect(r.partial).toEqual({
      staged: [{ delivery: 'd1', billingPeriod: '2026-09-01', published: ['2026-09-01'] }],
      message: '1 of 2 deliveries were staged before others failed; their published periods stand (re-run fetch for the rest)',
    });
  });

  it('refuses a delivery above the size cap before it is staged (no normalization)', async () => {
    const { factory } = fake([{ ...complete(), objects: [{ name: 'a', ref: 'a' }, { name: 'b', ref: 'b' }] }]);
    const { opts, stage, originals } = setup(factory, { maxDeliveryBytes: CSV.length + 1 });
    const r = await runManagedFetch(opts);
    expect(r.deliveries[0]).toMatchObject({ outcome: 'refused', code: 'IMPORT_TOO_LARGE', originals: [] });
    // Delta review: no original of an over-cap delivery is kept (all objects are opened and sized first).
    expect(originals.keys).toHaveLength(0);
    expect(stage).not.toHaveBeenCalled();
  });

  it('refuses a delivery whose retriever-declared size is above the cap before opening anything', async () => {
    const opened: unknown[] = [];
    const { factory } = fake([{ ...complete(), objects: [{ name: 'a', ref: 'a', size: 10 }, { name: 'b', ref: 'b', size: 2 ** 40 }] }], { open: async (ref) => (opened.push(ref), { bytes: CSV, identity: { kind: 'object', bucket: 'b', key: String(ref) } }) });
    const { opts, stage, originals } = setup(factory, { maxDeliveryBytes: 1024 });
    const r = await runManagedFetch(opts);
    expect(r.deliveries[0]).toMatchObject({ outcome: 'refused', code: 'IMPORT_TOO_LARGE' });
    expect(opened).toEqual([]);
    expect(originals.keys).toHaveLength(0);
    expect(stage).not.toHaveBeenCalled();
  });

  it('a range must be YYYY-MM (from <= to); anything else fails before the connector lists', async () => {
    for (const range of [{ from: '2026-09-01', to: '2026-09-01' }, { from: '2026-10', to: '2026-09' }, { from: '2026-9', to: '2026-10' }, { from: '2026-13', to: '2026-13' }]) {
      const list = vi.fn(async () => [complete()]);
      const { factory } = fake([], { listDeliveries: list });
      const r = await runManagedFetch(setup(factory, { range }).opts);
      expect(r, JSON.stringify(range)).toMatchObject({ status: 'failed', error: { code: 'INVALID_RANGE' } });
      expect(list).not.toHaveBeenCalled();
    }
    // The --from month and the --to month are both in range.
    const { factory } = fake([complete('s'), { ...complete('o'), billingPeriod: '2026-10-01' }]);
    const r = await runManagedFetch(setup(factory, { range: { from: '2026-09', to: '2026-10' } }).opts);
    expect(r.deliveries.map((d) => d.outcome)).toEqual(['staged', 'staged']);
  });

  it('a period-less delivery listed alongside others may duplicate their months: refused unopened', async () => {
    const opened: unknown[] = [];
    const { factory } = fake([complete('labeled'), { id: 'unlabeled', completion: 'complete', objects: [{ name: 'o', ref: 'u' }] }], { open: async (ref) => (opened.push(ref), { bytes: CSV, identity: { kind: 'object', bucket: 'b', key: String(ref) } }) });
    const { opts, stage } = setup(factory);
    const r = await runManagedFetch(opts);
    expect(r.deliveries.map((d) => [d.delivery, d.outcome, d.code ?? null])).toEqual([['labeled', 'staged', null], ['unlabeled', 'refused', 'DELIVERY_PERIOD_DUPLICATE']]);
    expect(opened).toEqual(['data/part-1.csv']);
    expect(stage).toHaveBeenCalledTimes(1);
    // Alone, a period-less delivery (no range) is staged for every period it holds.
    const solo = setup(fake([{ id: 'unlabeled', completion: 'complete', objects: [{ name: 'o', ref: 'u' }] }]).factory);
    expect((await runManagedFetch(solo.opts)).deliveries[0].outcome).toBe('staged');
  });
});

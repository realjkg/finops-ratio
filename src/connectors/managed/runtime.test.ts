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
    const { factory } = fake([{ ...complete(), completion: 'incomplete' }, complete('d2')]);
    const { opts, originals, stage } = setup(factory);
    const r = await runManagedFetch(opts);
    expect(r.status).toBe('failed');
    expect(r.deliveries.map((d) => [d.delivery, d.outcome, d.code ?? null])).toEqual([['d1', 'quarantined', 'DELIVERY_INCOMPLETE'], ['d2', 'staged', null]]);
    expect(originals.keys).toHaveLength(2);
    expect(stage).toHaveBeenCalledTimes(1);
  });

  it('staging outcomes are reported per delivery (refused, failed with its code)', async () => {
    const { factory } = fake([complete('d1'), complete('d2')]);
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
      const f = write(d, { sources: [{ id: 'other', retrieval: { kind: 'file-drop' } }, { id: 'managed-src', retrieval: { kind: 'managed', connector: 'opencost', params: { window: '1d' }, secretRef: 'k8s/opencost' } }] });
      expect(managedSpecFromEngagementFile(f, 'managed-src')).toEqual({ connector: 'opencost', params: { window: '1d' }, secretRef: 'k8s/opencost' });
      expect(codeOf(() => managedSpecFromEngagementFile(f, 'other'))).toBe('SOURCE_NOT_MANAGED');
      expect(codeOf(() => managedSpecFromEngagementFile(f, 'missing'))).toBe('SOURCE_NOT_IN_ENGAGEMENT_CONFIG');
      expect(codeOf(() => managedSpecFromEngagementFile(write(d, `{"sources": [${SECRET}`), 'managed-src'))).toBe('ENGAGEMENT_CONFIG_INVALID');
      expect(codeOf(() => managedSpecFromEngagementFile(write(d, { sources: [{ id: 'managed-src', retrieval: { kind: 'managed', connector: 'opencost', secretRef: 'A'.repeat(48) } }] }), 'managed-src'))).toBe('SOURCE_NOT_MANAGED');
      expect(codeOf(() => managedSpecFromEngagementFile('relative.json', 'managed-src'))).toBe('ENGAGEMENT_CONFIG_INVALID');
      expect(codeOf(() => managedSpecFromEngagementFile(undefined, 'managed-src'))).toBe('ENGAGEMENT_CONFIG_INVALID');
      expect(codeOf(() => managedSpecFromEngagementFile(path.join(d, 'nope.json'), 'managed-src'))).toBe('ENGAGEMENT_CONFIG_INVALID');
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SRMD_LABEL,
  SIMULATED_PROVIDER_RECORDS,
  SimulatedSrmdAdapter,
  compareMeasures,
  createSrmdAdapter,
  detectOverlap,
  formatNanos,
  parseNanos,
  resolveSrmdConfig,
  srmdMaturity,
  type ProviderCostRecord,
  type SrmdAdapter,
  type SrmdCostRecord,
} from './index';
import { egressViolations, scanDir } from './egressGuard.spec.helper';
import { envelopeViolations, readOnlyViolations, runSrmdContractTests } from './srmdContract.spec.helper';

const adapter = new SimulatedSrmdAdapter();
runSrmdContractTests(adapter, { providerRecords: SIMULATED_PROVIDER_RECORDS });

// Type-level guarantee: no key of the interface looks like a mutation.
type WriteKey = Extract<keyof SrmdAdapter, `${'create' | 'update' | 'delete' | 'put' | 'post' | 'write' | 'set' | 'add' | 'sync' | 'apply'}${string}`>;
const noWriteKeys: [WriteKey] extends [never] ? true : never = true;

const recs = async (a: SrmdAdapter = adapter) => {
  const r = await a.listCostRecords();
  return r.status === 'ok' ? r.data : [];
};

describe('read-only by construction', () => {
  it('has no write-shaped key in the interface type or the declared method list', () => {
    expect(noWriteKeys).toBe(true);
    expect(readOnlyViolations(adapter)).toEqual([]);
  });
  it('rejects a write method, a symbol-keyed method, a getter returning a function and a proxy', () => {
    class W extends SimulatedSrmdAdapter { async updateTags() {} }
    class Sym extends SimulatedSrmdAdapter { [Symbol.for('deleteAll')]() {} }
    class Getter extends SimulatedSrmdAdapter { get purgeAll() { return () => 1; } }
    const proxy = new Proxy(new SimulatedSrmdAdapter(), { get: (t, k, r) => (k in t ? Reflect.get(t, k, r) : () => 'write') });
    for (const bad of [new W(), new Sym(), new Getter(), proxy]) expect(readOnlyViolations(bad).length).toBeGreaterThan(0);
  });
});

describe('maturity and label are enforced on every channel', () => {
  const wrap = (patch: Partial<Record<keyof SrmdAdapter, (...a: never[]) => unknown>>): SrmdAdapter =>
    new Proxy(new SimulatedSrmdAdapter(), { get: (t, k, r) => (k in patch ? patch[k as keyof SrmdAdapter] : Reflect.get(t, k, r)) }) as SrmdAdapter;
  const base = new SimulatedSrmdAdapter();
  it('fails when a record claims more than simulated', async () => {
    const bad = wrap({ listCostRecords: async () => { const r = await base.listCostRecords(); if (r.status === 'ok') r.data[0].maturity = 'customer-validated'; return r; } });
    expect((await envelopeViolations(bad)).join()).toContain('customer-validated');
  });
  it('fails when the capability report or a response claims more than simulated', async () => {
    const cap = wrap({ discoverCapabilities: async () => ({ ...(await base.discoverCapabilities()), maturity: 'integration-tested' as const }) });
    expect((await envelopeViolations(cap)).join()).toContain('discoverCapabilities');
    const tot = wrap({ getControlTotals: async () => ({ ...(await base.getControlTotals()), maturity: 'customer-validated' as const }) });
    expect((await envelopeViolations(tot)).join()).toContain('getControlTotals');
  });
  it('fails closed when an envelope or its fields are missing, or the label or provenance is wrong', async () => {
    const none = wrap({ getControlTotals: async () => ({ status: 'ok', data: [] }) });
    expect((await envelopeViolations(none)).join()).toContain('maturity missing');
    const noEnv = wrap({ listTagTaxonomy: async () => undefined });
    expect((await envelopeViolations(noEnv)).join()).toContain('no envelope');
    const label = wrap({ listMigrations: async () => ({ ...(await base.listMigrations()), label: 'verified', provenance: 'observed' as const }) });
    expect((await envelopeViolations(label)).join()).toMatch(/label missing.*|provenance observed/);
  });
  it('throws when asked to allow more than simulated', async () => {
    await expect(envelopeViolations(adapter, 'integration-tested')).rejects.toThrow();
  });
  it('srmdMaturity is derived from what the adapters actually return', async () => {
    expect(await srmdMaturity()).toMatchObject({ ceiling: 'simulated', label: SRMD_LABEL, adapters: [{ id: 'srmd-simulated', maturity: 'simulated' }] });
    const hi = wrap({ listCostRecords: async () => { const r = await base.listCostRecords(); if (r.status === 'ok') r.data[1].maturity = 'customer-validated'; return r; } });
    expect((await srmdMaturity([hi])).ceiling).toBe('customer-validated');
    expect((await srmdMaturity([wrap({ getControlTotals: async () => ({ status: 'ok', data: [] }) })])).ceiling).toBe('unlabeled');
  });
});

describe('simulated adapter', () => {
  it('defaults to simulated maturity with the exact label', () => {
    expect(adapter.descriptor).toMatchObject({ provenance: 'simulated', label: 'simulated counterpart, contract unverified', maturity: 'simulated' });
  });
  it('discovers honestly: some capabilities unsupported or unknown, none invented', async () => {
    const caps = (await adapter.discoverCapabilities()).capabilities;
    expect(caps.migrations.status).toBe('unsupported');
    expect(caps.account_mapping.status).toBe('unknown');
    expect((await adapter.listAccountMappings()).status).toBe('unsupported');
  });
  it('contains the deliberately awkward cases and surfaces each in the overlap report', async () => {
    const all = await recs();
    expect(all.some((x) => x.kind === 'credit' && x.amountNanos < BigInt(0))).toBe(true);
    expect(all.some((x) => x.lateArrival)).toBe(true);
    expect(all.some((x) => x.kind === 'shared' && x.shared)).toBe(true);
    expect(all.some((x) => x.tags === null)).toBe(true);
    expect(all.some((x) => x.lineage.providerRecordId === null)).toBe(true);
    const out = detectOverlap(all, SIMULATED_PROVIDER_RECORDS);
    const by = (s: string) => out.candidates.filter((c) => c.srmd.lineage.srmdRecordId === s);
    expect(by('srmd-s1')[0]).toMatchObject({ status: 'overlap_candidate', basis: 'lineage_id' });
    expect(by('srmd-s8')[0].reasons.join()).toContain('currency');
    expect(by('srmd-s9')[0]).toMatchObject({ basis: 'amount_and_bill_identity', status: 'overlap_candidate' });
    expect(by('srmd-s4')[0]).toMatchObject({ status: 'offset_candidate' });
    expect(by('srmd-s5')[0]).toMatchObject({ status: 'restatement_candidate' });
    expect(by('srmd-s11')[0]).toMatchObject({ status: 'not_comparable' });
    expect(by('srmd-s6')[0].claimedByMultiple).toBe(true);
    expect(by('srmd-s10')[0].claimedByMultiple).toBe(true);
    expect(out.srmdUnmatched.map((r) => r.lineage.srmdRecordId)).toContain('srmd-s7');
  });
});

describe('money', () => {
  it('is exact where floats are not', () => {
    expect(parseNanos('0.1') + parseNanos('0.2')).toBe(parseNanos('0.3'));
    expect(formatNanos(parseNanos('-12.5'))).toBe('-12.500000000');
    expect(parseNanos('0.000000001')).toBe(BigInt(1));
    expect(parseNanos('9007199254.740993')).toBe(BigInt('9007199254740993000'));
  });
  it('rejects non-decimal input rather than guessing', () => {
    for (const bad of ['', '1e3', '1,5', '0.0000000001', 'abc']) expect(() => parseNanos(bad)).toThrow();
  });
});

describe('overlap detector', () => {
  const m = { name: 'EffectiveCost', includesCredits: true, amortized: true };
  const ident = { provider: 'p', billingAccountId: 'a', billingPeriod: '2026-09', currency: 'USD', measure: m };
  const prov = (id: string, amount: string, over: Partial<ProviderCostRecord> = {}): ProviderCostRecord => ({ ...ident, providerRecordId: id, amountNanos: parseNanos(amount), ...over });
  const srmd = (id: string, amount: string, providerId: string | null, over: Partial<SrmdCostRecord> = {}): SrmdCostRecord => ({
    provenance: 'simulated', label: SRMD_LABEL, maturity: 'simulated', kind: 'usage', tags: null, lateArrival: false, shared: null,
    ...ident, amountNanos: parseNanos(amount),
    lineage: { srmdRecordId: id, ratioRef: `r:${id}`, providerRecordId: providerId, upstreamSystem: 'x', observedAt: 't' },
    ...over,
  });
  const one = (s: SrmdCostRecord[], p: ProviderCostRecord[]) => detectOverlap(s, p);

  it('flags the same record on both paths without summing it', () => {
    const out = one([srmd('s1', '5', 'p1')], [prov('p1', '5')]);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toMatchObject({ status: 'overlap_candidate', basis: 'lineage_id', deltaNanos: BigInt(0), claimedByMultiple: false, multiProvider: false });
  });
  it('reports every provider record that shares an id, never collapsing them', () => {
    const out = one([srmd('s1', '10', 'p1')], [prov('p1', '10'), prov('p1', '99')]);
    expect(out.candidates.map((c) => c.deltaNanos)).toEqual([BigInt(0), parseNanos('-89')]);
    expect(out.candidates.every((c) => c.multiProvider)).toBe(true);
  });
  it('flags duplicate SRMD ids with the colliding records instead of matching them', () => {
    const a = srmd('dup', '5', 'p1');
    const b = srmd('dup', '6', 'p1');
    const out = one([a, b, srmd('ok', '1', null)], [prov('p1', '5')]);
    expect(out.duplicateSrmdIds).toEqual([{ srmdRecordId: 'dup', records: [a, b] }]);
    expect(out.candidates).toHaveLength(0);
    expect(out.providerUnmatched).toHaveLength(1);
  });
  it('does not coerce a different measure or currency', () => {
    expect(one([srmd('s', '5', 'p1', { measure: { ...m, name: 'BilledCost' } })], [prov('p1', '5')]).candidates[0]).toMatchObject({ status: 'not_comparable', deltaNanos: null });
    expect(one([srmd('s', '5', 'p1', { currency: 'EUR' })], [prov('p1', '5')]).candidates[0]).toMatchObject({ status: 'not_comparable', deltaNanos: null });
    expect(compareMeasures(m, { ...m, amortized: false })).toMatchObject({ comparable: false });
  });
  it('matches weakly when the id is absent or stale, but never across period, currency, account or resource', () => {
    for (const id of [null, 'gone']) {
      expect(one([srmd('s', '5', id)], [prov('p1', '5')]).candidates[0].basis).toBe('amount_and_bill_identity');
      for (const over of [{ billingPeriod: '2026-08' }, { currency: 'EUR' }, { billingAccountId: 'b' }, { resourceId: 'r1' }]) {
        const out = one([srmd('s', '5', id, over)], [prov('p1', '5')]);
        expect(out.candidates).toHaveLength(0);
        expect(out.srmdUnmatched).toHaveLength(1);
        expect(out.providerUnmatched).toHaveLength(1);
      }
    }
  });
  it('reports a no-id record with equal amount but a different measure as not_comparable', () => {
    const out = one([srmd('s', '5', null, { measure: { ...m, amortized: false } })], [prov('p1', '5')]);
    expect(out.candidates[0]).toMatchObject({ status: 'not_comparable', deltaNanos: null });
    expect(out.candidates[0].reasons).toContain('measure.amortized');
  });
  it('reports offsets, restatements and many-to-one claims, and respects kind', () => {
    expect(one([srmd('c', '-10', null, { kind: 'credit' })], [prov('p1', '10')]).candidates[0]).toMatchObject({ status: 'offset_candidate', deltaNanos: null });
    const late = one([srmd('l', '5', null, { billingPeriod: '2026-08', lateArrival: true })], [prov('p1', '5')]);
    expect(late.candidates[0].status).toBe('restatement_candidate');
    expect(one([srmd('l', '5', null, { billingPeriod: '2026-08' })], [prov('p1', '5')]).candidates).toHaveLength(0);
    const many = one([srmd('a', '3', 'p1'), srmd('b', '2', 'p1')], [prov('p1', '5')]);
    expect(many.candidates.map((c) => c.claimedByMultiple)).toEqual([true, true]);
    const shared = one([srmd('s', '5', null, { kind: 'shared' })], [prov('p1', '5')]);
    expect(shared.candidates).toHaveLength(0);
  });
  it('conserves every input record across the output buckets for random inputs', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    for (let i = 0; i < 80; i++) {
      const ps = Array.from({ length: rnd(6) }, () => prov(['a', 'b'][rnd(2)], ['10', '-10', '5'][rnd(3)], { billingAccountId: ['x', 'y'][rnd(2)] }));
      const ss = Array.from({ length: rnd(7) }, () =>
        srmd(['s1', 's2', 's3', 's4'][rnd(4)], ['10', '-10', '5'][rnd(3)], [null, 'a', 'b', 'zz'][rnd(4)], { billingAccountId: ['x', 'y'][rnd(2)], kind: (['usage', 'credit', 'shared'] as const)[rnd(3)], lateArrival: rnd(2) === 0, billingPeriod: ['2026-08', '2026-09'][rnd(2)] }));
      const out = one(ss, ps);
      const sBuckets = [...new Set(out.candidates.map((c) => c.srmd)), ...out.duplicateSrmdIds.flatMap((d) => d.records), ...out.srmdUnmatched];
      expect(sBuckets.length).toBe(ss.length);
      expect(new Set(sBuckets).size).toBe(ss.length);
      const pBuckets = [...new Set(out.candidates.map((c) => c.provider)), ...out.providerUnmatched];
      expect(pBuckets.length).toBe(ps.length);
      expect(new Set(pBuckets).size).toBe(ps.length);
    }
  });
});

describe('fail-closed configuration', () => {
  const OK = 'simulated://srmd-fixtures';
  it('is disabled with a reason when nothing is configured, and never throws on odd input', () => {
    expect(resolveSrmdConfig({})).toEqual({ enabled: false, reason: 'not_configured' });
    expect(createSrmdAdapter({}).enabled).toBe(false);
    for (const env of [null, undefined, 'x', 5, [], { SRMD_ENDPOINT: [OK] }, { SRMD_ENDPOINT: { a: 1 } }, { SRMD_ENDPOINT: 5 }, { SRMD_ENDPOINT: OK, SRMD_CREDENTIAL: ['k'] }, { SRMD_ENDPOINT: OK, SRMD_CREDENTIAL: 7 }]) {
      expect(resolveSrmdConfig(env as never)).toMatchObject({ enabled: false });
    }
    expect(resolveSrmdConfig(new Proxy({}, { get() { throw new Error('boom'); } }))).toMatchObject({ enabled: false });
  });
  it('refuses any target that is not exactly an allowlisted simulated one, without echoing it', () => {
    const r = resolveSrmdConfig({ SRMD_ENDPOINT: 'srmd.invalid/secret-path' });
    expect(r).toEqual({ enabled: false, reason: 'target_not_allowlisted' });
    expect(JSON.stringify(r)).not.toContain('secret-path');
    expect(resolveSrmdConfig({ SRMD_CREDENTIAL: 'x' })).toMatchObject({ enabled: false });
    for (const e of [`${OK}/extra`, OK.toUpperCase(), ` ${OK}`, `${OK} `, 'simulated://other', 'simulated://']) {
      expect(resolveSrmdConfig({ SRMD_ENDPOINT: e })).toEqual({ enabled: false, reason: 'target_not_allowlisted' });
    }
  });
  it('rejects credentials even for the simulated target, including whitespace-only ones', () => {
    for (const c of ['x', '   ', '\n']) {
      expect(resolveSrmdConfig({ SRMD_ENDPOINT: OK, SRMD_CREDENTIAL: c })).toEqual({ enabled: false, reason: 'credentials_not_accepted_in_this_build' });
    }
  });
  it('enables only the exact allowlisted simulated target', () => {
    const r = createSrmdAdapter({ SRMD_ENDPOINT: OK });
    expect(r.enabled && r.adapter.descriptor.provenance).toBe('simulated');
  });
});

describe('no network egress (structural guard)', () => {
  const root = '/virtual/srmd';
  const bad: [string, string][] = [
    ['computed global access', "const f = globalThis['fe' + 'tch'];"],
    ['Function constructor', "new Function('return fe' + 'tch')();"],
    ['http', "import * as h from 'http';"],
    ['net', "import * as h from 'net';"],
    ['undici', "import { request } from 'undici';"],
    ['node: prefix', "import 'node:net';"],
    ['outside directory', "import { x } from '../costsource/seed';"],
    ['dynamic import', "const m = await import('./types');"],
    ['EventSource', "const e = new EventSource('x');"],
    ['sendBeacon', "navigator.sendBeacon('x');"],
    ['Image', "new Image().src = 'x';"],
    ['fetch', "fetch('x');"],
    ['constructor chain', "(async () => {}).constructor('x')();"],
  ];
  it.each(bad)('rejects %s', (_n, src) => {
    expect(egressViolations(`${root}/x.ts`, src, root).length).toBeGreaterThan(0);
  });
  it('allows relative imports inside the directory', () => {
    expect(egressViolations(`${root}/x.ts`, "import { a } from './types'; export * from './money';", root)).toEqual([]);
  });
  it('scans every file in the directory tree, whatever its name, except the exempt test files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'srmd-guard-'));
    ['net', 'sub'].forEach((d) => mkdirSync(join(dir, d)));
    const call = "export const go = () => fetch('x');\n";
    for (const f of ['client2.ts', 'http-client.ts', 'net/c.ts', 'live.test.ts', 'sub/srmd.test.ts', 'a1.mjs']) writeFileSync(join(dir, f), call);
    ['data.json', 'srmd.test.ts'].forEach((f) => writeFileSync(join(dir, f), call));
    const found = scanDir(dir).join('\n');
    for (const f of ['client2.ts', 'http-client.ts', 'net/c.ts', 'live.test.ts', 'sub/srmd.test.ts', 'a1.mjs', 'data.json']) expect(found).toContain(f);
    expect(found).not.toMatch(/^srmd\.test\.ts/m);
  });
  it('finds nothing in the real module', () => {
    expect(scanDir(__dirname)).toEqual([]);
  });
});

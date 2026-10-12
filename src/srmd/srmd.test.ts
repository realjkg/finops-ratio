import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  READ_METHODS,
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
  type SrmdAdapter,
} from './index';
import { runSrmdContractTests } from './srmdContract.spec.helper';

const adapter = new SimulatedSrmdAdapter();
runSrmdContractTests(adapter, { providerRecords: SIMULATED_PROVIDER_RECORDS });

// Type-level guarantee: no key of the interface looks like a mutation.
type WriteKey = Extract<keyof SrmdAdapter, `${'create' | 'update' | 'delete' | 'put' | 'post' | 'write' | 'set' | 'add' | 'sync' | 'apply'}${string}`>;
const noWriteKeys: [WriteKey] extends [never] ? true : never = true;

describe('read-only by construction', () => {
  it('has no write-shaped key in the interface type or the declared method list', () => {
    expect(noWriteKeys).toBe(true);
    expect(READ_METHODS.every((m) => /^(list|get)/.test(m))).toBe(true);
  });
});

describe('simulated adapter', () => {
  it('is labeled everywhere and defaults to simulated maturity', async () => {
    expect(adapter.descriptor).toMatchObject({ provenance: 'simulated', label: SRMD_LABEL, maturity: 'simulated' });
    expect(SRMD_LABEL).toBe('simulated counterpart, contract unverified');
  });
  it('discovers honestly: some capabilities unsupported or unknown, none invented', async () => {
    const caps = (await adapter.discoverCapabilities()).capabilities;
    expect(caps.migrations.status).toBe('unsupported');
    expect(caps.account_mapping.status).toBe('unknown');
    expect(CAPABILITIES.every((c) => caps[c].reason)).toBe(true);
    expect((await adapter.listAccountMappings()).status).toBe('unsupported');
  });
  it('contains the deliberately awkward cases', async () => {
    const r = await adapter.listCostRecords();
    const recs = r.status === 'ok' ? r.data : [];
    expect(recs.some((x) => x.kind === 'credit' && x.amountNanos < BigInt(0))).toBe(true);
    expect(recs.some((x) => x.lateArrival)).toBe(true);
    expect(recs.some((x) => x.kind === 'shared' && x.shared)).toBe(true);
    expect(recs.some((x) => x.tags === null)).toBe(true);
    expect(recs.some((x) => x.lineage.providerRecordId === null)).toBe(true);
    const out = detectOverlap(recs, SIMULATED_PROVIDER_RECORDS);
    expect(out.candidates.map((c) => c.status)).toEqual(expect.arrayContaining(['overlap_candidate', 'not_comparable']));
    expect(out.candidates.some((c) => c.reasons.some((x) => x.includes('currency')))).toBe(true);
  });
  it('filters by billing period', async () => {
    const r = await adapter.listCostRecords({ billingPeriod: '2026-08' });
    expect(r.status === 'ok' && r.data.length > 0 && r.data.every((x) => x.billingPeriod === '2026-08')).toBe(true);
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
  const base = { provider: 'p', billingAccountId: 'a', billingPeriod: '2026-09', currency: 'USD', amountNanos: parseNanos('5'), measure: m };
  const prov = [{ ...base, providerRecordId: 'p1' }];
  const srmd = (over: object, id = 's1') => ({ ...adapterRecord(), ...base, ...over, lineage: { ...adapterRecord().lineage, srmdRecordId: id, ratioRef: `r:${id}`, providerRecordId: 'p1' } });
  function adapterRecord() {
    return {
      provenance: 'simulated', label: SRMD_LABEL, maturity: 'simulated', kind: 'usage', tags: null, lateArrival: false, shared: null,
      lineage: { srmdRecordId: 's', ratioRef: 'r', providerRecordId: null, upstreamSystem: 'x', observedAt: 't' },
    } as never as Parameters<typeof detectOverlap>[0][number];
  }
  it('flags the same record on both paths without summing it', () => {
    const out = detectOverlap([srmd({})], prov);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toMatchObject({ status: 'overlap_candidate', basis: 'lineage_id', deltaNanos: BigInt(0) });
  });
  it('does not coerce a different measure or currency', () => {
    expect(detectOverlap([srmd({ measure: { ...m, name: 'BilledCost' } })], prov).candidates[0]).toMatchObject({ status: 'not_comparable', deltaNanos: null });
    expect(detectOverlap([srmd({ currency: 'EUR' })], prov).candidates[0]).toMatchObject({ status: 'not_comparable', deltaNanos: null });
    expect(compareMeasures(m, { ...m, amortized: false })).toMatchObject({ comparable: false });
  });
  it('never matches on amount across different periods or currencies', () => {
    const noId = (o: object) => ({ ...srmd(o), lineage: { ...adapterRecord().lineage, providerRecordId: null } });
    expect(detectOverlap([noId({})], prov).candidates[0].basis).toBe('amount_and_bill_identity');
    expect(detectOverlap([noId({ billingPeriod: '2026-08' })], prov).candidates).toHaveLength(0);
    expect(detectOverlap([noId({ currency: 'EUR' })], prov).candidates).toHaveLength(0);
  });
});

describe('fail-closed configuration', () => {
  it('is disabled with a reason when nothing is configured', () => {
    expect(resolveSrmdConfig({})).toEqual({ enabled: false, reason: 'not_configured' });
    expect(createSrmdAdapter({}).enabled).toBe(false);
  });
  it('refuses any target that is not an allowlisted simulated one, without echoing it', () => {
    const r = resolveSrmdConfig({ SRMD_ENDPOINT: 'srmd.invalid/secret-path' });
    expect(r).toEqual({ enabled: false, reason: 'target_not_allowlisted' });
    expect(JSON.stringify(r)).not.toContain('secret-path');
    expect(resolveSrmdConfig({ SRMD_CREDENTIAL: 'x' })).toMatchObject({ enabled: false });
  });
  it('rejects credentials even for the simulated target', () => {
    expect(resolveSrmdConfig({ SRMD_ENDPOINT: 'simulated://srmd-fixtures', SRMD_CREDENTIAL: 'x' })).toEqual({ enabled: false, reason: 'credentials_not_accepted_in_this_build' });
  });
  it('enables only the allowlisted simulated target', () => {
    const r = createSrmdAdapter({ SRMD_ENDPOINT: 'simulated://srmd-fixtures' });
    expect(r.enabled && r.adapter.descriptor.provenance).toBe('simulated');
  });
});

describe('maturity report and no-egress', () => {
  it('never claims more than simulated', () => {
    const m = srmdMaturity();
    expect(m).toMatchObject({ ceiling: 'simulated', adapters: [{ id: 'srmd-simulated', maturity: 'simulated' }] });
    expect(m.adapters.every((a) => a.maturity === 'simulated')).toBe(true);
  });
  it('has no network code in the module sources', () => {
    const net = new RegExp(['\\bfet' + 'ch\\b', 'XMLHttp', 'WebSock', 'node:https?', 'axios', 'require\\(', 'import\\(', '://[a-z]*[.]'].join('|'));
    const files = readdirSync(__dirname).filter((f) => /^[A-Za-z]+\.ts$/.test(f) && !f.includes('.test') && !f.includes('.spec'));
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) expect(readFileSync(join(__dirname, f), 'utf8').match(net), f).toBeNull();
  });
});

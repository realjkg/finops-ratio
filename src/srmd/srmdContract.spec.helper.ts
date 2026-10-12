// Reusable contract suite a future real adapter must pass. Private helpers must
// stay off the adapter object (module-scope functions or #private fields).
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  MATURITY_ORDER,
  READ_METHODS,
  SRMD_LABEL,
  compareMeasures,
  detectOverlap,
  formatNanos,
  parseNanos,
  type Maturity,
  type ProviderCostRecord,
  type SrmdAdapter,
  type SrmdCostRecord,
  type SrmdResult,
} from './index';

const WRITE_VERB = /^(create|update|delete|remove|put|post|patch|write|set|add|upsert|insert|save|send|push|apply|sync|assign|approve|import|tag|submit|execute)/i;
const ALLOWED_KEYS: readonly (string | symbol)[] = [...READ_METHODS, 'discoverCapabilities'];
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

export interface ContractOptions {
  providerRecords: ProviderCostRecord[];
  /** Enforced at runtime: anything above 'simulated' throws. */
  maxMaturity?: Maturity;
}

/** Function-valued keys (string and symbol, whole prototype chain) outside the read allowlist, plus Proxy probes. */
export function readOnlyViolations(adapter: SrmdAdapter): string[] {
  const out: string[] = [];
  const names: (string | symbol)[] = [];
  for (let o: object | null = adapter; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Reflect.ownKeys(o)) {
      if (k === 'constructor') continue;
      const d = Object.getOwnPropertyDescriptor(o, k);
      let fn = typeof d?.value === 'function';
      if (d?.get) {
        try {
          fn = typeof d.get.call(adapter) === 'function';
        } catch {
          fn = true;
        }
      }
      if (fn) names.push(k);
    }
  }
  for (const k of names) {
    if (!ALLOWED_KEYS.includes(k)) out.push(`unexpected method ${String(k)}`);
    else if (typeof k === 'string' && WRITE_VERB.test(k)) out.push(`write verb ${k}`);
  }
  for (const k of ALLOWED_KEYS) if (!names.includes(k)) out.push(`missing ${String(k)}`);
  const probe = adapter as unknown as Record<string | symbol, unknown>;
  if (probe[`__probe_${Math.random().toString(36).slice(2)}`] !== undefined || probe[Symbol('probe')] !== undefined) {
    out.push('answers unknown keys (proxy-like adapter)');
  }
  return out;
}

/** Every envelope the adapter produces (descriptor, capability report, each response, each record) must be labeled and capped. */
export async function envelopeViolations(adapter: SrmdAdapter, max: Maturity = 'simulated'): Promise<string[]> {
  if (MATURITY_ORDER.indexOf(max) < 0 || MATURITY_ORDER.indexOf(max) > MATURITY_ORDER.indexOf('simulated')) {
    throw new Error(`maturity above 'simulated' is not allowed in this build (got ${String(max)})`);
  }
  const out: string[] = [];
  const check = (where: string, e: Partial<Record<'maturity' | 'provenance' | 'label', unknown>> | null | undefined): void => {
    if (!e) return void out.push(`${where}: no envelope`);
    const i = MATURITY_ORDER.indexOf(e.maturity as Maturity);
    if (i < 0) out.push(`${where}: maturity missing or unknown`);
    else if (i > MATURITY_ORDER.indexOf(max)) out.push(`${where}: maturity ${String(e.maturity)} above ${max}`);
    if (e.provenance !== 'simulated') out.push(`${where}: provenance ${String(e.provenance)}`);
    if (e.label !== SRMD_LABEL) out.push(`${where}: label missing or wrong`);
  };
  check('descriptor', adapter.descriptor);
  check('discoverCapabilities', await adapter.discoverCapabilities());
  const responses: SrmdResult<unknown>[] = [
    await adapter.listCostRecords(),
    await adapter.listTagTaxonomy(),
    await adapter.listAccountMappings(),
    await adapter.listMigrations(),
    await adapter.getControlTotals(),
  ];
  responses.forEach((r, i) => check(READ_METHODS[i], r));
  const recs = responses[0];
  if (recs.status === 'ok') (recs.data as SrmdCostRecord[]).forEach((r) => check(`record ${r?.lineage?.srmdRecordId}`, r));
  return out;
}

function okData<T>(r: SrmdResult<T>): T {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
  return r.data;
}

export function runSrmdContractTests(adapter: SrmdAdapter, opts: ContractOptions): void {
  const records = async (): Promise<SrmdCostRecord[]> => okData(await adapter.listCostRecords());

  describe('SRMD contract: read-only', () => {
    it('exposes exactly the declared read methods: no extra, symbol-keyed, proxied or write-verb member', () => {
      expect(readOnlyViolations(adapter)).toEqual([]);
    });
  });

  describe('SRMD contract: capability honesty', () => {
    it('reports every capability as supported, unsupported or unknown with a reason', async () => {
      const { capabilities } = await adapter.discoverCapabilities();
      expect(Object.keys(capabilities).sort()).toEqual([...CAPABILITIES].sort());
      for (const c of CAPABILITIES) {
        expect(['supported', 'unsupported', 'unknown']).toContain(capabilities[c].status);
        expect(capabilities[c].reason.length).toBeGreaterThan(0);
      }
    });
    it('returns unsupported (never data) for a method whose capability is not supported', async () => {
      const caps = (await adapter.discoverCapabilities()).capabilities;
      const calls = [
        ['cost_records', () => adapter.listCostRecords()],
        ['tags', () => adapter.listTagTaxonomy()],
        ['account_mapping', () => adapter.listAccountMappings()],
        ['migrations', () => adapter.listMigrations()],
        ['control_totals', () => adapter.getControlTotals()],
      ] as const;
      for (const [cap, call] of calls) {
        const r = await call();
        expect(r.status === 'ok').toBe(caps[cap].status === 'supported');
        if (r.status === 'unsupported') expect('data' in r).toBe(false);
      }
    });
    it('does not carry credit, shared or lineage data when that capability is not supported', async () => {
      const caps = (await adapter.discoverCapabilities()).capabilities;
      const recs = await records();
      if (caps.credits_refunds.status !== 'supported') expect(recs.some((r) => r.kind === 'credit')).toBe(false);
      if (caps.shared_cost_allocation.status !== 'supported') expect(recs.some((r) => r.kind === 'shared')).toBe(false);
      if (caps.lineage_ids.status !== 'supported') expect(recs.every((r) => r.lineage.providerRecordId === null)).toBe(true);
    });
  });

  describe('SRMD contract: labeling and maturity', () => {
    it('labels and caps the descriptor, capability report, every response and every record', async () => {
      expect(await envelopeViolations(adapter, opts.maxMaturity)).toEqual([]);
    });
  });

  describe('SRMD contract: reads', () => {
    it('is idempotent and returns deep copies that callers cannot use to alter the source', async () => {
      const first = await records();
      const snapshot = json(first);
      const capSnap = json(await adapter.discoverCapabilities());
      expect(json(await records())).toBe(snapshot);
      for (const r of first) {
        r.amountNanos += parseNanos('1');
        r.currency = 'XXX';
        r.measure.name = 'MUTATED';
        r.lineage.ratioRef = 'MUTATED';
        if (r.tags) r.tags.injected = 'x';
        r.shared?.allocatedTo.push('x');
      }
      first.length = 0;
      expect(json(await records())).toBe(snapshot);
      const caps = await adapter.discoverCapabilities();
      caps.capabilities.cost_records.status = 'unknown';
      expect(json(await adapter.discoverCapabilities())).toBe(capSnap);
      expect(json(await adapter.getControlTotals())).toBe(json(await adapter.getControlTotals()));
    });
    it('keeps lineage: provider record id -> SRMD record id -> Ratio ref', async () => {
      const recs = await records();
      expect(new Set(recs.map((r) => r.lineage.srmdRecordId)).size).toBe(recs.length);
      expect(new Set(recs.map((r) => r.lineage.ratioRef)).size).toBe(recs.length);
      for (const r of recs) {
        const l = r.lineage;
        expect([l.srmdRecordId, l.upstreamSystem].every(Boolean) && l.ratioRef.includes(l.srmdRecordId)).toBe(true);
        expect(l.providerRecordId === null || (typeof l.providerRecordId === 'string' && l.providerRecordId.length > 0)).toBe(true);
      }
    });
    it('keeps amounts exact (bigint nano units) and currency per record', async () => {
      for (const r of await records()) {
        expect([typeof r.amountNanos, r.currency]).toEqual(['bigint', expect.stringMatching(/^[A-Z]{3}$/)]);
        expect(parseNanos(formatNanos(r.amountNanos))).toBe(r.amountNanos);
      }
      for (const t of okData(await adapter.getControlTotals())) expect(typeof t.totalNanos).toBe('bigint');
    });
  });

  describe('SRMD contract: comparability and double counting', () => {
    it('reports not_comparable for differing measure or currency, with no coerced delta', async () => {
      for (const c of detectOverlap(await records(), opts.providerRecords).candidates) {
        const differs = c.srmd.currency !== c.provider.currency || !compareMeasures(c.srmd.measure, c.provider.measure).comparable;
        if (c.basis === 'lineage_id') expect(c.status === 'not_comparable').toBe(differs);
        if (c.status !== 'overlap_candidate') {
          expect(c.deltaNanos).toBeNull();
          expect(c.reasons.length).toBeGreaterThan(0);
        }
      }
    });
    it('reports overlap candidates without summing, dropping or mutating inputs; every record lands in exactly one bucket', async () => {
      const recs = await records();
      const before = json([recs, opts.providerRecords]);
      const out = detectOverlap(recs, opts.providerRecords);
      expect(out.candidates.length).toBeGreaterThan(0);
      expect(Object.keys(out).sort()).toEqual(['candidates', 'duplicateSrmdIds', 'providerUnmatched', 'srmdUnmatched']);
      const dup = out.duplicateSrmdIds.flatMap((d) => d.records);
      const seenS = [...new Set(out.candidates.map((c) => c.srmd)), ...dup, ...out.srmdUnmatched];
      expect(seenS.length).toBe(recs.length);
      expect(new Set(seenS).size).toBe(recs.length);
      const seenP = [...new Set(out.candidates.map((c) => c.provider)), ...out.providerUnmatched];
      expect(new Set(seenP).size).toBe(opts.providerRecords.length);
      expect(seenP.length).toBe(opts.providerRecords.length);
      expect(json([recs, opts.providerRecords])).toBe(before);
    });
  });
}

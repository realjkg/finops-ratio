// Reusable contract suite. A future real adapter must pass the same checks
// that the simulated one does; nothing here is specific to the simulation.
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
  type ProviderCostRecord,
  type SrmdAdapter,
  type SrmdCostRecord,
  type SrmdResult,
} from './index';

const WRITE_VERB = /^(create|update|delete|remove|put|post|patch|write|set|add|upsert|insert|save|send|push|apply|sync|assign|approve|import|tag|submit|execute)/i;

export interface ContractOptions {
  /** Provider-direct records that the adapter's SRMD view may overlap. */
  providerRecords: ProviderCostRecord[];
  /** Highest maturity this adapter may claim; defaults to the build ceiling. */
  maxMaturity?: 'simulated';
}

function methodNames(obj: object): string[] {
  const names = new Set<string>();
  for (let o: object | null = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) if (k !== 'constructor') names.add(k);
  }
  return [...names].filter((k) => typeof (obj as Record<string, unknown>)[k] === 'function');
}

function okData<T>(r: SrmdResult<T>): T {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
  return r.data;
}

export function runSrmdContractTests(adapter: SrmdAdapter, opts: ContractOptions): void {
  const max = opts.maxMaturity ?? 'simulated';
  const records = async (): Promise<SrmdCostRecord[]> => okData(await adapter.listCostRecords());

  describe('SRMD contract: read-only', () => {
    it('exposes exactly the declared read methods and no write verb', () => {
      const names = methodNames(adapter).filter((n) => n !== 'discoverCapabilities');
      expect([...names].sort()).toEqual([...READ_METHODS].sort());
      expect(names.filter((n) => WRITE_VERB.test(n))).toEqual([]);
    });
  });

  describe('SRMD contract: capability honesty', () => {
    it('reports every capability as supported, unsupported or unknown with a reason', async () => {
      const report = await adapter.discoverCapabilities();
      expect(Object.keys(report.capabilities).sort()).toEqual([...CAPABILITIES].sort());
      for (const c of CAPABILITIES) {
        expect(['supported', 'unsupported', 'unknown']).toContain(report.capabilities[c].status);
        expect(report.capabilities[c].reason.length).toBeGreaterThan(0);
      }
    });
    it('returns unsupported (never data) for a method whose capability is not supported', async () => {
      const caps = (await adapter.discoverCapabilities()).capabilities;
      const calls = {
        cost_records: () => adapter.listCostRecords(),
        tags: () => adapter.listTagTaxonomy(),
        account_mapping: () => adapter.listAccountMappings(),
        migrations: () => adapter.listMigrations(),
        control_totals: () => adapter.getControlTotals(),
      } as const;
      for (const [cap, call] of Object.entries(calls)) {
        const r = await call();
        const status = caps[cap as keyof typeof calls].status;
        expect(r.status === 'ok').toBe(status === 'supported');
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
    it('labels the descriptor and every response, and never claims more than the ceiling', async () => {
      const responses = [
        await adapter.listCostRecords(),
        await adapter.listTagTaxonomy(),
        await adapter.listAccountMappings(),
        await adapter.listMigrations(),
        await adapter.getControlTotals(),
      ];
      for (const r of [adapter.descriptor, ...responses]) {
        expect(MATURITY_ORDER.indexOf(r.maturity)).toBeLessThanOrEqual(MATURITY_ORDER.indexOf(max));
        if (r.provenance === 'simulated') {
          expect(r.label).toBe(SRMD_LABEL);
          expect(r.maturity).toBe('simulated');
        }
      }
      for (const rec of await records()) {
        expect(rec.provenance).toBe(adapter.descriptor.provenance);
        expect(rec.label).toBe(adapter.descriptor.label);
      }
    });
  });

  describe('SRMD contract: reads', () => {
    it('is idempotent and returns copies that callers cannot use to alter the source', async () => {
      const first = await records();
      expect(await records()).toEqual(first);
      first.forEach((r) => {
        r.amountNanos += parseNanos('1');
        r.currency = 'XXX';
      });
      first.length = 0;
      expect((await records()).length).toBeGreaterThan(0);
      expect(await adapter.getControlTotals()).toEqual(await adapter.getControlTotals());
    });
    it('keeps lineage: provider record id -> SRMD record id -> Ratio ref', async () => {
      const recs = await records();
      const providerIds = new Set(opts.providerRecords.map((p) => p.providerRecordId));
      expect(new Set(recs.map((r) => r.lineage.srmdRecordId)).size).toBe(recs.length);
      expect(new Set(recs.map((r) => r.lineage.ratioRef)).size).toBe(recs.length);
      for (const r of recs) {
        const l = r.lineage;
        expect(l.srmdRecordId).toBeTruthy();
        expect(l.ratioRef).toContain(l.srmdRecordId);
        expect(l.upstreamSystem).toBeTruthy();
        expect(l.providerRecordId === null || providerIds.has(l.providerRecordId)).toBe(true);
      }
    });
    it('keeps amounts exact (bigint nano units) and currency per record', async () => {
      for (const r of await records()) {
        expect(typeof r.amountNanos).toBe('bigint');
        expect(r.currency).toMatch(/^[A-Z]{3}$/);
        expect(parseNanos(formatNanos(r.amountNanos))).toBe(r.amountNanos);
      }
      for (const t of okData(await adapter.getControlTotals())) expect(typeof t.totalNanos).toBe('bigint');
    });
  });

  describe('SRMD contract: comparability and double counting', () => {
    it('reports not_comparable for differing measure or currency, with no coerced delta', async () => {
      const recs = await records();
      const out = detectOverlap(recs, opts.providerRecords);
      const byId = new Map(recs.map((r) => [r.lineage.srmdRecordId, r]));
      const prov = new Map(opts.providerRecords.map((p) => [p.providerRecordId, p]));
      for (const c of out.candidates) {
        const s = byId.get(c.srmdRecordId)!;
        const p = prov.get(c.providerRecordId)!;
        const differs = s.currency !== p.currency || !compareMeasures(s.measure, p.measure).comparable;
        expect(c.status === 'not_comparable').toBe(differs);
        if (differs) {
          expect(c.deltaNanos).toBeNull();
          expect(c.reasons.length).toBeGreaterThan(0);
        }
      }
    });
    it('reports overlap candidates without summing, dropping or mutating inputs', async () => {
      const recs = await records();
      const before = JSON.stringify([recs, opts.providerRecords], (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
      const out = detectOverlap(recs, opts.providerRecords);
      expect(out.candidates.length).toBeGreaterThan(0);
      expect(Object.keys(out).sort()).toEqual(['candidates', 'providerUnmatched', 'srmdUnmatched']);
      const seen = new Set([...out.candidates.map((c) => c.srmdRecordId), ...out.srmdUnmatched]);
      expect(seen.size).toBe(recs.length);
      expect(JSON.stringify([recs, opts.providerRecords], (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))).toBe(before);
    });
  });
}

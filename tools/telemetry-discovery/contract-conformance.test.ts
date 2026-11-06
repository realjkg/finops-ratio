// Telemetry discovery kit (status: synthetic-validated, runtime validation pending).
// The kit's Python shape checks are a port; these are the authoritative v1 validators run over the committed
// goldens, so a contract change that the kit does not follow fails here. Draft sidecars (proposals/) are
// deliberately outside any v1 contract and must never carry a v1 schemaVersion.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { validateAIUsageEvent, validateAllocation, validateFinancialRecord, validateRateCard } from '@/platform/contracts';

const ROOT = path.join(__dirname, 'expected', 'bypass');
const lines = (rel: string): unknown[] =>
  fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown);
const failures = (rows: unknown[], validate: (v: unknown) => { ok: boolean; problems?: string[] }) =>
  rows.map((r, i) => ({ i, res: validate(r) })).filter((x) => !x.res.ok).map((x) => ({ row: x.i, problems: x.res.problems }));

describe('telemetry discovery kit goldens conform to the v1 contracts', () => {
  it('usage events are valid ai-usage-event/1', () => {
    const rows = lines('records/usage_events.jsonl');
    expect(rows.length).toBe(46);
    expect(failures(rows, validateAIUsageEvent)).toEqual([]);
  });

  it('valuations and billing rows are valid ai-financial-record/1', () => {
    const rows = lines('records/financial_records.jsonl');
    expect(rows.length).toBeGreaterThan(0);
    expect(failures(rows, validateFinancialRecord)).toEqual([]);
  });

  it('GPU and shared-capacity allocations are valid allocation/1', () => {
    const rows = lines('records/allocations.jsonl');
    expect(rows.length).toBe(2);
    expect(failures(rows, validateAllocation)).toEqual([]);
  });

  it('rate cards are valid rate-card/1', () => {
    const cards = JSON.parse(fs.readFileSync(path.join(ROOT, 'records/rate_cards.json'), 'utf8')) as unknown[];
    expect(failures(cards, validateRateCard)).toEqual([]);
  });

  it('the same validators reject mutated goldens (the checks above are not vacuous)', () => {
    const ev = lines('records/usage_events.jsonl')[0] as Record<string, unknown>;
    const fin = lines('records/financial_records.jsonl')[0] as Record<string, unknown>;
    const alloc = lines('records/allocations.jsonl')[0] as Record<string, unknown> & { shares: { amount: string }[] };
    expect(validateAIUsageEvent({ ...ev, actorRef: 'person@example.com' }).ok).toBe(false);
    expect(validateAIUsageEvent({ ...ev, tokenUsage: { input: 12, accountingProfile: 'fixture-disjoint/1' } }).ok).toBe(false);
    expect(validateAIUsageEvent({ ...ev, estimatedCost: '0.1' }).ok).toBe(false);
    expect(validateFinancialRecord({ ...fin, amount: 0.1 }).ok).toBe(false);
    expect(validateFinancialRecord({ ...fin, rateCardRef: undefined }).ok).toBe(false);
    expect(validateAllocation({ ...alloc, unallocated: '0' }).ok).toBe(false);
  });

  it('draft sidecars never claim a v1 schema', () => {
    const dir = path.join(ROOT, 'proposals');
    for (const f of fs.readdirSync(dir)) {
      for (const row of lines(path.join('proposals', f)) as { schemaVersion?: string }[]) {
        expect(row.schemaVersion).toMatch(/^ratio\.[a-z-]+\/0-draft$/);
      }
    }
  });

  it('no golden file carries content canaries or email addresses', () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const hits = walk(ROOT).filter((f) => /RATIO-CANARY|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(fs.readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});

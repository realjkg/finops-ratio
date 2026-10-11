// Tests for reduceFindings: open/resolve lifecycle, hysteresis, idempotence,
// merge, severity escalation, pruning, caps and validation (checklist 2.3, 2.6).

import { describe, expect, it } from 'vitest';
import { detectAnomalies, type Finding, type FindingScope } from '@/detection/anomaly';
import { addDays } from '@/detection/dates';
import { reduceFindings, type FindingRecord, type LifecycleResult } from '@/detection/lifecycle';
import { dayAt, synth } from '@/detection/testkit';
import { DetectionError, LIMITS } from '@/detection/types';

const D0 = '2026-03-01';
const day = (n: number): string => addDays(D0, n);

interface FindingOver extends Partial<Omit<Finding, 'key'>> {
  asOf: string;
}

function finding(over: FindingOver): Finding {
  const { asOf, ...rest } = over;
  const scope: FindingScope = rest.scope ?? 'leaf';
  const tenant = rest.tenant ?? 't1';
  const currency = rest.currency ?? 'USD';
  const scopeKey = rest.scopeKey ?? 'a|S';
  const direction = rest.direction ?? 'up';
  const source = rest.source ?? 'statistical';
  return {
    key: `${scope}|${tenant}|${currency}|${scopeKey}|${direction}|${source}`,
    scope,
    scopeKey,
    tenant,
    currency,
    source,
    category: 'spend_spike',
    direction,
    severity: 'warning',
    startDay: asOf,
    lastDay: asOf,
    windowDays: 1,
    actual: 1500,
    expected: 1000,
    impact: 500,
    meanDailyExcess: 500,
    relative: 0.5,
    todayExcess: 500,
    minImpact: 100,
    cumulativeCriticalImpact: 5000,
    detectors: ['residual_1d'],
    memberCount: 1,
    memberKeys: [`${tenant}|${currency}|${scopeKey}`],
    memberKeysTruncated: false,
    contributors: [],
    otherExcess: 0,
    otherCount: 0,
    estimated: false,
    ...rest,
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof DetectionError ? err.code : 'NOT_A_DETECTION_ERROR';
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}

function run(timeline: { asOf: string; findings: Finding[] }[], options?: Parameters<typeof reduceFindings>[3]): LifecycleResult[] {
  let records: readonly FindingRecord[] = [];
  const out: LifecycleResult[] = [];
  for (const step of timeline) {
    const r = reduceFindings(records, step.findings, step.asOf, options);
    records = r.records;
    out.push(r);
  }
  return out;
}

describe('open and continue', () => {
  it('opens a record for a new finding with an id built from the key and the opening day', () => {
    const f = finding({ asOf: day(0) });
    const r = reduceFindings([], [f], day(0));
    expect(r.records).toHaveLength(1);
    const rec = r.records[0] as FindingRecord;
    expect(rec.id).toBe(`${f.key}@${day(0)}`);
    expect(rec.status).toBe('open');
    expect(rec.openedDay).toBe(day(0));
    expect(rec.daysObserved).toBe(1);
    expect(rec.cumulativeImpact).toBe(500);
    expect(rec.resolvedDay).toBeNull();
    expect(r.events).toEqual([{ type: 'opened', recordId: rec.id, key: f.key, severity: 'warning', reason: null, mergedInto: null }]);
  });

  it('continues the same record on later days and accumulates the daily excess', () => {
    const steps = run([0, 1, 2].map((n) => ({ asOf: day(n), findings: [finding({ asOf: day(n), todayExcess: 100 * (n + 1) })] })));
    const last = steps[2] as LifecycleResult;
    expect(last.records).toHaveLength(1);
    expect(last.records[0]?.daysObserved).toBe(3);
    expect(last.records[0]?.cumulativeImpact).toBe(600);
    expect(last.records[0]?.lastSeenDay).toBe(day(2));
    expect(last.records[0]?.openedDay).toBe(day(0));
    expect(last.events.filter((e) => e.type === 'opened')).toEqual([]);
  });

  it('returns nothing for no findings and no records', () => {
    expect(reduceFindings([], [], day(0))).toEqual({ records: [], events: [] });
  });
});

describe('idempotence', () => {
  it('applying the same day twice yields identical records and no further events', () => {
    const f = finding({ asOf: day(1), todayExcess: 400 });
    const first = reduceFindings([], [finding({ asOf: day(0) })], day(0));
    const a = reduceFindings(first.records, [f], day(1));
    const b = reduceFindings(a.records, [f], day(1));
    expect(b.records).toEqual(a.records);
    expect(b.events).toEqual([]);
    const c = reduceFindings(b.records, [f], day(1));
    expect(c.records).toEqual(a.records);
  });

  it('is idempotent when the day included an opening, an escalation and a resolution', () => {
    const lo = finding({ asOf: day(0), scopeKey: 'old|S', severity: 'info' });
    const keep = finding({ asOf: day(0), scopeKey: 'keep|S', severity: 'info' });
    const s0 = reduceFindings([], [lo, keep], day(0));
    const today = [finding({ asOf: day(4), scopeKey: 'keep|S', severity: 'critical' }), finding({ asOf: day(4), scopeKey: 'new|S' })];
    const a = reduceFindings(s0.records, today, day(4));
    expect(a.events.map((e) => e.type).sort()).toEqual(['escalated', 'opened', 'resolved']);
    const b = reduceFindings(a.records, today, day(4));
    expect(b.records).toEqual(a.records);
    expect(b.events).toEqual([]);
  });

  it('is idempotent for merges', () => {
    const leafA = finding({ asOf: day(0), scopeKey: 'x|A', memberKeys: ['k1'] });
    const s0 = reduceFindings([], [leafA], day(0));
    const group = finding({ asOf: day(1), scope: 'account', scopeKey: 'x', memberKeys: ['k1', 'k2', 'k3'], memberCount: 3 });
    const a = reduceFindings(s0.records, [group], day(1));
    const b = reduceFindings(a.records, [group], day(1));
    expect(b.records).toEqual(a.records);
    expect(b.events).toEqual([]);
  });

  it('does not count a day twice when a finding is re-reported with a changed amount', () => {
    const a = reduceFindings([], [finding({ asOf: day(0), todayExcess: 100 })], day(0));
    const b = reduceFindings(a.records, [finding({ asOf: day(0), todayExcess: 100, impact: 999 })], day(0));
    expect(b.records[0]?.cumulativeImpact).toBe(100);
    expect(b.records[0]?.daysObserved).toBe(1);
    expect(b.records[0]?.latest.impact).toBe(999);
  });
});

describe('hysteresis: no flapping', () => {
  it('stays open through two unseen days and continues the same record when the finding returns', () => {
    const f = (n: number) => finding({ asOf: day(n) });
    const out = run([
      { asOf: day(0), findings: [f(0)] },
      { asOf: day(1), findings: [f(1)] },
      { asOf: day(2), findings: [] },
      { asOf: day(3), findings: [] },
      { asOf: day(4), findings: [f(4)] },
    ]);
    expect(out[3]?.records[0]?.status).toBe('open');
    const last = out[4] as LifecycleResult;
    expect(last.records).toHaveLength(1);
    expect(last.records[0]?.status).toBe('open');
    expect(last.records[0]?.openedDay).toBe(day(0));
    expect(last.records[0]?.daysObserved).toBe(3);
  });

  it('resolves exactly when it has been unseen for three whole days (not before)', () => {
    const f = finding({ asOf: day(0) });
    const out = run([
      { asOf: day(0), findings: [f] },
      { asOf: day(1), findings: [] },
      { asOf: day(2), findings: [] },
      { asOf: day(3), findings: [] },
    ]);
    expect(out[2]?.records[0]?.status).toBe('open');
    const resolved = out[3] as LifecycleResult;
    expect(resolved.records[0]?.status).toBe('resolved');
    expect(resolved.records[0]?.resolveReason).toBe('auto_recovered');
    expect(resolved.records[0]?.resolvedDay).toBe(day(3));
    expect(resolved.events).toEqual([
      { type: 'resolved', recordId: resolved.records[0]?.id, key: f.key, severity: 'warning', reason: 'auto_recovered', mergedInto: null },
    ]);
  });

  it('a finding that flickers on and off every other day produces one record for 20 days', () => {
    const timeline = Array.from({ length: 20 }, (_, n) => ({
      asOf: day(n),
      findings: n % 2 === 0 ? [finding({ asOf: day(n) })] : [],
    }));
    const out = run(timeline);
    const last = out[19] as LifecycleResult;
    expect(last.records).toHaveLength(1);
    expect(last.records[0]?.status).toBe('open');
    expect(out.flatMap((r) => r.events).filter((e) => e.type === 'opened')).toHaveLength(1);
    expect(out.flatMap((r) => r.events).filter((e) => e.type === 'resolved')).toHaveLength(0);
  });

  it('honors a different resolve window and refuses an invalid one', () => {
    const f = finding({ asOf: day(0) });
    const out = run(
      [
        { asOf: day(0), findings: [f] },
        { asOf: day(1), findings: [] },
      ],
      { resolveAfterDays: 1 },
    );
    expect(out[1]?.records[0]?.status).toBe('resolved');
    for (const bad of [0, 15, 1.5, Number.NaN, '3']) {
      expect(codeOf(() => reduceFindings([], [], day(0), { resolveAfterDays: bad as never }))).toBe('OPTIONS_INVALID');
    }
    expect(codeOf(() => reduceFindings([], [], day(0), { retainResolvedDays: 0 }))).toBe('OPTIONS_INVALID');
    expect(codeOf(() => reduceFindings([], [], day(0), null as never))).toBe('OPTIONS_INVALID');
  });

  it('never reopens a resolved record: the key returning opens a new one', () => {
    const out = run([
      { asOf: day(0), findings: [finding({ asOf: day(0) })] },
      { asOf: day(1), findings: [] },
      { asOf: day(2), findings: [] },
      { asOf: day(3), findings: [] },
      { asOf: day(9), findings: [finding({ asOf: day(9) })] },
    ]);
    const last = out[4] as LifecycleResult;
    expect(last.records).toHaveLength(2);
    expect(last.records.map((r) => r.status).sort()).toEqual(['open', 'resolved']);
    const ids = last.records.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    expect(last.records.find((r) => r.status === 'open')?.openedDay).toBe(day(9));
  });
});

describe('severity and category', () => {
  it('severity only goes up while open, and escalation emits one event', () => {
    const sev = (n: number, severity: Finding['severity']) => ({ asOf: day(n), findings: [finding({ asOf: day(n), severity })] });
    const out = run([sev(0, 'warning'), sev(1, 'info'), sev(2, 'critical'), sev(3, 'warning')]);
    expect(out[1]?.records[0]?.severity).toBe('warning');
    expect(out[2]?.records[0]?.severity).toBe('critical');
    expect(out[2]?.events.map((e) => e.type)).toEqual(['escalated']);
    expect(out[3]?.records[0]?.severity).toBe('critical');
    expect(out[3]?.events).toEqual([]);
  });

  it('escalates to critical when the cumulative impact reaches the clause, and not before', () => {
    const f = (n: number) => finding({ asOf: day(n), severity: 'warning', todayExcess: 2000, cumulativeCriticalImpact: 5000 });
    const out = run([0, 1, 2].map((n) => ({ asOf: day(n), findings: [f(n)] })));
    expect(out[0]?.records[0]?.severity).toBe('warning'); // 2000
    expect(out[1]?.records[0]?.severity).toBe('warning'); // 4000
    expect(out[2]?.records[0]?.severity).toBe('critical'); // 6000
    expect(out[2]?.events.map((e) => e.type)).toEqual(['escalated']);
    // At exactly the clause amount.
    const exact = run([0, 1].map((n) => ({ asOf: day(n), findings: [finding({ asOf: day(n), todayExcess: 2500, cumulativeCriticalImpact: 5000 })] })));
    expect(exact[1]?.records[0]?.severity).toBe('critical');
  });

  it('a single day at or above the clause opens as critical; decreases never escalate', () => {
    const big = reduceFindings([], [finding({ asOf: day(0), todayExcess: 5000, severity: 'warning' })], day(0));
    expect(big.records[0]?.severity).toBe('critical');
    const down = run([0, 1, 2, 3].map((n) => ({ asOf: day(n), findings: [finding({ asOf: day(n), direction: 'down', severity: 'info', todayExcess: -9000 })] })));
    expect(down[3]?.records[0]?.severity).toBe('info');
  });

  it('the category is sticky: a spike may become a shift, a shift is not relabelled', () => {
    const cat = (n: number, category: Finding['category']) => ({ asOf: day(n), findings: [finding({ asOf: day(n), category })] });
    const out = run([cat(0, 'spend_spike'), cat(1, 'level_shift'), cat(2, 'gradual_drift'), cat(3, 'spend_spike')]);
    expect(out[0]?.records[0]?.category).toBe('spend_spike');
    expect(out[1]?.records[0]?.category).toBe('level_shift');
    expect(out[2]?.records[0]?.category).toBe('level_shift');
    expect(out[3]?.records[0]?.category).toBe('level_shift');
  });
});

describe('merging narrower findings into a broader one', () => {
  const leaf = (n: number, svc: string, over: Partial<Finding> = {}) =>
    finding({ asOf: day(n), scope: 'leaf', scopeKey: `acct|${svc}`, memberKeys: [`t1|USD|acct|${svc}`], ...over });
  const account = (n: number, services: string[], over: Partial<Finding> = {}) =>
    finding({
      asOf: day(n),
      scope: 'account',
      scopeKey: 'acct',
      memberKeys: services.map((s) => `t1|USD|acct|${s}`),
      memberCount: services.length,
      ...over,
    });

  it('resolves absent leaf records as merged when an account finding covers them', () => {
    const out = run([
      { asOf: day(0), findings: [leaf(0, 'A'), leaf(0, 'B')] },
      { asOf: day(1), findings: [account(1, ['A', 'B', 'C'])] },
    ]);
    const last = out[1] as LifecycleResult;
    const survivor = last.records.find((r) => r.key.startsWith('account|')) as FindingRecord;
    const merged = last.records.filter((r) => r.resolveReason === 'merged');
    expect(survivor.status).toBe('open');
    expect(merged).toHaveLength(2);
    expect(merged.every((r) => r.mergedInto === survivor.id && r.status === 'resolved' && r.resolvedDay === day(1))).toBe(true);
    expect(last.events.filter((e) => e.type === 'resolved' && e.reason === 'merged')).toHaveLength(2);
  });

  it('does not merge when the broader finding does not cover the member, or differs in direction, source, currency or tenant', () => {
    const base = (survivor: Finding): LifecycleResult[] =>
      run([
        { asOf: day(0), findings: [leaf(0, 'A')] },
        { asOf: day(1), findings: [survivor] },
      ]);
    const notCovering = base(account(1, ['X', 'Y', 'Z']));
    expect(notCovering[1]?.records.filter((r) => r.resolveReason === 'merged')).toEqual([]);
    for (const over of [{ direction: 'down' as const }, { source: 'novelty' as const }, { currency: 'EUR' }, { tenant: 't2' }]) {
      const keyed = account(1, ['A', 'B', 'C'], over);
      const mismatched = { ...keyed, memberKeys: keyed.memberKeys.map((k) => k.replace('t1|USD', `${over.tenant ?? 't1'}|${over.currency ?? 'USD'}`)) };
      const out = base(mismatched);
      expect(out[1]?.records.filter((r) => r.resolveReason === 'merged'), JSON.stringify(over)).toEqual([]);
    }
  });

  it('does not merge into a narrower or equal scope, or a group whose member list was truncated', () => {
    const sameScope = run([
      { asOf: day(0), findings: [leaf(0, 'A')] },
      { asOf: day(1), findings: [leaf(1, 'B', { memberKeys: ['t1|USD|acct|A', 't1|USD|acct|B'] })] },
    ]);
    expect(sameScope[1]?.records.filter((r) => r.resolveReason === 'merged')).toEqual([]);
    const truncated = run([
      { asOf: day(0), findings: [leaf(0, 'A')] },
      { asOf: day(1), findings: [account(1, ['A', 'B', 'C'], { memberKeysTruncated: true })] },
    ]);
    expect(truncated[1]?.records.filter((r) => r.resolveReason === 'merged')).toEqual([]);
  });

  it('a record seen today is never merged away', () => {
    const out = run([
      { asOf: day(0), findings: [leaf(0, 'A')] },
      { asOf: day(1), findings: [leaf(1, 'A'), account(1, ['A', 'B', 'C'])] },
    ]);
    expect(out[1]?.records.filter((r) => r.resolveReason === 'merged')).toEqual([]);
    expect(out[1]?.records.filter((r) => r.status === 'open')).toHaveLength(2);
  });

  it('re-points merged records when their survivor is itself merged (pointers stay one level deep)', () => {
    const service = (n: number) =>
      finding({
        asOf: day(n),
        scope: 'service',
        scopeKey: 'A',
        memberKeys: ['t1|USD|acct|A', 't1|USD|acct2|A', 't1|USD|acct3|A', 't1|USD|acct|B'],
        memberCount: 4,
      });
    const out = run([
      { asOf: day(0), findings: [leaf(0, 'A')] },
      { asOf: day(1), findings: [account(1, ['A', 'B', 'C'])] },
      { asOf: day(2), findings: [service(2)] },
    ]);
    const last = out[2] as LifecycleResult;
    const svc = last.records.find((r) => r.key.startsWith('service|')) as FindingRecord;
    const acct = last.records.find((r) => r.key.startsWith('account|')) as FindingRecord;
    const lf = last.records.find((r) => r.key.startsWith('leaf|')) as FindingRecord;
    // The account group (members A, B, C) is not a subset of the service group (A, A, A, B), so it is not merged.
    expect(acct.status).toBe('open');
    expect(lf.mergedInto).not.toBeNull();
    expect(svc.status).toBe('open');
    // Now a service group that does cover the account group.
    const cover = finding({
      asOf: day(2),
      scope: 'tenant',
      scopeKey: '*',
      memberKeys: ['t1|USD|acct|A', 't1|USD|acct|B', 't1|USD|acct|C', 't1|USD|acct|D'],
      memberCount: 4,
    });
    const out2 = run([
      { asOf: day(0), findings: [leaf(0, 'A')] },
      { asOf: day(1), findings: [account(1, ['A', 'B', 'C'])] },
      { asOf: day(2), findings: [cover] },
    ]);
    const l2 = out2[2] as LifecycleResult;
    const top = l2.records.find((r) => r.key.startsWith('tenant|')) as FindingRecord;
    const merged = l2.records.filter((r) => r.resolveReason === 'merged');
    expect(merged).toHaveLength(2);
    for (const m of merged) expect(m.mergedInto).toBe(top.id);
    const byId = new Map(l2.records.map((r) => [r.id, r]));
    for (const m of merged) expect(byId.get(m.mergedInto as string)?.mergedInto).toBeNull();
  });
});

describe('pruning and caps', () => {
  it('keeps a resolved record 30 days and drops it on the 31st', () => {
    const base = run([
      { asOf: day(0), findings: [finding({ asOf: day(0) })] },
      { asOf: day(3), findings: [] },
    ]);
    const resolvedRecords = base[1]?.records as readonly FindingRecord[];
    expect(resolvedRecords[0]?.resolvedDay).toBe(day(3));
    expect(reduceFindings(resolvedRecords, [], day(3 + 30)).records).toHaveLength(1);
    expect(reduceFindings(resolvedRecords, [], day(3 + 31)).records).toHaveLength(0);
    expect(reduceFindings(resolvedRecords, [], day(3 + 31), { retainResolvedDays: 60 }).records).toHaveLength(1);
  });

  it('keeps an old resolved survivor while a retained merged record points at it', () => {
    const leafF = finding({ asOf: day(0), scopeKey: 'a|A', memberKeys: ['k1'] });
    const grp = finding({ asOf: day(1), scope: 'account', scopeKey: 'a', memberKeys: ['k1', 'k2', 'k3'], memberCount: 3 });
    const s0 = reduceFindings([], [leafF], day(0));
    const s1 = reduceFindings(s0.records, [grp], day(1));
    // The group stays quiet and resolves; the merged leaf resolved on day 1, the group on day 4.
    const s2 = reduceFindings(s1.records, [], day(4));
    const leafRec = s2.records.find((r) => r.resolveReason === 'merged') as FindingRecord;
    const groupRec = s2.records.find((r) => r.resolveReason === 'auto_recovered') as FindingRecord;
    expect(leafRec.resolvedDay).toBe(day(1));
    expect(groupRec.resolvedDay).toBe(day(4));
    // Day 33: the leaf (resolved day 1) is past 30 days, the group (day 4) is not, and the group is the leaf's target.
    const later = reduceFindings(s2.records, [], day(33));
    expect(later.records.map((r) => r.key.split('|')[0]).sort()).toEqual(['account']);
    // Day 36: both are old and unreferenced once the leaf is gone.
    expect(reduceFindings(later.records, [], day(36)).records).toHaveLength(0);
  });

  function minted(n: number, resolvedDay: string): FindingRecord[] {
    return Array.from({ length: n }, (_, i) => {
      const latest = finding({ asOf: resolvedDay, scopeKey: `acct${i}|S`, memberKeys: [`m${i}`] });
      return {
        id: `${latest.key}@${resolvedDay}`,
        key: latest.key,
        status: 'resolved' as const,
        category: 'spend_spike' as const,
        severity: 'warning' as const,
        openedDay: resolvedDay,
        lastSeenDay: resolvedDay,
        daysObserved: 1,
        cumulativeImpact: 1,
        cumulativeCriticalImpact: 5000,
        resolvedDay,
        resolveReason: 'auto_recovered' as const,
        mergedInto: null,
        latest,
      };
    });
  }

  it('accepts exactly the record cap and refuses one more record', () => {
    const atCap = minted(LIMITS.maxRecords, day(0));
    expect(reduceFindings(atCap, [], day(1)).records).toHaveLength(LIMITS.maxRecords);
    expect(codeOf(() => reduceFindings(atCap, [finding({ asOf: day(1), scopeKey: 'brand|new' })], day(1)))).toBe('RECORD_CAP_EXCEEDED');
    expect(codeOf(() => reduceFindings(minted(LIMITS.maxRecords + 1, day(0)), [], day(1)))).toBe('RECORD_CAP_EXCEEDED');
  });

  it('pruning makes room: at the cap with old records, a new finding fits', () => {
    const old = minted(LIMITS.maxRecords, day(0));
    const r = reduceFindings(old, [finding({ asOf: day(40), scopeKey: 'brand|new' })], day(40));
    expect(r.records).toHaveLength(1);
  });
});

describe('validation (fail closed, fixed text)', () => {
  const good = (): FindingRecord => reduceFindings([], [finding({ asOf: day(0) })], day(0)).records[0] as FindingRecord;

  it('refuses a finding whose last day is not the as-of day', () => {
    expect(codeOf(() => reduceFindings([], [finding({ asOf: day(0) })], day(1)))).toBe('FINDING_INVALID');
  });

  it('refuses malformed findings and duplicate keys', () => {
    const f = finding({ asOf: day(0) });
    const bad: unknown[] = [
      { ...f, severity: 'urgent' },
      { ...f, key: 'forged' },
      { ...f, impact: Number.NaN },
      { ...f, relative: 'x' },
      { ...f, memberKeys: 'a' },
      { ...f, memberKeys: Array.from({ length: LIMITS.maxMemberKeys + 1 }, (_, i) => `m${i}`) },
      { ...f, contributors: Array.from({ length: 11 }, () => ({})) },
      { ...f, currency: 'usd' },
      { ...f, startDay: '2026-02-30' },
      { ...f, estimated: 'yes' },
      null,
      'finding',
    ];
    for (const b of bad) expect(codeOf(() => reduceFindings([], [b as Finding], day(0)))).toBe('FINDING_INVALID');
    expect(codeOf(() => reduceFindings([], [f, f], day(0)))).toBe('FINDING_INVALID');
    expect(codeOf(() => reduceFindings([], 'x' as never, day(0)))).toBe('RECORD_INVALID');
  });

  it('refuses malformed or inconsistent previous records', () => {
    const r = good();
    const bad: unknown[] = [
      { ...r, status: 'closed' },
      { ...r, key: 'other' },
      { ...r, daysObserved: 0 },
      { ...r, lastSeenDay: day(-1) }, // before it opened
      { ...r, lastSeenDay: day(5) }, // after the as-of day
      { ...r, resolvedDay: day(0) }, // open record with a resolution
      { ...r, status: 'resolved', resolvedDay: day(0), resolveReason: 'merged', mergedInto: null },
      { ...r, status: 'resolved', resolvedDay: day(0), resolveReason: 'auto_recovered', mergedInto: 'x' },
      { ...r, cumulativeImpact: Number.POSITIVE_INFINITY },
      { ...r, latest: { ...r.latest, key: 'mismatch' } },
      null,
    ];
    for (const b of bad) expect(codeOf(() => reduceFindings([b as FindingRecord], [], day(1)))).toBe('RECORD_INVALID');
    expect(codeOf(() => reduceFindings([r, r], [], day(1)))).toBe('RECORD_INVALID'); // duplicate id
    expect(codeOf(() => reduceFindings([r, { ...r, id: 'another' }], [], day(1)))).toBe('RECORD_INVALID'); // two open, one key
    expect(codeOf(() => reduceFindings('x' as never, [], day(1)))).toBe('RECORD_INVALID');
  });

  it('refuses to go backwards in time', () => {
    const later = reduceFindings([], [finding({ asOf: day(5) })], day(5)).records;
    expect(codeOf(() => reduceFindings(later, [], day(4)))).toBe('RECORD_INVALID');
    expect(codeOf(() => reduceFindings(later, [], day(5)))).toBeUndefined();
  });

  it('refuses a bad as-of day', () => {
    expect(codeOf(() => reduceFindings([], [], '2026-02-30'))).toBe('AS_OF_INVALID');
  });

  it('never echoes input in error text', () => {
    const f = finding({ asOf: day(0) });
    try {
      reduceFindings([], [{ ...f, scopeKey: 'SECRET-THING' }], day(0));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET');
    }
  });
});

describe('determinism and purity', () => {
  it('does not depend on the order of the findings', () => {
    const a = finding({ asOf: day(0), scopeKey: 'a|A' });
    const b = finding({ asOf: day(0), scopeKey: 'b|B' });
    const c = finding({ asOf: day(0), scopeKey: 'c|C', severity: 'critical' });
    expect(reduceFindings([], [a, b, c], day(0))).toEqual(reduceFindings([], [c, a, b], day(0)));
  });

  it('does not mutate frozen inputs', () => {
    const prev = deepFreeze(reduceFindings([], [finding({ asOf: day(0) })], day(0)).records.slice());
    const cur = deepFreeze([finding({ asOf: day(1) })]);
    expect(() => reduceFindings(prev, cur, day(1))).not.toThrow();
  });
});

describe('end to end with the detector', () => {
  it('a step change is one open record from its first day, with a stable id', () => {
    const s = synth({ n: 90, base: 1000, noise: 0.03, seed: 2, mod: (i, v) => (i >= 80 ? v * 1.3 : v) });
    let records: readonly FindingRecord[] = [];
    const ids = new Set<string>();
    for (let d = 78; d <= 88; d += 1) {
      const { findings } = detectAnomalies([s], dayAt(d));
      records = reduceFindings(records, findings, dayAt(d)).records;
      for (const r of records) ids.add(r.id);
    }
    expect(ids.size).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('open');
    expect(records[0]?.openedDay).toBe(dayAt(80));
    expect(records[0]?.severity).toBe('warning');
    expect(records[0]?.daysObserved).toBeGreaterThanOrEqual(8);
  });

  it('a one-day spike opens on the spike and resolves after three quiet days', () => {
    const s = synth({ n: 95, base: 1000, noise: 0.03, seed: 1, mod: (i, v) => (i === 85 ? v * 4 : v) });
    let records: readonly FindingRecord[] = [];
    const status: string[] = [];
    for (let d = 84; d <= 90; d += 1) {
      records = reduceFindings(records, detectAnomalies([s], dayAt(d)).findings, dayAt(d)).records;
      status.push(records[0]?.status ?? 'none');
    }
    // d84 none, d85 open, d86 open, d87 open, d88 resolved (3 unseen days), then resolved.
    expect(status).toEqual(['none', 'open', 'open', 'open', 'resolved', 'resolved', 'resolved']);
    expect(records[0]?.resolveReason).toBe('auto_recovered');
    expect(records[0]?.resolvedDay).toBe(dayAt(88));
  });
});

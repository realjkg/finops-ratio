// Novelty, hierarchical grouping, ranked contributors and caps for detectAnomalies
// (checklist 2.2, 2.3, 2.6).

import { describe, expect, it } from 'vitest';
import { detectAnomalies } from '@/detection/anomaly';
import { mkSeries, START, dayAt, synth } from '@/detection/testkit';
import { DetectionError, LIMITS, type DailySeries } from '@/detection/types';

const AS_OF = dayAt(89);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof DetectionError ? err.code : 'NOT_A_DETECTION_ERROR';
  }
}

/** A quiet established series that jumps by `factor` on the last day when `spike` is set. */
function leaf(account: string, service: string, seed: number, spike: number | null, extra: Partial<Parameters<typeof synth>[0]> = {}): DailySeries {
  return synth({
    n: 90,
    base: 1000,
    noise: 0.03,
    seed,
    account,
    service,
    mod: spike === null ? undefined : (i, v) => (i === 89 ? v * spike : v),
    ...extra,
  });
}

describe('dimension novelty: new service', () => {
  const established = synth({ n: 100, base: 800, noise: 0.03, seed: 1, account: 'acct-a', service: 'Compute' });
  const newService = (value: number, from = 87, n = 100): DailySeries =>
    mkSeries({
      start: START,
      account: 'acct-a',
      service: 'Spanner',
      values: Array.from({ length: n }, (_, i) => (i >= from ? value : null)),
    });

  it('flags a new service in an established account from its first day, with no history needed', () => {
    const r = detectAnomalies([established, newService(400)], dayAt(87));
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f?.category).toBe('new_service');
    expect(f?.source).toBe('novelty');
    expect(f?.severity).toBe('warning');
    expect(f?.relative).toBeNull();
    expect(f?.scopeKey).toBe('acct-a|Spanner');
    expect(f?.detectors).toEqual(['novelty']);
    expect(f?.startDay).toBe(dayAt(87));
  });

  it('is critical at 10 times the minimum impact and warning just below', () => {
    expect(detectAnomalies([established, newService(1000)], dayAt(87)).findings[0]?.severity).toBe('critical');
    expect(detectAnomalies([established, newService(999.99)], dayAt(87)).findings[0]?.severity).toBe('warning');
    expect(detectAnomalies([established, newService(100)], dayAt(87)).findings[0]?.severity).toBe('warning');
  });

  it('ignores a new service below the minimum impact on every one of its first three days', () => {
    expect(detectAnomalies([established, newService(99.99)], dayAt(89)).findings).toEqual([]);
  });

  it('does not flag the first service of a brand-new account (onboarding, not novelty)', () => {
    const young = mkSeries({ start: dayAt(80), account: 'acct-new', service: 'Compute', values: [500, 500, 500] });
    const r = detectAnomalies([established, young], dayAt(82));
    expect(r.findings).toEqual([]);
  });

  it('requires the account to be older than the configured age', () => {
    const accountOnly = synth({ n: 100, base: 800, noise: 0.03, seed: 1, account: 'acct-a', service: 'Compute', start: dayAt(75) });
    const added = mkSeries({ start: START, account: 'acct-a', service: 'Spanner', values: Array.from({ length: 100 }, (_, i) => (i >= 87 ? 400 : null)) });
    // The account is 12 days old when Spanner appears: not novelty at the default 30 days...
    expect(detectAnomalies([accountOnly, added], dayAt(87)).findings).toEqual([]);
    // ...but it is when the age requirement is lowered to 7 days (the floor).
    const lowered = detectAnomalies([accountOnly, added], dayAt(87), { noveltyMinAccountAgeDays: 7 });
    expect(lowered.findings[0]?.category).toBe('new_service');
  });

  it('keeps the same finding key through the warm-up and stops after it', () => {
    const svc = newService(400, 80, 110);
    const a = detectAnomalies([established, svc], dayAt(80)).findings[0];
    const b = detectAnomalies([established, svc], dayAt(90)).findings[0];
    expect(a?.key).toBe(b?.key);
    expect(detectAnomalies([established, svc], dayAt(94)).findings).toEqual([]); // age 14 = warm-up over
  });
});

describe('dimension novelty: new region', () => {
  const east = synth({ n: 100, base: 800, noise: 0.03, seed: 1, account: 'acct-a', service: 'Compute', region: 'us-east-1' });
  const west = (value: number): DailySeries =>
    mkSeries({
      start: START,
      account: 'acct-a',
      service: 'Compute',
      region: 'eu-west-1',
      values: Array.from({ length: 100 }, (_, i) => (i >= 86 ? value : null)),
    });

  it('flags a new region of an established service, once, without a second statistical finding', () => {
    const r = detectAnomalies([east, west(900)], dayAt(88));
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f?.category).toBe('new_region');
    expect(f?.scope).toBe('region');
    expect(f?.scopeKey).toBe('acct-a|Compute|eu-west-1');
    expect(f?.contributors).toHaveLength(1);
    expect(f?.contributors[0]?.region).toBe('eu-west-1');
  });

  it('ignores a new region below the minimum impact', () => {
    expect(detectAnomalies([east, west(60)], dayAt(88)).findings).toEqual([]);
  });

  it('does not treat the first region of a fresh service as a new region', () => {
    const solo = synth({ n: 100, base: 800, noise: 0.03, seed: 1, account: 'acct-a', service: 'Only', region: 'us-east-1', start: dayAt(86) });
    const r = detectAnomalies([east, solo], dayAt(88));
    expect(r.findings.filter((f) => f.category === 'new_region')).toEqual([]);
  });
});

describe('hierarchical grouping: one root cause, one finding', () => {
  it('collapses four services of one account that spike together into one account finding', () => {
    const series = ['A', 'B', 'C', 'D'].map((svc, i) => leaf('acct-1', svc, i + 1, 4));
    const r = detectAnomalies(series, AS_OF);
    expect(r.stats.candidates).toBe(4);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f?.scope).toBe('account');
    expect(f?.scopeKey).toBe('acct-1');
    expect(f?.memberCount).toBe(4);
    expect(f?.memberKeys).toHaveLength(4);
    expect(f?.severity).toBe('critical');
    expect(f?.category).toBe('spend_spike');
  });

  it('does not group below the fan-in size: two services stay two findings', () => {
    const r = detectAnomalies([leaf('acct-1', 'A', 1, 4), leaf('acct-1', 'B', 2, 4)], AS_OF);
    expect(r.findings).toHaveLength(2);
    expect(r.findings.every((f) => f.scope === 'leaf')).toBe(true);
  });

  it('collapses the same service spiking in four accounts into one service finding', () => {
    const series = ['a1', 'a2', 'a3', 'a4'].map((acct, i) => leaf(acct, 'Compute', i + 1, 4));
    const r = detectAnomalies(series, AS_OF);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope).toBe('service');
    expect(r.findings[0]?.scopeKey).toBe('Compute');
    expect(r.findings[0]?.memberCount).toBe(4);
  });

  it('collapses a fleet-wide jump (six distinct accounts and services) into one tenant finding', () => {
    const series = Array.from({ length: 6 }, (_, i) => leaf(`acct-${i}`, `svc-${i}`, i + 1, 3));
    const r = detectAnomalies(series, AS_OF);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope).toBe('tenant');
    expect(r.findings[0]?.memberCount).toBe(6);
  });

  it('leaves unrelated leaves as separate findings next to a group', () => {
    const grouped = ['A', 'B', 'C'].map((svc, i) => leaf('acct-1', svc, i + 1, 4));
    const lone = leaf('acct-9', 'Z', 9, 4);
    const quiet = leaf('acct-7', 'Q', 8, null);
    const r = detectAnomalies([...grouped, lone, quiet], AS_OF);
    expect(r.findings.map((f) => f.scope).sort()).toEqual(['account', 'leaf']);
  });

  it('never groups increases with decreases', () => {
    const ups = ['A', 'B', 'C'].map((svc, i) => leaf('acct-1', svc, i + 1, 4));
    const downs = ['D', 'E', 'F'].map((svc, i) => leaf('acct-1', svc, i + 11, 0.2));
    const r = detectAnomalies([...ups, ...downs], AS_OF);
    expect(r.findings).toHaveLength(2);
    expect(r.findings.map((f) => f.direction).sort()).toEqual(['down', 'up']);
  });

  it('never groups across currencies or tenants', () => {
    const usd = ['A', 'B', 'C'].map((svc, i) => leaf('acct-1', svc, i + 1, 4));
    const eur = ['A', 'B', 'C'].map((svc, i) => leaf('acct-1', svc, i + 21, 4, { currency: 'EUR' }));
    const other = ['A', 'B', 'C'].map((svc, i) => leaf('acct-1', svc, i + 31, 4, { tenant: 'tenant-2' }));
    const r = detectAnomalies([...usd, ...eur, ...other], AS_OF);
    expect(r.findings).toHaveLength(3);
    expect(new Set(r.findings.map((f) => `${f.tenant}|${f.currency}`)).size).toBe(3);
    expect(r.findings.every((f) => f.memberCount === 3)).toBe(true);
  });

  it('raises a group to warning on its total when no member reaches the dollar minimum alone', () => {
    // Four services, each +60 on a 200 base: 30 percent but under 100 dollars each.
    const mk = (svc: string, seed: number, bump: boolean) =>
      synth({ n: 90, base: 200, noise: 0.01, seed, weekly: false, account: 'acct-1', service: svc, mod: bump ? (i, v) => (i === 89 ? v + 60 : v) : undefined });
    const alone = detectAnomalies([mk('A', 1, true)], AS_OF);
    expect(alone.findings.every((f) => f.severity === 'info')).toBe(true);
    const together = detectAnomalies(['A', 'B', 'C', 'D'].map((s, i) => mk(s, i + 1, true)), AS_OF);
    expect(together.findings).toHaveLength(1);
    expect(together.findings[0]?.scope).toBe('account');
    expect(together.findings[0]?.severity).toBe('warning');
  });

  it('the group dedup key does not depend on which members fired', () => {
    const four = ['A', 'B', 'C', 'D'].map((svc, i) => leaf('acct-1', svc, i + 1, 4));
    const three = four.slice(0, 3);
    const k4 = detectAnomalies(four, AS_OF).findings[0]?.key;
    const k3 = detectAnomalies(three, AS_OF).findings[0]?.key;
    expect(k4).toBe(k3);
  });
});

describe('ranked contributors', () => {
  const regionLeaf = (): DailySeries[] =>
    Array.from({ length: 12 }, (_, i) =>
      synth({
        n: 90,
        base: 100,
        noise: 0.01,
        seed: 100 + i,
        weekly: false,
        account: 'acct-1',
        service: 'Compute',
        region: `r${String(i).padStart(2, '0')}`,
        mod: (idx, v) => (idx === 89 ? v + (i === 3 ? 5000 : i === 7 ? 1000 : 10 + i) : v),
      }),
    );

  it('ranks up to ten contributors by excess, largest first, and counts the rest', () => {
    const r = detectAnomalies(regionLeaf(), AS_OF);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f?.contributors).toHaveLength(LIMITS.maxContributors);
    expect(f?.contributors[0]?.region).toBe('r03');
    expect(f?.contributors[1]?.region).toBe('r07');
    const excess = f?.contributors.map((c) => c.excess) as number[];
    expect([...excess].sort((a, b) => b - a)).toEqual(excess);
    expect(f?.contributors[0]?.share as number).toBeGreaterThan(0.7);
    expect(f?.otherCount).toBe(2);
    expect(f?.otherExcess as number).toBeGreaterThan(0);
    const shares = (f?.contributors.map((c) => c.share) as number[]).reduce((a, b) => a + b, 0);
    expect(shares).toBeLessThanOrEqual(1.0001);
    expect(shares).toBeGreaterThan(0.95);
  });

  it('a single-region leaf has one contributor holding the whole excess', () => {
    const r = detectAnomalies([leaf('acct-1', 'A', 1, 4)], AS_OF);
    expect(r.findings[0]?.contributors).toHaveLength(1);
    expect(r.findings[0]?.contributors[0]?.share).toBe(1);
    expect(r.findings[0]?.otherCount).toBe(0);
  });

  it('a group ranks contributors across its member leaves', () => {
    const series = [
      leaf('acct-1', 'A', 1, 6),
      leaf('acct-1', 'B', 2, 3),
      leaf('acct-1', 'C', 3, 4),
    ];
    const r = detectAnomalies(series, AS_OF);
    expect(r.findings[0]?.scope).toBe('account');
    expect(r.findings[0]?.contributors.map((c) => c.service)).toEqual(['A', 'C', 'B']);
  });

  it('ranks decreases by size of the drop', () => {
    const series = [leaf('acct-1', 'A', 1, 0.1), leaf('acct-1', 'B', 2, 0.5), leaf('acct-1', 'C', 3, 0.3)];
    const f = detectAnomalies(series, AS_OF).findings[0];
    expect(f?.direction).toBe('down');
    expect(f?.contributors.map((c) => c.service)).toEqual(['A', 'C', 'B']);
    expect(f?.contributors.every((c) => c.share > 0)).toBe(true);
  });
});

describe('caps', () => {
  it('accepts exactly the series cap and refuses one past it', () => {
    const tiny = (i: number): DailySeries => mkSeries({ start: START, account: `a${i}`, values: [1] });
    const atCap = Array.from({ length: LIMITS.maxSeries }, (_, i) => tiny(i));
    expect(detectAnomalies(atCap, dayAt(0)).stats.seriesIn).toBe(LIMITS.maxSeries);
    expect(codeOf(() => detectAnomalies([...atCap, tiny(LIMITS.maxSeries)], dayAt(0)))).toBe('SERIES_CAP_EXCEEDED');
  });

  it('truncates findings at a lowered cap, keeping the most severe, and says so', () => {
    const series = Array.from({ length: 5 }, (_, i) => leaf(`acct-${i}`, `svc-${i}`, i + 1, 2 + i));
    const r = detectAnomalies(series, AS_OF, { maxFindings: 2, groupMinMembers: 99 });
    expect(r.findings).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.stats.droppedFindings).toBe(3);
    const full = detectAnomalies(series, AS_OF, { groupMinMembers: 99 });
    expect(full.truncated).toBe(false);
    expect(full.findings.slice(0, 2)).toEqual(r.findings);
    // Exactly at the cap: nothing is dropped.
    const exact = detectAnomalies(series, AS_OF, { maxFindings: 5, groupMinMembers: 99 });
    expect(exact.truncated).toBe(false);
    expect(exact.findings).toHaveLength(5);
  });

  it('the findings cap cannot be raised above the built-in limit', () => {
    expect(codeOf(() => detectAnomalies([], AS_OF, { maxFindings: 5001 }))).toBe('CONFIG_INVALID');
    expect(codeOf(() => detectAnomalies([], AS_OF, { maxFindings: 5000 }))).toBeUndefined();
    expect(codeOf(() => detectAnomalies([], AS_OF, { maxFindings: 0 }))).toBe('CONFIG_INVALID');
  });

  it('lists at most 200 member keys but always reports the exact member count', () => {
    const mk = (n: number): DailySeries[] =>
      Array.from({ length: n }, (_, i) =>
        synth({ n: 40, base: 1000, noise: 0.02, seed: i + 1, account: `a${i}`, service: `s${i}`, mod: (idx, v) => (idx === 39 ? v * 4 : v) }),
      );
    const asOf = dayAt(39);
    const at = detectAnomalies(mk(LIMITS.maxMemberKeys), asOf).findings[0];
    expect(at?.scope).toBe('tenant');
    expect(at?.memberCount).toBe(LIMITS.maxMemberKeys);
    expect(at?.memberKeys).toHaveLength(LIMITS.maxMemberKeys);
    expect(at?.memberKeysTruncated).toBe(false);
    const past = detectAnomalies(mk(LIMITS.maxMemberKeys + 1), asOf).findings[0];
    expect(past?.memberCount).toBe(LIMITS.maxMemberKeys + 1);
    expect(past?.memberKeys).toHaveLength(LIMITS.maxMemberKeys);
    expect(past?.memberKeysTruncated).toBe(true);
    expect(past?.contributors).toHaveLength(LIMITS.maxContributors);
    expect(past?.otherCount).toBe(LIMITS.maxMemberKeys + 1 - LIMITS.maxContributors);
  });
});

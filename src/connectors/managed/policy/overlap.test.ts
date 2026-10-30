// M0c: source-role, overlap and headline eligibility. Pure policy over the
// engagement config's sources (R1 schema); consumed by the read model (R5).
// Default: refuse unresolved overlap. SYNTHETIC identifiers only.
import { describe, expect, it } from 'vitest';
import type { EngagementSource } from '../../../engagement/config';
import { SourcePolicyError, evaluateSourcePolicy, fromEngagementSource, headlineEligibleSources, type DedupPolicy, type PolicySource } from './overlap';
import { allocationCoverage, measuresFor } from './roles';

const src = (id: string, o: Partial<PolicySource> = {}): PolicySource => ({
  id, role: 'authoritative', costBasis: 'focus-native', providers: ['AWS'], accounts: ['SYNTHETIC-111'], period: { start: '2026-09-01', end: '2026-09-30', endSemantics: 'inclusive' }, alsoPresentInOtherSource: 'no', relatedSource: 'none', ...o,
});

describe('roles and measures', () => {
  it('maps each cost basis to the headline measures it may feed; unknown feeds none', () => {
    expect(measuresFor('focus-native')).toEqual(['billed', 'effective']);
    expect(measuresFor('actual')).toEqual(['billed']);
    expect(measuresFor('billed')).toEqual(['billed']);
    expect(measuresFor('amortized')).toEqual(['effective']);
    expect(measuresFor('effective')).toEqual(['effective']);
    expect(measuresFor('unknown')).toEqual([]);
  });
  it('allocation coverage is exact, and N/A (never 0) without an underlying total', () => {
    const usd = (amount: string) => ({ amount, currency: 'USD' });
    expect(allocationCoverage(usd('92.00'), usd('100.00'))).toBe('92.00');
    expect(allocationCoverage(usd('100'), usd('100'))).toBe('100.00');
    expect(allocationCoverage(usd('1'), usd('3'))).toBe('33.33');
    expect(allocationCoverage(usd('5'), usd('0'))).toBe('N/A');
    expect(allocationCoverage(usd('5'), usd('not_available'))).toBe('N/A');
  });
  it('allocation coverage is never computed across currencies (review #147)', () => {
    expect(allocationCoverage({ amount: '92', currency: 'EUR' }, { amount: '100', currency: 'USD' })).toBe('N/A');
    expect(allocationCoverage({ amount: '92', currency: 'usd' }, { amount: '100', currency: 'usd' })).toBe('N/A');
    expect(allocationCoverage({ amount: '92', currency: '' }, { amount: '100', currency: '' })).toBe('N/A');
    expect(allocationCoverage({ amount: '92', currency: 'EUR' }, { amount: '100', currency: 'EUR' })).toBe('92.00');
  });
});

describe('evaluateSourcePolicy', () => {
  it('cloud bill (authoritative) + container allocation (allocated) on the same account: headline is the bill only', () => {
    const r = evaluateSourcePolicy([src('aws-cur'), src('opencost', { role: 'allocated', relatedSource: 'aws-cur', alsoPresentInOtherSource: 'yes' })]);
    expect(r.ok).toBe(true);
    expect(r.headline).toEqual({ billed: ['aws-cur'], effective: ['aws-cur'] });
    expect(r.allocated).toEqual([{ id: 'opencost', allocates: 'aws-cur' }]);
  });

  it('two allocation sources over the same scope need a prefer policy', () => {
    const s = [src('aws-cur'), src('aws-split', { role: 'allocated' }), src('opencost', { role: 'allocated' })];
    const r = evaluateSourcePolicy(s);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([{ code: 'OVERLAP_UNRESOLVED', sources: ['aws-split', 'opencost'], detail: expect.stringContaining('allocated') }]);
    const ok = evaluateSourcePolicy(s, [{ kind: 'prefer', sources: ['aws-split', 'opencost'], prefer: 'opencost' }]);
    expect(ok.ok).toBe(true);
    expect(ok.allocated.map((a) => a.id)).toEqual(['opencost']);
    expect(ok.excluded).toEqual([{ id: 'aws-split', reason: 'overlaps opencost; excluded by its prefer policy' }]);
  });

  it('actual + amortized datasets, both authoritative on one scope, are refused unless split per measure', () => {
    const s = [src('az-actual', { providers: ['Microsoft'], costBasis: 'actual' }), src('az-amortized', { providers: ['Microsoft'], costBasis: 'amortized' })];
    const r = evaluateSourcePolicy(s);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatchObject({ code: 'OVERLAP_UNRESOLVED', sources: ['az-actual', 'az-amortized'] });
    expect(r.headline).toEqual({ billed: [], effective: [] });
    const ok = evaluateSourcePolicy(s, [{ kind: 'basis-per-measure', sources: ['az-actual', 'az-amortized'] }]);
    expect(ok.ok).toBe(true);
    expect(ok.headline).toEqual({ billed: ['az-actual'], effective: ['az-amortized'] });
    // Two sources feeding the same measure cannot use basis-per-measure.
    const both = evaluateSourcePolicy([src('a', { costBasis: 'actual' }), src('b', { costBasis: 'billed' })], [{ kind: 'basis-per-measure', sources: ['a', 'b'] }]);
    expect(both.problems.map((p) => p.code)).toEqual(['POLICY_INVALID', 'OVERLAP_UNRESOLVED']);
  });

  it('a direct AI provider cost report + a cloud bill that also carries that provider (marketplace) is refused without a policy', () => {
    const s = [src('ai-direct', { providers: ['other'], accounts: ['SYNTHETIC-ORG'] }), src('aws-cur', { alsoPresentInOtherSource: 'yes', relatedSource: 'ai-direct' })];
    expect(evaluateSourcePolicy(s).problems).toEqual([{ code: 'OVERLAP_UNRESOLVED', sources: ['ai-direct', 'aws-cur'], detail: expect.stringContaining('declared') }]);
    const ok = evaluateSourcePolicy(s, [{ kind: 'prefer', sources: ['ai-direct', 'aws-cur'], prefer: 'aws-cur' }]);
    expect(ok.headline.billed).toEqual(['aws-cur']);
    expect(ok.excluded.map((e) => e.id)).toEqual(['ai-direct']);
  });

  it('an unknown overlap declaration is not proof of disjointness: refused next to another authoritative source', () => {
    const s = [src('aws', { accounts: ['SYNTHETIC-1'] }), src('gcp', { providers: ['Google Cloud'], accounts: ['SYNTHETIC-2'], alsoPresentInOtherSource: 'unknown' })];
    expect(evaluateSourcePolicy(s).problems.map((p) => p.code)).toEqual(['OVERLAP_UNRESOLVED']);
    expect(evaluateSourcePolicy([s[1]]).ok).toBe(true);
  });

  it('disjoint scopes (provider, accounts or period) do not overlap; unknown accounts are treated as overlapping', () => {
    expect(evaluateSourcePolicy([src('aws'), src('az', { providers: ['Microsoft'] })]).ok).toBe(true);
    expect(evaluateSourcePolicy([src('a1', { accounts: ['SYNTHETIC-1'] }), src('a2', { accounts: ['SYNTHETIC-2'] })]).ok).toBe(true);
    expect(evaluateSourcePolicy([src('sep'), src('oct', { period: { start: '2026-10-01', end: '2026-10-31' } })]).ok).toBe(true);
    expect(evaluateSourcePolicy([src('a1', { accounts: 'unknown' }), src('a2', { accounts: ['SYNTHETIC-2'] })]).ok).toBe(false);
  });

  it('split-by sub-account lists resolve an overlap only when they are disjoint and cover each source', () => {
    const s = [src('cur', { accounts: ['SYNTHETIC-1'] }), src('focus', { accounts: ['SYNTHETIC-1', 'SYNTHETIC-2'] })];
    expect(evaluateSourcePolicy(s).ok).toBe(false);
    const split: DedupPolicy = { kind: 'split-by', sources: ['cur', 'focus'], subAccounts: { cur: ['SYNTHETIC-1'], focus: ['SYNTHETIC-2'] } };
    // focus declares SYNTHETIC-1 too: its list does not cover it.
    expect(evaluateSourcePolicy(s, [split]).problems.map((p) => p.code)).toEqual(['POLICY_INVALID', 'OVERLAP_UNRESOLVED']);
    const s2 = [s[0], src('focus', { accounts: ['SYNTHETIC-2'], alsoPresentInOtherSource: 'unknown' })];
    expect(evaluateSourcePolicy(s2, [split]).ok).toBe(true);
    const overlapping: DedupPolicy = { kind: 'split-by', sources: ['cur', 'focus'], subAccounts: { cur: ['SYNTHETIC-1'], focus: ['SYNTHETIC-1', 'SYNTHETIC-2'] } };
    expect(evaluateSourcePolicy(s, [overlapping]).problems.map((p) => p.code)).toEqual(['POLICY_INVALID', 'OVERLAP_UNRESOLVED']);
  });

  it('a policy naming an unknown source, or a prefer naming neither side, is invalid', () => {
    expect(evaluateSourcePolicy([src('a')], [{ kind: 'prefer', sources: ['a', 'zz'], prefer: 'a' }]).problems.map((p) => p.code)).toEqual(['POLICY_INVALID']);
    expect(evaluateSourcePolicy([src('a'), src('b')], [{ kind: 'prefer', sources: ['a', 'b'], prefer: 'c' }]).problems.map((p) => p.code)).toEqual(['POLICY_INVALID', 'OVERLAP_UNRESOLVED']);
  });

  it('only authoritative sources with a known cost basis feed the headline', () => {
    const r = evaluateSourcePolicy([
      src('u', { role: 'unknown', accounts: ['S-1'] }),
      src('nb', { costBasis: 'unknown', accounts: ['S-2'] }),
      src('cmdb', { role: 'enrichment', accounts: ['S-3'] }),
      src('recs', { role: 'recommendation', accounts: ['S-4'] }),
      src('chg', { role: 'change-management', accounts: ['S-5'] }),
    ]);
    expect(r.ok).toBe(true);
    expect(r.headline).toEqual({ billed: [], effective: [] });
    expect(r.excluded).toEqual([
      { id: 'u', reason: 'source role unknown; excluded from headline totals' },
      { id: 'nb', reason: 'cost basis unknown; excluded from headline totals' },
    ]);
    expect(r.nonFinancial).toEqual(['cmdb', 'recs', 'chg']);
  });
});

describe('headlineEligibleSources and the engagement config', () => {
  const engagementSource = (id: string, accounts: string[] | 'unknown', overlap: 'yes' | 'no' | 'unknown' = 'no'): EngagementSource =>
    ({
      id, providers: ['AWS'], layout: 'single-file', retrieval: { kind: 'file-drop' },
      metadata: {
        provider: 'AWS', source_kind: 'focus-export', schema_version: '1.0', cost_basis: 'focus-native', dataset: 'SYNTHETIC', source_role: 'authoritative',
        scope: { accounts, period_start: '2026-09-01', period_end: '2026-09-30', period_end_semantics: 'inclusive', timezone: 'UTC', completeness: 'full-period' },
        overlap: { also_present_in_other_source: overlap, related_source: 'none' },
      },
    }) as unknown as EngagementSource;

  it('maps an R1 source (accounts lists only; anything else is unknown)', () => {
    expect(fromEngagementSource(engagementSource('a', ['S-1']))).toEqual(src('a', { accounts: ['S-1'] }));
    expect(fromEngagementSource(engagementSource('a', 'unknown')).accounts).toBe('unknown');
  });

  it('returns the headline sources, or throws naming source ids and codes only', () => {
    expect(headlineEligibleSources([engagementSource('a', ['S-1']), engagementSource('b', ['S-2'])])).toEqual({ headline: { billed: ['a', 'b'], effective: ['a', 'b'] }, warnings: [] });
    let err: unknown;
    try {
      headlineEligibleSources([engagementSource('a', ['S-1']), engagementSource('b', ['S-1'])]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SourcePolicyError);
    expect((err as SourcePolicyError).message).toBe('OVERLAP_UNRESOLVED: sources a and b overlap (same provider, accounts and period); name a dedup policy (prefer, split-by or basis-per-measure)');
    expect((err as SourcePolicyError).message).not.toContain('S-1');
  });
});

// Review findings on PR #147 (P1..P7 of the independent probe). SYNTHETIC identifiers only.
describe('review #147: instants, end semantics, undercount and scope disclosure', () => {
  const ts = (id: string, start: string, end: string, endSemantics: 'inclusive' | 'exclusive' = 'exclusive', o: Partial<PolicySource> = {}) => src(id, { period: { start, end, endSemantics }, ...o });

  it('P1: periods are compared as instants, so mixed UTC offsets that overlap by hours are refused', () => {
    // b starts 2026-10-01T10:00+14:00 = 2026-09-30T20:00Z, inside a.
    const r = evaluateSourcePolicy([ts('a', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'), ts('b', '2026-10-01T10:00:00+14:00', '2026-11-01T00:00:00Z')]);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.objectContaining({ code: 'OVERLAP_UNRESOLVED', sources: ['a', 'b'] })]);
    expect(r.headline).toEqual({ billed: [], effective: [] });
    // a ends 2026-09-15T00:00-08:00 = 2026-09-15T08:00Z; b starts 3h earlier in Z.
    const r2 = evaluateSourcePolicy([ts('a', '2026-09-01T00:00:00-08:00', '2026-09-15T00:00:00-08:00'), ts('b', '2026-09-15T05:00:00Z', '2026-09-30T00:00:00Z')]);
    expect(r2.problems.map((p) => p.code)).toEqual(['OVERLAP_UNRESOLVED']);
    // The same instant written with two offsets is adjacent, not overlapping (exclusive end).
    expect(evaluateSourcePolicy([ts('a', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'), ts('b', '2026-09-30T16:00:00-08:00', '2026-11-01T00:00:00Z')]).ok).toBe(true);
  });

  it('P1: an unparseable or impossible period is never ok; it is reported and treated as overlapping', () => {
    for (const bad of ['2026-02-30T00:00:00Z', 'not-a-date', '2026-09-01T00:00:00', '']) {
      const r = evaluateSourcePolicy([ts('a', bad, '2026-10-01T00:00:00Z'), ts('b', '2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z')]);
      expect(r.ok, bad).toBe(false);
      expect(r.problems.map((p) => p.code), bad).toEqual(['PERIOD_INVALID', 'OVERLAP_UNRESOLVED']);
      expect(r.problems[0].sources).toEqual(['a']);
      if (bad) expect(JSON.stringify(r.problems)).not.toContain(bad); // never echo config values
      expect(r.headline).toEqual({ billed: [], effective: [] });
    }
    // start not before end is invalid as well
    expect(evaluateSourcePolicy([ts('a', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')]).problems.map((p) => p.code)).toEqual(['PERIOD_INVALID']);
  });

  it('P2: R1 period_end_semantics is honored: adjacent exclusive months do not overlap, adjacent inclusive ones touching an instant do', () => {
    expect(evaluateSourcePolicy([ts('sep', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'), ts('oct', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')]).ok).toBe(true);
    // Inclusive end at the instant the next source starts: that instant is in both.
    const incl = evaluateSourcePolicy([ts('sep', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 'inclusive'), ts('oct', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')]);
    expect(incl.problems.map((p) => p.code)).toEqual(['OVERLAP_UNRESOLVED']);
    // Documented inclusive month end: 23:59:59 then the next month starts.
    expect(evaluateSourcePolicy([ts('sep', '2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z', 'inclusive'), ts('oct', '2026-10-01T00:00:00Z', '2026-10-31T23:59:59Z', 'inclusive')]).ok).toBe(true);
    // An inclusive date-only end covers that whole day.
    expect(evaluateSourcePolicy([src('sep'), ts('late', '2026-09-30T12:00:00Z', '2026-10-05T00:00:00Z')]).ok).toBe(false);
    // Without semantics, the FOCUS BillingPeriodEnd default (exclusive) applies.
    expect(evaluateSourcePolicy([src('sep', { period: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' } }), src('oct', { period: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } })]).ok).toBe(true);
  });

  it('P2: fromEngagementSource carries period_end_semantics from the R1 config', () => {
    const e = { id: 'x', providers: ['AWS'], metadata: { source_role: 'authoritative', cost_basis: 'focus-native', scope: { accounts: ['S-1'], period_start: '2026-09-01T00:00:00Z', period_end: '2026-10-01T00:00:00Z', period_end_semantics: 'exclusive' }, overlap: { also_present_in_other_source: 'no', related_source: 'none' } } } as unknown as EngagementSource;
    expect(fromEngagementSource(e).period).toEqual({ start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z', endSemantics: 'exclusive' });
  });

  it('P3: prefer whose loser declares accounts or a period the winner does not cover is refused, never silent', () => {
    const r = evaluateSourcePolicy([src('w', { accounts: ['A'] }), src('l', { accounts: ['A', 'B'] })], [{ kind: 'prefer', sources: ['w', 'l'], prefer: 'w' }]);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([{ code: 'PREFER_UNDERCOUNTS', sources: ['w', 'l'], detail: expect.stringContaining('l') }]);
    expect(JSON.stringify(r)).not.toContain('"B"');
    const p = evaluateSourcePolicy([src('w'), ts('l', '2026-08-15T00:00:00Z', '2026-09-20T00:00:00Z')], [{ kind: 'prefer', sources: ['w', 'l'], prefer: 'w' }]);
    expect(p.problems.map((x) => x.code)).toEqual(['PREFER_UNDERCOUNTS']);
    // Winner covers the loser: fine, no warning.
    const ok = evaluateSourcePolicy([src('w', { accounts: ['A', 'B'] }), src('l', { accounts: ['A'] })], [{ kind: 'prefer', sources: ['w', 'l'], prefer: 'w' }]);
    expect(ok.ok).toBe(true);
    expect(ok.warnings).toEqual([]);
  });

  it('P3: prefer whose coverage cannot be proven (unknown accounts, different providers) carries a visible warning', () => {
    const r = evaluateSourcePolicy([src('w', { accounts: 'unknown' }), src('l', { accounts: 'unknown' })], [{ kind: 'prefer', sources: ['w', 'l'], prefer: 'w' }]);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([{ code: 'PREFER_MAY_UNDERCOUNT', sources: ['w', 'l'], detail: expect.stringContaining('undercount') }]);
    const x = evaluateSourcePolicy([src('ai', { providers: ['other'], accounts: ['S-ORG'] }), src('cur', { alsoPresentInOtherSource: 'yes', relatedSource: 'ai' })], [{ kind: 'prefer', sources: ['ai', 'cur'], prefer: 'cur' }]);
    expect(x.ok).toBe(true);
    expect(x.warnings.map((w) => w.code)).toEqual(['PREFER_MAY_UNDERCOUNT']);
  });

  it('P4: the exclusion reason names the winners that actually dropped the source', () => {
    const r = evaluateSourcePolicy([src('a'), src('b'), src('c')], [
      { kind: 'prefer', sources: ['b', 'c'], prefer: 'b' },
      { kind: 'prefer', sources: ['a', 'b'], prefer: 'a' },
      { kind: 'prefer', sources: ['a', 'c'], prefer: 'a' },
    ]);
    expect(r.ok).toBe(true);
    expect(r.headline).toEqual({ billed: ['a'], effective: ['a'] });
    expect(r.excluded).toEqual([
      { id: 'b', reason: 'overlaps a; excluded by its prefer policy' },
      { id: 'c', reason: 'overlaps a and b; excluded by its prefer policy' },
    ]);
  });

  it('P5: a prefer cycle is POLICY_INVALID, never ok with an emptied headline', () => {
    const r = evaluateSourcePolicy([src('a'), src('b'), src('c')], [
      { kind: 'prefer', sources: ['a', 'b'], prefer: 'a' },
      { kind: 'prefer', sources: ['b', 'c'], prefer: 'b' },
      { kind: 'prefer', sources: ['c', 'a'], prefer: 'c' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([{ code: 'POLICY_INVALID', sources: ['a', 'b', 'c'], detail: expect.stringContaining('cycle') }]);
    expect(r.headline).toEqual({ billed: [], effective: [] });
  });

  it('P6: billed and effective headlines over different scopes are disclosed', () => {
    const r = evaluateSourcePolicy([src('x', { costBasis: 'actual', accounts: ['A'] }), src('y', { costBasis: 'amortized', accounts: ['B'] })]);
    expect(r.ok).toBe(true);
    expect(r.headline).toEqual({ billed: ['x'], effective: ['y'] });
    expect(r.warnings).toEqual([{ code: 'MEASURE_SCOPE_DIFFERS', sources: ['x', 'y'], detail: expect.stringContaining('billed') }]);
    expect(JSON.stringify(r.warnings)).not.toMatch(/"A"|"B"/);
    // focus-native on A + actual-only on B: effective misses B.
    expect(evaluateSourcePolicy([src('f', { accounts: ['A'] }), src('y', { costBasis: 'actual', accounts: ['B'] })]).warnings.map((w) => w.code)).toEqual(['MEASURE_SCOPE_DIFFERS']);
    // Same scope split per measure: no warning.
    const same = evaluateSourcePolicy([src('x', { costBasis: 'actual' }), src('y', { costBasis: 'amortized' })], [{ kind: 'basis-per-measure', sources: ['x', 'y'] }]);
    expect(same.ok).toBe(true);
    expect(same.warnings).toEqual([]);
    // Unknown accounts cannot prove equal scope: disclosed.
    expect(evaluateSourcePolicy([src('x', { costBasis: 'actual', accounts: 'unknown' }), src('y', { costBasis: 'amortized', accounts: 'unknown' })], [{ kind: 'basis-per-measure', sources: ['x', 'y'] }]).warnings.map((w) => w.code)).toEqual(['MEASURE_SCOPE_DIFFERS']);
  });

  it('P7: a related_source that is not configured is reported', () => {
    const r = evaluateSourcePolicy([src('k8s', { role: 'allocated', relatedSource: 'ghost', alsoPresentInOtherSource: 'yes' })]);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([{ code: 'RELATED_SOURCE_MISSING', sources: ['k8s'], detail: expect.stringContaining('k8s') }]);
    expect(evaluateSourcePolicy([src('k8s', { role: 'allocated' })]).ok).toBe(true); // 'none' is fine
  });

  it('headlineEligibleSources returns the warnings with the headline', () => {
    const e = (id: string, basis: string, accounts: string[]) => ({ id, providers: ['AWS'], metadata: { source_role: 'authoritative', cost_basis: basis, scope: { accounts, period_start: '2026-09-01T00:00:00Z', period_end: '2026-10-01T00:00:00Z', period_end_semantics: 'exclusive' }, overlap: { also_present_in_other_source: 'no', related_source: 'none' } } }) as unknown as EngagementSource;
    const r = headlineEligibleSources([e('x', 'actual', ['S-1']), e('y', 'amortized', ['S-2'])]);
    expect(r.headline).toEqual({ billed: ['x'], effective: ['y'] });
    expect(r.warnings.map((w) => w.code)).toEqual(['MEASURE_SCOPE_DIFFERS']);
  });
});

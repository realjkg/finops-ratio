// M0c: source-role, overlap and headline eligibility. Pure policy over the
// engagement config's sources (R1 schema); consumed by the read model (R5).
// Default: refuse unresolved overlap. SYNTHETIC identifiers only.
import { describe, expect, it } from 'vitest';
import type { EngagementSource } from '../../../engagement/config';
import { SourcePolicyError, evaluateSourcePolicy, fromEngagementSource, headlineEligibleSources, type DedupPolicy, type PolicySource } from './overlap';
import { allocationCoverage, measuresFor } from './roles';

const src = (id: string, o: Partial<PolicySource> = {}): PolicySource => ({
  id, role: 'authoritative', costBasis: 'focus-native', providers: ['AWS'], accounts: ['SYNTHETIC-111'], period: { start: '2026-09-01', end: '2026-09-30' }, alsoPresentInOtherSource: 'no', relatedSource: 'none', ...o,
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
    expect(allocationCoverage('92.00', '100.00')).toBe('92.00');
    expect(allocationCoverage('100', '100')).toBe('100.00');
    expect(allocationCoverage('1', '3')).toBe('33.33');
    expect(allocationCoverage('5', '0')).toBe('N/A');
    expect(allocationCoverage('5', 'not_available')).toBe('N/A');
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
    expect(both.problems.map((p) => p.code)).toEqual(['POLICY_INVALID']);
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
    expect(evaluateSourcePolicy(s, [split]).problems.map((p) => p.code)).toEqual(['POLICY_INVALID']);
    const s2 = [s[0], src('focus', { accounts: ['SYNTHETIC-2'], alsoPresentInOtherSource: 'unknown' })];
    expect(evaluateSourcePolicy(s2, [split]).ok).toBe(true);
    const overlapping: DedupPolicy = { kind: 'split-by', sources: ['cur', 'focus'], subAccounts: { cur: ['SYNTHETIC-1'], focus: ['SYNTHETIC-1', 'SYNTHETIC-2'] } };
    expect(evaluateSourcePolicy(s, [overlapping]).problems.map((p) => p.code)).toEqual(['POLICY_INVALID']);
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
    expect(headlineEligibleSources([engagementSource('a', ['S-1']), engagementSource('b', ['S-2'])])).toEqual({ billed: ['a', 'b'], effective: ['a', 'b'] });
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

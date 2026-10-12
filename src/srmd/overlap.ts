// Double-count detector input. It REPORTS overlap candidates between
// SRMD-sourced and provider-sourced records. It never sums, drops, merges or
// fabricates: every input record lands in exactly one output bucket.
import type { Measure, ProviderCostRecord, SrmdCostRecord } from './types';

export function compareMeasures(a: Measure, b: Measure): { comparable: true } | { comparable: false; differences: string[] } {
  const differences = (['name', 'includesCredits', 'amortized'] as const).filter((k) => a[k] !== b[k]).map((k) => `measure.${k}`);
  return differences.length ? { comparable: false, differences } : { comparable: true };
}

export interface OverlapCandidate {
  srmd: SrmdCostRecord;
  provider: ProviderCostRecord;
  basis: 'lineage_id' | 'amount_and_bill_identity' | 'offset' | 'restatement';
  status: 'overlap_candidate' | 'not_comparable' | 'offset_candidate' | 'restatement_candidate';
  reasons: string[];
  /** SRMD minus provider, only for a comparable overlap; never a coerced value. */
  deltaNanos: bigint | null;
  /** This provider record is claimed by several SRMD records. */
  claimedByMultiple: boolean;
  /** This SRMD record matches several provider records. */
  multiProvider: boolean;
}
export interface OverlapReport {
  candidates: OverlapCandidate[];
  duplicateSrmdIds: { srmdRecordId: string; records: SrmdCostRecord[] }[];
  srmdUnmatched: SrmdCostRecord[];
  providerUnmatched: ProviderCostRecord[];
}

type Pair = Pick<OverlapCandidate, 'basis' | 'status' | 'reasons'>;
const ZERO = BigInt(0);

/** Match without a usable lineage id: same bill identity, resource and kind. */
function weak(s: SrmdCostRecord, p: ProviderCostRecord): Pair | null {
  if (s.provider !== p.provider || s.billingAccountId !== p.billingAccountId || s.resourceId !== p.resourceId || s.currency !== p.currency) return null;
  const m = compareMeasures(s.measure, p.measure);
  const samePeriod = s.billingPeriod === p.billingPeriod;
  if (s.amountNanos === p.amountNanos && s.kind === (p.kind ?? 'usage')) {
    if (samePeriod) return { basis: 'amount_and_bill_identity', status: m.comparable ? 'overlap_candidate' : 'not_comparable', reasons: m.comparable ? [] : m.differences };
    if (s.lateArrival && m.comparable) return { basis: 'restatement', status: 'restatement_candidate', reasons: ['billingPeriod differs (late arrival)'] };
  }
  if (samePeriod && m.comparable && s.amountNanos !== ZERO && s.amountNanos === -p.amountNanos) {
    return { basis: 'offset', status: 'offset_candidate', reasons: ['amount is the negation of the provider record'] };
  }
  return null;
}

function strong(s: SrmdCostRecord, p: ProviderCostRecord): Pair {
  const reasons: string[] = [];
  if (s.currency !== p.currency) reasons.push(`currency differs (${s.currency} vs ${p.currency})`);
  const m = compareMeasures(s.measure, p.measure);
  if (!m.comparable) reasons.push(...m.differences);
  return { basis: 'lineage_id', status: reasons.length ? 'not_comparable' : 'overlap_candidate', reasons };
}

export function detectOverlap(srmd: SrmdCostRecord[], provider: ProviderCostRecord[]): OverlapReport {
  const byId = new Map<string, ProviderCostRecord[]>();
  for (const p of provider) byId.set(p.providerRecordId, [...(byId.get(p.providerRecordId) ?? []), p]);
  const groups = new Map<string, SrmdCostRecord[]>();
  for (const s of srmd) groups.set(s.lineage.srmdRecordId, [...(groups.get(s.lineage.srmdRecordId) ?? []), s]);
  const duplicateSrmdIds = [...groups].filter(([, r]) => r.length > 1).map(([srmdRecordId, records]) => ({ srmdRecordId, records }));
  const flagged = new Set(duplicateSrmdIds.flatMap((d) => d.records));
  const candidates: OverlapCandidate[] = [];
  const srmdUnmatched: SrmdCostRecord[] = [];
  for (const s of srmd) {
    if (flagged.has(s)) continue;
    const id = s.lineage.providerRecordId;
    const linked = id === null ? [] : (byId.get(id) ?? []);
    const found = linked.length
      ? linked.map((p) => ({ p, ...strong(s, p) }))
      : provider.flatMap((p) => {
          const w = weak(s, p);
          return w ? [{ p, ...w }] : [];
        });
    if (!found.length) srmdUnmatched.push(s);
    for (const f of found) {
      candidates.push({ srmd: s, provider: f.p, basis: f.basis, status: f.status, reasons: f.reasons, claimedByMultiple: false, multiProvider: found.length > 1,
        deltaNanos: f.status === 'overlap_candidate' ? s.amountNanos - f.p.amountNanos : null });
    }
  }
  const claims = new Map<ProviderCostRecord, number>();
  for (const c of candidates) claims.set(c.provider, (claims.get(c.provider) ?? 0) + 1);
  candidates.forEach((c) => (c.claimedByMultiple = (claims.get(c.provider) ?? 0) > 1));
  return { candidates, duplicateSrmdIds, srmdUnmatched, providerUnmatched: provider.filter((p) => !claims.has(p)) };
}

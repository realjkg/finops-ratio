// Double-count detector input. It REPORTS overlap candidates between
// SRMD-sourced and provider-sourced records. It never sums, drops or merges.
import type { Measure, ProviderCostRecord, SrmdCostRecord } from './types';

export function compareMeasures(a: Measure, b: Measure): { comparable: true } | { comparable: false; differences: string[] } {
  const differences = (['name', 'includesCredits', 'amortized'] as const).filter((k) => a[k] !== b[k]).map((k) => `measure.${k}`);
  return differences.length ? { comparable: false, differences } : { comparable: true };
}

export interface OverlapCandidate {
  srmdRecordId: string;
  providerRecordId: string;
  basis: 'lineage_id' | 'amount_and_bill_identity';
  status: 'overlap_candidate' | 'not_comparable';
  reasons: string[];
  /** SRMD minus provider, only when comparable; never a coerced value. */
  deltaNanos: bigint | null;
}
export interface OverlapReport {
  candidates: OverlapCandidate[];
  srmdUnmatched: string[];
  providerUnmatched: string[];
}

export function detectOverlap(srmd: SrmdCostRecord[], provider: ProviderCostRecord[]): OverlapReport {
  const byId = new Map(provider.map((p) => [p.providerRecordId, p]));
  const claimed = new Set<string>();
  const candidates: OverlapCandidate[] = [];
  const srmdUnmatched: string[] = [];
  const hold = (s: SrmdCostRecord, p: ProviderCostRecord, basis: OverlapCandidate['basis']) => {
    const reasons: string[] = [];
    if (s.currency !== p.currency) reasons.push(`currency differs (${s.currency} vs ${p.currency})`);
    const m = compareMeasures(s.measure, p.measure);
    if (!m.comparable) reasons.push(...m.differences);
    const comparable = reasons.length === 0;
    claimed.add(p.providerRecordId);
    candidates.push({
      srmdRecordId: s.lineage.srmdRecordId,
      providerRecordId: p.providerRecordId,
      basis,
      status: comparable ? 'overlap_candidate' : 'not_comparable',
      reasons,
      deltaNanos: comparable ? s.amountNanos - p.amountNanos : null,
    });
  };
  const pending: SrmdCostRecord[] = [];
  for (const s of srmd) {
    const p = s.lineage.providerRecordId === null ? undefined : byId.get(s.lineage.providerRecordId);
    if (p) hold(s, p, 'lineage_id');
    else if (s.lineage.providerRecordId === null) pending.push(s);
    else srmdUnmatched.push(s.lineage.srmdRecordId);
  }
  // Weak match, only for records with no lineage id: same bill identity, amount and measure.
  for (const s of pending) {
    const p = provider.find(
      (q) =>
        !claimed.has(q.providerRecordId) &&
        q.provider === s.provider &&
        q.billingAccountId === s.billingAccountId &&
        q.billingPeriod === s.billingPeriod &&
        q.currency === s.currency &&
        q.amountNanos === s.amountNanos &&
        compareMeasures(q.measure, s.measure).comparable,
    );
    if (p) hold(s, p, 'amount_and_bill_identity');
    else srmdUnmatched.push(s.lineage.srmdRecordId);
  }
  return { candidates, srmdUnmatched, providerUnmatched: provider.map((p) => p.providerRecordId).filter((id) => !claimed.has(id)) };
}

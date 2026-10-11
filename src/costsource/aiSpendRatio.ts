// AI spend vs total spend, computed only from canonical FOCUS rows.
//
// - AI rule: ServiceCategory is exactly 'AI and Machine Learning' (the FOCUS
//   value the seed and synthetic sources emit). No fuzzy matching.
// - Cost basis: EffectiveCost (amortized spend, net of discounts and
//   commitments), so prepaid commitments are not double-counted against usage.
// - Credits and refunds (negative rows) net in.
// - Currencies are never summed together: one result per BillingCurrency.
// - Sums run in integer nano-units (BigInt), so 0.1 + 0.2 is exactly 0.3 and
//   sub-micro costs (e.g. per-token prices) are kept.
//   Invalid rows (non-finite or absurd cost, bad currency code) are counted
//   as excluded, never thrown.
import type { CanonicalFocusRow } from './focusRows';
import type { CostSourceClient, CostWindow } from './CostSourceClient';

const AI_SERVICE_CATEGORY = 'AI and Machine Learning';
/** Largest per-row |cost| accepted; anything above is treated as corrupt input. */
const MAX_ABS_COST = 1e12;
// BigInt() calls, not literals: the tsconfig target predates ES2020.
const NANOS = BigInt(1_000_000_000);
const ZERO = BigInt(0);

export interface CurrencyAiSpend {
  currency: string;
  totalCost: number;
  aiCost: number;
  /** aiCost / totalCost, or null when totalCost <= 0. */
  ratio: number | null;
  /** AI rows only, largest first. */
  byService: { serviceName: string; aiCost: number }[];
  rowCount: number;
}

export interface AiSpendRatio {
  byCurrency: CurrencyAiSpend[];
  rowCount: number;
  excludedRows: number;
  notes: string[];
}

/** Exact nano-units for a valid cost, or null (the single validation point). */
function toNanos(value: unknown): bigint | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_ABS_COST) return null;
  const [whole, frac = ''] = value.toFixed(9).split('.');
  const sign = BigInt(whole.startsWith('-') ? -1 : 1);
  return BigInt(whole) * NANOS + sign * BigInt(frac.padEnd(9, '0'));
}

/** Nearest double to the exact decimal value (parsed from its decimal string). */
function fromNanos(nanos: bigint): number {
  const abs = nanos < ZERO ? -nanos : nanos;
  const decimal = `${abs / NANOS}.${(abs % NANOS).toString().padStart(9, '0')}`;
  return nanos < ZERO ? -Number(decimal) : Number(decimal);
}

interface Acc {
  total: bigint;
  ai: bigint;
  rows: number;
  services: Map<string, bigint>;
}

export function computeAiSpendRatio(rows: CanonicalFocusRow[]): AiSpendRatio {
  const byCurrency = new Map<string, Acc>();
  let excludedRows = 0;
  for (const row of rows) {
    const nanos = toNanos(row.EffectiveCost);
    const currency = row.BillingCurrency;
    if (nanos === null || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      excludedRows += 1;
      continue;
    }
    const acc = byCurrency.get(currency) ?? { total: ZERO, ai: ZERO, rows: 0, services: new Map() };
    byCurrency.set(currency, acc);
    acc.total += nanos;
    acc.rows += 1;
    if (row.ServiceCategory === AI_SERVICE_CATEGORY) {
      acc.ai += nanos;
      const name = row.ServiceName || '(unnamed service)';
      acc.services.set(name, (acc.services.get(name) ?? ZERO) + nanos);
    }
  }

  const results = [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, acc]) => ({
      currency,
      totalCost: fromNanos(acc.total),
      aiCost: fromNanos(acc.ai),
      ratio: acc.total > ZERO ? fromNanos(acc.ai) / fromNanos(acc.total) : null,
      byService: [...acc.services.entries()]
        .sort(([na, a], [nb, b]) => (a === b ? na.localeCompare(nb) : a > b ? -1 : 1))
        .map(([serviceName, cost]) => ({ serviceName, aiCost: fromNanos(cost) })),
      rowCount: acc.rows,
    }));

  const notes: string[] = [];
  if (excludedRows > 0) {
    notes.push(`${excludedRows} ${excludedRows === 1 ? 'row' : 'rows'} excluded: invalid EffectiveCost or BillingCurrency.`);
  }
  if (results.length > 1) notes.push('Multiple billing currencies: totals and ratios are per currency, never summed.');
  for (const r of results) {
    if (r.ratio === null) notes.push(`${r.currency} total spend is zero or negative; no ratio.`);
  }
  return { byCurrency: results, rowCount: rows.length - excludedRows, excludedRows, notes };
}

export interface AiSpendRatioReport {
  mode: CostSourceClient['mode'];
  window: CostWindow;
  /** inHeadline false = another fetched source owns this bill; not in `overall`. */
  perSource: { sourceId: string; name: string; inHeadline: boolean; result: AiSpendRatio }[];
  /** Rows of the inHeadline sources only, so overlapping sources are never summed. */
  overall: AiSpendRatio;
  errors: { sourceId: string; message: string }[];
}

/**
 * Seed sources that repeat one bill: same BillingAccountId and ResourceIds
 * (checked against the rows in aiSpendRatio.test.ts). Each group has exactly
 * one headline owner, the first fetched id in this order; the rest stay as
 * per-source rows only. The synthetic clouds bill their own accounts.
 */
const REPEATED_BILL_GROUPS: readonly (readonly string[])[] = [
  ['pointfive-sandbox', 'focus-file-sandbox', 'servicenow-sandbox'],
];

/**
 * AI spend ratio across sources, through the CostSourceClient interface only,
 * so the mock (seed) and live (API route) clients run identical code. Default
 * sources: every configured source with the 'costRows' capability. A failing
 * source is reported in `errors` and never fails the others.
 */
export async function fetchAiSpendRatio(
  client: CostSourceClient,
  window: CostWindow,
  sourceIds?: string[],
): Promise<AiSpendRatioReport> {
  const sources = await client.listSources();
  const errors: AiSpendRatioReport['errors'] = [];
  const wanted = sourceIds
    ? sourceIds.flatMap((id) => {
        const s = sources.find((d) => d.id === id);
        const problem = !s
          ? 'Unknown cost source'
          : !s.configured
            ? 'Source is not configured'
            : !s.capabilities.includes('costRows')
              ? 'Source does not provide cost rows'
              : null;
        if (problem) errors.push({ sourceId: id, message: problem });
        return s && !problem ? [s] : [];
      })
    : sources.filter((s) => s.configured && s.capabilities.includes('costRows'));

  const settled = await Promise.allSettled(wanted.map((s) => client.fetchCostRows(s.id, window)));
  const fetched: { sourceId: string; name: string; rows: CanonicalFocusRow[] }[] = [];
  settled.forEach((outcome, i) => {
    const { id, name } = wanted[i];
    if (outcome.status === 'rejected') {
      const err = outcome.reason;
      errors.push({ sourceId: id, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    fetched.push({ sourceId: id, name, rows: Array.isArray(outcome.value?.rows) ? outcome.value.rows : [] });
  });
  const fetchedIds = new Set(fetched.map((f) => f.sourceId));
  const perSource = fetched.map(({ sourceId, name, rows }) => {
    const group = REPEATED_BILL_GROUPS.find((g) => g.includes(sourceId));
    return { sourceId, name, inHeadline: !group || group.find((id) => fetchedIds.has(id)) === sourceId, rows };
  });
  return {
    mode: client.mode,
    window,
    perSource: perSource.map(({ rows, ...s }) => ({ ...s, result: computeAiSpendRatio(rows) })),
    overall: computeAiSpendRatio(perSource.filter((s) => s.inHeadline).flatMap((s) => s.rows)),
    errors,
  };
}

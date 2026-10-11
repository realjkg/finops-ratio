// De-duplication and ranking of native recommendations (checklist item 4.3).
//
// Pure and deterministic. Trust boundary: items are untrusted until each one has
// passed validateNativeRecommendation; implausible items (negative or zero
// savings, savings above current spend, non-finite or non-integer amounts) are
// rejected and counted with fixed reason codes, and one bad item never stops the
// batch. The input array is capped; output is capped per currency.
//
// Currency: scores are in minor units of ONE currency, so items are ranked inside
// their own currency group. Nothing is converted or compared across currencies.
//
// De-duplication: items with the same currency, case-insensitive resource id and
// category form one group. The winner is the highest confidence, then the highest
// savings, then the lowest source name, then the lowest source id. The others are
// recorded as corroborating (up to MAX_CORROBORATING listed, total counted); an
// item repeating the same source and source id is an exact duplicate and is only
// counted. Resource ids are compared as given: an ARN and a bare instance id are
// NOT assumed equal, because merging distinct resources would hide real savings.
// Different categories on one resource (for example rightsize and idle) are kept
// as separate items but flagged, and the non-overlapping total counts only the
// largest saving per resource.
//
// SCORE (documented formula, all integer):
//   score = savings x confidenceWeight x effortFactor x riskFactor
// with weights in basis points (below). weightedSavingsMinor = score / 10^12,
// floored, which is savings discounted by confidence, effort and risk.
// Order: score descending, then savings, confidence, source, sourceId,
// resourceId and category (strings by UTF-16 code unit, never by locale).

import { RecommendInputError } from './errors';
import { ZERO } from './money';
import {
  type Level,
  type NativeRecommendation,
  type RecommendationCategory,
  type RecommendationSource,
  type RejectCode,
} from './types';
import { validateNativeRecommendation } from './validate';

export const MAX_RANK_INPUT = 20_000;
export const DEFAULT_MAX_OUTPUT_PER_CURRENCY = 100;
export const MAX_OUTPUT_PER_CURRENCY = 1_000;
export const MAX_CORROBORATING = 10;

export const CONFIDENCE_WEIGHT_BPS: Readonly<Record<Level, number>> = { high: 10000, medium: 7000, low: 4000 };
export const EFFORT_FACTOR_BPS: Readonly<Record<Level, number>> = { low: 10000, medium: 8500, high: 6500 };
export const RISK_FACTOR_BPS: Readonly<Record<Level, number>> = { low: 10000, medium: 8000, high: 5500 };

export const RANK_FORMULA =
  'score = savings x confidenceWeight x effortFactor x riskFactor (basis points: confidence high 10000, medium 7000, low 4000; effort low 10000, medium 8500, high 6500; risk low 10000, medium 8000, high 5500); weightedSavingsMinor = floor(score / 10^12).';

const SCORE_SCALE = BigInt('1000000000000');
const CONFIDENCE_ORDER: Readonly<Record<Level, number>> = { low: 0, medium: 1, high: 2 };

export interface RankOptions {
  /** Items kept per currency group, 1 to 1000. Default 100. */
  maxOutputPerCurrency?: number;
}

export interface Corroboration {
  source: RecommendationSource;
  sourceId: string;
  confidence: Level;
  estimatedSavingsMinor: bigint;
}

export interface RankedRecommendation extends NativeRecommendation {
  /** 1-based position inside its currency group. */
  rank: number;
  score: bigint;
  weightedSavingsMinor: bigint;
  corroborating: Corroboration[];
  /** Number of distinct other items merged into this one (may exceed the listed corroborating). */
  corroboratingTotal: number;
  /** Other categories recommended for the same resource, sorted. Their savings may overlap this one. */
  otherCategoriesOnResource: RecommendationCategory[];
}

export interface RankGroup {
  currency: string;
  items: RankedRecommendation[];
  /** Items dropped by the output cap (after de-duplication). */
  truncated: number;
  /** Sum of savings of the listed items. May double count a resource with several categories. */
  listedSavingsMinor: bigint;
  /** Sum over listed resources of the largest single saving on that resource. */
  nonOverlappingSavingsMinor: bigint;
}

export interface RankResult {
  groups: RankGroup[];
  inputCount: number;
  rejected: number;
  rejectedByReason: Partial<Record<RejectCode, number>>;
  exactDuplicatesDropped: number;
  formula: string;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Better first: confidence, savings, then stable name tie-breaks. */
function compareForWinner(a: NativeRecommendation, b: NativeRecommendation): number {
  return (
    CONFIDENCE_ORDER[b.confidence] - CONFIDENCE_ORDER[a.confidence] ||
    cmpBig(b.estimatedSavingsMinor, a.estimatedSavingsMinor) ||
    cmpStr(a.source, b.source) ||
    cmpStr(a.sourceId, b.sourceId)
  );
}

export function scoreOf(item: NativeRecommendation): bigint {
  return (
    item.estimatedSavingsMinor *
    BigInt(CONFIDENCE_WEIGHT_BPS[item.confidence]) *
    BigInt(EFFORT_FACTOR_BPS[item.effort]) *
    BigInt(RISK_FACTOR_BPS[item.risk])
  );
}

function compareRanked(a: RankedRecommendation, b: RankedRecommendation): number {
  return (
    cmpBig(b.score, a.score) ||
    cmpBig(b.estimatedSavingsMinor, a.estimatedSavingsMinor) ||
    CONFIDENCE_ORDER[b.confidence] - CONFIDENCE_ORDER[a.confidence] ||
    cmpStr(a.source, b.source) ||
    cmpStr(a.sourceId, b.sourceId) ||
    cmpStr(a.resourceId, b.resourceId) ||
    cmpStr(a.category, b.category)
  );
}

export function rankRecommendations(
  items: ReadonlyArray<NativeRecommendation>,
  options: RankOptions = {},
): RankResult {
  if (!Array.isArray(items)) throw new RecommendInputError('INVALID_INPUT');
  if (items.length > MAX_RANK_INPUT) throw new RecommendInputError('TOO_MANY_ITEMS');
  if (options === null || typeof options !== 'object') throw new RecommendInputError('INVALID_INPUT');
  const cap = options.maxOutputPerCurrency ?? DEFAULT_MAX_OUTPUT_PER_CURRENCY;
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_OUTPUT_PER_CURRENCY) throw new RecommendInputError('INVALID_INPUT');

  const rejectedByReason: Partial<Record<RejectCode, number>> = {};
  let rejected = 0;
  const valid: NativeRecommendation[] = [];
  for (const raw of items) {
    let result: ReturnType<typeof validateNativeRecommendation>;
    try {
      result = validateNativeRecommendation(raw);
    } catch {
      result = { ok: false, code: 'unexpected_error' };
    }
    if (result.ok) valid.push(result.value);
    else {
      rejected++;
      rejectedByReason[result.code] = (rejectedByReason[result.code] ?? 0) + 1;
    }
  }

  // Group duplicates.
  const groups = new Map<string, NativeRecommendation[]>();
  for (const it of valid) {
    const key = `${it.currency}\u0000${it.resourceId.toLowerCase()}\u0000${it.category}`;
    const g = groups.get(key);
    if (g) g.push(it);
    else groups.set(key, [it]);
  }

  let exactDuplicatesDropped = 0;
  const winners: RankedRecommendation[] = [];
  for (const g of groups.values()) {
    g.sort(compareForWinner);
    const winner = g[0];
    const seen = new Set<string>([`${winner.source}\u0000${winner.sourceId}`]);
    const corroborating: Corroboration[] = [];
    let corroboratingTotal = 0;
    for (let i = 1; i < g.length; i++) {
      const other = g[i];
      const id = `${other.source}\u0000${other.sourceId}`;
      if (seen.has(id)) {
        exactDuplicatesDropped++;
        continue;
      }
      seen.add(id);
      corroboratingTotal++;
      if (corroborating.length < MAX_CORROBORATING) {
        corroborating.push({
          source: other.source,
          sourceId: other.sourceId,
          confidence: other.confidence,
          estimatedSavingsMinor: other.estimatedSavingsMinor,
        });
      }
    }
    const score = scoreOf(winner);
    winners.push({
      ...winner,
      evidence: [...winner.evidence],
      rank: 0,
      score,
      weightedSavingsMinor: score / SCORE_SCALE,
      corroborating,
      corroboratingTotal,
      otherCategoriesOnResource: [],
    });
  }

  // Flag resources that carry several categories.
  const categoriesByResource = new Map<string, Set<RecommendationCategory>>();
  for (const w of winners) {
    const key = `${w.currency}\u0000${w.resourceId.toLowerCase()}`;
    const set = categoriesByResource.get(key) ?? new Set<RecommendationCategory>();
    set.add(w.category);
    categoriesByResource.set(key, set);
  }
  for (const w of winners) {
    const set = categoriesByResource.get(`${w.currency}\u0000${w.resourceId.toLowerCase()}`);
    w.otherCategoriesOnResource = [...(set ?? [])].filter((c) => c !== w.category).sort(cmpStr);
  }

  // Rank inside each currency.
  const byCurrency = new Map<string, RankedRecommendation[]>();
  for (const w of winners) {
    const list = byCurrency.get(w.currency);
    if (list) list.push(w);
    else byCurrency.set(w.currency, [w]);
  }
  const outGroups: RankGroup[] = [];
  for (const currency of [...byCurrency.keys()].sort(cmpStr)) {
    const all = (byCurrency.get(currency) as RankedRecommendation[]).sort(compareRanked);
    const kept = all.slice(0, cap);
    kept.forEach((k, i) => {
      k.rank = i + 1;
    });
    let listed = ZERO;
    const maxPerResource = new Map<string, bigint>();
    for (const k of kept) {
      listed += k.estimatedSavingsMinor;
      const rk = k.resourceId.toLowerCase();
      const prior = maxPerResource.get(rk);
      if (prior === undefined || k.estimatedSavingsMinor > prior) maxPerResource.set(rk, k.estimatedSavingsMinor);
    }
    let nonOverlapping = ZERO;
    for (const v of maxPerResource.values()) nonOverlapping += v;
    outGroups.push({
      currency,
      items: kept,
      truncated: all.length - kept.length,
      listedSavingsMinor: listed,
      nonOverlappingSavingsMinor: nonOverlapping,
    });
  }

  return {
    groups: outGroups,
    inputCount: items.length,
    rejected,
    rejectedByReason,
    exactDuplicatesDropped,
    formula: RANK_FORMULA,
  };
}

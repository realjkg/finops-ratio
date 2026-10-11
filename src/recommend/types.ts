// Shared types for native savings recommendations (checklist items 4.2 and 4.3).
//
// Trust boundary: a NativeRecommendation is the ONE internal shape every feed is
// reduced to. Feed payloads are untrusted; they are parsed by the normalizers,
// and every NativeRecommendation (including ones built by callers) is re-checked
// by validateNativeRecommendation before it can be ranked.
//
// Period: every amount is MONTHLY. Feeds that report another period are scaled
// by the normalizer or refused.
//
// R4 (value is the denominator): fleet cloud spend has no attributed business
// value, so every recommendation carries valueContext = 'none_available' and the
// text below. The engine labels the absence; it never invents a value.

export type RecommendationSource =
  | 'aws_compute_optimizer'
  | 'azure_advisor'
  | 'gcp_recommender'
  | 'pointfive';

export const RECOMMENDATION_SOURCES: readonly RecommendationSource[] = [
  'aws_compute_optimizer',
  'azure_advisor',
  'gcp_recommender',
  'pointfive',
];

export type RecommendationCategory = 'rightsize' | 'idle' | 'unattached' | 'commitment' | 'other';

export const RECOMMENDATION_CATEGORIES: readonly RecommendationCategory[] = [
  'rightsize',
  'idle',
  'unattached',
  'commitment',
  'other',
];

export type Level = 'low' | 'medium' | 'high';
export const LEVELS: readonly Level[] = ['low', 'medium', 'high'];

export const VALUE_CONTEXT_NOTE =
  'Fleet cloud spend has no attributed business value; this saving is shown as cost only, with no value context (R4).';

export interface NativeRecommendation {
  source: RecommendationSource;
  /** Identifier of the recommendation within its source. */
  sourceId: string;
  resourceId: string;
  category: RecommendationCategory;
  /** Current MONTHLY spend on the resource, minor units. null when the feed does not supply it. */
  currentSpendMinor: bigint | null;
  /** Estimated MONTHLY saving, minor units. Always positive on a valid item. */
  estimatedSavingsMinor: bigint;
  /** ISO 4217-shaped code. Amounts are never combined across currencies. */
  currency: string;
  confidence: Level;
  /** Effort to apply the change. */
  effort: Level;
  /** Risk of applying the change. */
  risk: Level;
  /** Short, sanitized references to the feed fields that justify the item. */
  evidence: string[];
  period: 'monthly';
  valueContext: 'none_available';
}

/** Effort and risk used when a feed does not state them. Owner-confirmable. */
export const CATEGORY_DEFAULTS: Readonly<Record<RecommendationCategory, { effort: Level; risk: Level }>> = {
  rightsize: { effort: 'medium', risk: 'medium' },
  idle: { effort: 'low', risk: 'medium' },
  unattached: { effort: 'low', risk: 'low' },
  commitment: { effort: 'low', risk: 'high' },
  other: { effort: 'medium', risk: 'medium' },
};

export const MAX_FEED_ITEMS = 5_000;
export const MAX_ID_LENGTH = 512;
export const MAX_EVIDENCE_REFS = 8;
export const MAX_EVIDENCE_LENGTH = 120;
/** Largest plausible single amount: 10^15 minor units. */
export const MAX_MINOR = BigInt('1000000000000000');

// --- fixed-text reject and skip codes ---------------------------------------

export type RejectCode =
  | 'not_an_object'
  | 'invalid_source'
  | 'invalid_id'
  | 'invalid_resource'
  | 'invalid_category'
  | 'invalid_currency'
  | 'invalid_rating'
  | 'invalid_evidence'
  | 'invalid_shape'
  | 'invalid_amount'
  | 'non_finite_amount'
  | 'non_integer_amount'
  | 'negative_savings'
  | 'zero_savings'
  | 'implausible_amount'
  | 'implausible_percentage'
  | 'savings_exceed_spend'
  | 'unknown_finding'
  | 'missing_savings'
  | 'missing_state'
  | 'invalid_duration'
  | 'ambiguous_savings_period'
  | 'unexpected_error';

export const REJECT_MESSAGES: Readonly<Record<RejectCode, string>> = {
  not_an_object: 'item is not an object',
  invalid_source: 'source is not a known recommendation source',
  invalid_id: 'identifier is missing, too long or contains control characters',
  invalid_resource: 'resource identifier is missing or invalid',
  invalid_category: 'category is not one of the supported categories',
  invalid_currency: 'currency is not a three-letter uppercase code',
  invalid_rating: 'confidence, effort or risk is not low, medium or high',
  invalid_evidence: 'evidence references are malformed or over the cap',
  invalid_shape: 'item does not match the expected shape',
  invalid_amount: 'amount is missing, malformed or out of range',
  non_finite_amount: 'amount is not a finite number',
  non_integer_amount: 'amount is not an integer count of minor units',
  negative_savings: 'estimated savings are negative',
  zero_savings: 'estimated savings are zero',
  implausible_amount: 'amount is above the plausibility ceiling',
  implausible_percentage: 'savings percentage is outside (0, 100]',
  savings_exceed_spend: 'estimated savings exceed the current spend',
  unknown_finding: 'finding value is not recognized',
  missing_savings: 'savings estimate is missing',
  missing_state: 'recommendation state is missing',
  invalid_duration: 'cost projection duration is malformed',
  ambiguous_savings_period: 'savings period cannot be determined',
  unexpected_error: 'item could not be processed',
};

export type SkipCode =
  | 'no_savings_opportunity'
  | 'not_cost_recommendation'
  | 'not_active'
  | 'suppressed'
  | 'cost_increase'
  | 'zero_savings'
  | 'no_quantified_savings';

export const SKIP_MESSAGES: Readonly<Record<SkipCode, string>> = {
  no_savings_opportunity: 'finding is optimized or needs more capacity; not a saving',
  not_cost_recommendation: 'recommendation is not a cost recommendation',
  not_active: 'recommendation is not active',
  suppressed: 'recommendation is suppressed or dismissed',
  cost_increase: 'recommendation increases cost',
  zero_savings: 'estimated savings are zero',
  no_quantified_savings: 'recommendation carries no quantified savings',
};

export type RefusalCode = 'UNRECOGNIZED_PAYLOAD' | 'TOO_MANY_ITEMS';

export const REFUSAL_MESSAGES: Readonly<Record<RefusalCode, string>> = {
  UNRECOGNIZED_PAYLOAD: 'payload is not a recognized recommendation response shape',
  TOO_MANY_ITEMS: 'payload has more items than the per-call cap',
};

export interface NormalizeResult {
  source: RecommendationSource;
  items: NativeRecommendation[];
  /** Items that failed strict parsing or the plausibility checks. */
  rejected: number;
  /** Well-formed items that are not an actionable saving (optimized, dismissed, cost increase). */
  skipped: number;
  rejectedByReason: Partial<Record<RejectCode, number>>;
  skippedByReason: Partial<Record<SkipCode, number>>;
  /** Set when the WHOLE payload was refused; items is then empty. */
  refused: RefusalCode | null;
  /** Fixed text for `refused`; null when not refused. */
  refusalMessage: string | null;
}

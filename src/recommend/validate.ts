// Strict validation of a NativeRecommendation (checklist 4.2 and 4.4).
//
// Used by the feed normalizers (so every item they emit has passed the same
// gate) and by rankRecommendations (so items from any caller are re-checked).
// Deny by default: any field that is not exactly the documented type rejects the
// item. Reject codes are fixed; no input text is ever echoed.

import { isCurrencyCode } from './money';
import {
  LEVELS,
  MAX_EVIDENCE_LENGTH,
  MAX_EVIDENCE_REFS,
  MAX_ID_LENGTH,
  MAX_MINOR,
  RECOMMENDATION_CATEGORIES,
  RECOMMENDATION_SOURCES,
  type Level,
  type NativeRecommendation,
  type RecommendationCategory,
  type RecommendationSource,
  type RejectCode,
} from './types';

export type ValidationResult =
  | { ok: true; value: NativeRecommendation }
  | { ok: false; code: RejectCode };

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Own-property read: never walks the prototype chain. */
export function own(o: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A non-empty identifier within the length cap and free of control characters. */
export function isSafeId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH && !CONTROL_CHARS.test(v);
}

type AmountCheck = { ok: true; value: bigint } | { ok: false; code: RejectCode };

function checkBigint(v: unknown): AmountCheck {
  if (typeof v === 'bigint') return { ok: true, value: v };
  if (typeof v === 'number' && !Number.isFinite(v)) return { ok: false, code: 'non_finite_amount' };
  return { ok: false, code: 'non_integer_amount' };
}

export function validateNativeRecommendation(x: unknown): ValidationResult {
  const fail = (code: RejectCode): ValidationResult => ({ ok: false, code });
  if (!isRecord(x)) return fail('not_an_object');

  const source = own(x, 'source');
  if (typeof source !== 'string' || !RECOMMENDATION_SOURCES.includes(source as RecommendationSource)) {
    return fail('invalid_source');
  }
  const sourceId = own(x, 'sourceId');
  if (!isSafeId(sourceId)) return fail('invalid_id');
  const resourceId = own(x, 'resourceId');
  if (!isSafeId(resourceId)) return fail('invalid_resource');
  const category = own(x, 'category');
  if (typeof category !== 'string' || !RECOMMENDATION_CATEGORIES.includes(category as RecommendationCategory)) {
    return fail('invalid_category');
  }
  const currency = own(x, 'currency');
  if (!isCurrencyCode(currency)) return fail('invalid_currency');

  const confidence = own(x, 'confidence');
  const effort = own(x, 'effort');
  const risk = own(x, 'risk');
  for (const lvl of [confidence, effort, risk]) {
    if (typeof lvl !== 'string' || !LEVELS.includes(lvl as Level)) return fail('invalid_rating');
  }
  if (own(x, 'period') !== 'monthly' || own(x, 'valueContext') !== 'none_available') return fail('invalid_shape');

  const savings = checkBigint(own(x, 'estimatedSavingsMinor'));
  if (!savings.ok) return fail(savings.code);
  if (savings.value < BigInt(0)) return fail('negative_savings');
  if (savings.value === BigInt(0)) return fail('zero_savings');
  if (savings.value > MAX_MINOR) return fail('implausible_amount');

  let current: bigint | null = null;
  const rawCurrent = own(x, 'currentSpendMinor');
  if (rawCurrent !== null && rawCurrent !== undefined) {
    const c = checkBigint(rawCurrent);
    if (!c.ok) return fail(c.code);
    if (c.value < BigInt(0)) return fail('invalid_amount');
    if (c.value > MAX_MINOR) return fail('implausible_amount');
    if (savings.value > c.value) return fail('savings_exceed_spend');
    current = c.value;
  }

  const evidence = own(x, 'evidence');
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE_REFS) return fail('invalid_evidence');
  for (const e of evidence) {
    if (typeof e !== 'string' || e.length === 0 || e.length > MAX_EVIDENCE_LENGTH || CONTROL_CHARS.test(e)) {
      return fail('invalid_evidence');
    }
  }

  return {
    ok: true,
    value: {
      source: source as RecommendationSource,
      sourceId,
      resourceId,
      category: category as RecommendationCategory,
      currentSpendMinor: current,
      estimatedSavingsMinor: savings.value,
      currency,
      confidence: confidence as Level,
      effort: effort as Level,
      risk: risk as Level,
      evidence: [...(evidence as string[])],
      period: 'monthly',
      valueContext: 'none_available',
    },
  };
}

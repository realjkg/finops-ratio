// AWS Compute Optimizer normalizer (checklist 4.2).
//
// VALIDATION WARNING: the field mapping below is based on the DOCUMENTED shape
// of the Compute Optimizer responses (GetEC2InstanceRecommendations,
// GetEBSVolumeRecommendations, GetIdleRecommendations). This build cannot call
// the API, so the mapping has NOT been checked against live responses. It MUST
// be validated against live responses before any figure from it is trusted.
//
// Input: the parsed JSON body of ONE of those calls (or a merge of them).
// Recognized envelope keys: instanceRecommendations, volumeRecommendations,
// idleRecommendations. Anything else is UNRECOGNIZED_PAYLOAD.
//
// Mapping (all amounts monthly, from savingsOpportunity.estimatedMonthlySavings):
//   instance: finding Overprovisioned/NotOptimized -> rightsize, savings of the
//     top-ranked recommendationOptions entry (lowest rank, then array order).
//     Optimized/Underprovisioned are skipped (not a saving).
//   volume:   finding NotOptimized -> rightsize (volumeRecommendationOptions).
//   idle:     finding Idle -> idle (savingsOpportunity on the item itself).
//   currentSpend: DERIVED as savings / (savingsOpportunityPercentage / 100) when
//     the percentage is present and in (0, 100]; otherwise null. It is not a
//     field AWS returns, and the derivation is labeled in the evidence refs.
//   confidence: lookBackPeriodInDays >= 30 with performanceRisk <= 1 -> high;
//     >= 14 with performanceRisk <= 2 -> medium; otherwise low. Idle items use
//     the look-back alone (>= 30 high, >= 14 medium, else low).
//   risk: performanceRisk (documented 0 to 4 scale) <= 1 low, <= 2 medium, else
//     high; idle items use the category default.
//   effort: migrationEffort VeryLow/Low -> low, Medium -> medium, High -> high;
//     absent -> the category default.
// The confidence thresholds and the effort/risk defaults are this engine's
// choices, not AWS semantics; the owner should confirm them.

import {
  buildItem,
  finiteNumber,
  normalizeEnvelope,
  reject,
  safeText,
  skip,
  token,
  type ItemOutcome,
} from './feedCommon';
import { divRound, isCurrencyCode, toMinorUnits } from './money';
import { isRecord, isSafeId, own } from './validate';
import { CATEGORY_DEFAULTS, type Level, type NormalizeResult, type RecommendationCategory, type RejectCode } from './types';

type Savings =
  | { ok: true; savings: bigint; currency: string; current: bigint | null; pct: number | null }
  | { ok: false; code: RejectCode };

function parseSavingsOpportunity(sop: unknown): Savings {
  if (!isRecord(sop)) return { ok: false, code: 'missing_savings' };
  const est = own(sop, 'estimatedMonthlySavings');
  if (!isRecord(est)) return { ok: false, code: 'missing_savings' };
  const currency = own(est, 'currency');
  if (!isCurrencyCode(currency)) return { ok: false, code: 'invalid_currency' };
  const value = finiteNumber(own(est, 'value'));
  if (value === null) return { ok: false, code: 'invalid_amount' };
  if (value < 0) return { ok: false, code: 'negative_savings' };
  const savings = toMinorUnits(value, currency);
  if (savings === null) return { ok: false, code: 'invalid_amount' };

  let current: bigint | null = null;
  let pct: number | null = null;
  const rawPct = own(sop, 'savingsOpportunityPercentage');
  if (rawPct !== undefined && rawPct !== null) {
    const p = finiteNumber(rawPct);
    const pctBps = p === null ? 0 : Math.round(p * 100);
    if (p === null || pctBps <= 0 || pctBps > 10000) return { ok: false, code: 'implausible_percentage' };
    pct = p;
    current = divRound(savings * BigInt(10000), BigInt(pctBps));
  }
  return { ok: true, savings, currency, current, pct };
}

export function awsConfidence(lookBackDays: number | null, performanceRisk: number | null): Level {
  if (lookBackDays === null || performanceRisk === null) return 'low';
  if (lookBackDays >= 30 && performanceRisk <= 1) return 'high';
  if (lookBackDays >= 14 && performanceRisk <= 2) return 'medium';
  return 'low';
}

function idleConfidence(lookBackDays: number | null): Level {
  if (lookBackDays === null) return 'low';
  if (lookBackDays >= 30) return 'high';
  if (lookBackDays >= 14) return 'medium';
  return 'low';
}

function riskFromPerformance(perf: number | null, category: RecommendationCategory): Level {
  if (perf === null) return CATEGORY_DEFAULTS[category].risk;
  if (perf <= 1) return 'low';
  if (perf <= 2) return 'medium';
  return 'high';
}

function effortFromMigration(raw: unknown, category: RecommendationCategory): Level {
  switch (token(raw)) {
    case 'verylow':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    default:
      return CATEGORY_DEFAULTS[category].effort;
  }
}

/** Top-ranked option: lowest numeric rank, ties and missing ranks by array order. */
function topOption(options: readonly unknown[]): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;
  let bestRank = Infinity;
  for (const o of options) {
    if (!isRecord(o)) continue;
    const rank = finiteNumber(own(o, 'rank')) ?? Infinity;
    if (best === null || rank < bestRank) {
      best = o;
      bestRank = rank;
    }
  }
  return best;
}

function nonNegative(v: unknown): number | null {
  const n = finiteNumber(v);
  return n !== null && n >= 0 ? n : null;
}

function parseOptioned(
  raw: unknown,
  kind: 'ec2' | 'ebs',
  idKey: string,
  optionsKey: string,
  actionable: ReadonlySet<string>,
  inert: ReadonlySet<string>,
  typeKey: string,
  optionTypeKey: string,
): ItemOutcome {
  if (!isRecord(raw)) return reject('not_an_object');
  const arn = own(raw, idKey);
  if (!isSafeId(arn)) return reject('invalid_id');
  const finding = token(own(raw, 'finding'));
  if (finding === null) return reject('unknown_finding');
  if (inert.has(finding)) return skip('no_savings_opportunity');
  if (!actionable.has(finding)) return reject('unknown_finding');

  const options = own(raw, optionsKey);
  if (!Array.isArray(options) || options.length === 0) return reject('missing_savings');
  const opt = topOption(options);
  if (opt === null) return reject('missing_savings');
  const s = parseSavingsOpportunity(own(opt, 'savingsOpportunity'));
  if (!s.ok) return reject(s.code);
  if (s.savings === BigInt(0)) return skip('zero_savings');

  const lookBack = nonNegative(own(raw, 'lookBackPeriodInDays'));
  const perfRaw = finiteNumber(own(opt, 'performanceRisk'));
  const perf = perfRaw !== null && perfRaw >= 0 && perfRaw <= 4 ? perfRaw : null;
  const category: RecommendationCategory = 'rightsize';
  return buildItem({
    source: 'aws_compute_optimizer',
    sourceId: `${kind}:${arn}`,
    resourceId: arn,
    category,
    currentSpendMinor: s.current,
    estimatedSavingsMinor: s.savings,
    currency: s.currency,
    confidence: awsConfidence(lookBack, perf),
    effort: effortFromMigration(own(opt, 'migrationEffort'), category),
    risk: riskFromPerformance(perf, category),
    evidence: [
      `aws-co:finding=${finding}`,
      lookBack === null ? null : `aws-co:lookBackDays=${lookBack}`,
      perf === null ? null : `aws-co:performanceRisk=${perf}`,
      s.pct === null ? 'aws-co:currentSpend=unavailable' : `aws-co:currentSpend=derived-from-savings-pct:${s.pct}`,
      safeText(own(raw, typeKey)) === null ? null : `aws-co:current=${safeText(own(raw, typeKey))}`,
      safeText(own(opt, optionTypeKey)) === null ? null : `aws-co:recommended=${safeText(own(opt, optionTypeKey))}`,
    ],
  });
}

const EC2_ACTIONABLE = new Set(['overprovisioned', 'notoptimized']);
const EC2_INERT = new Set(['optimized', 'underprovisioned']);
const EBS_ACTIONABLE = new Set(['notoptimized']);
const EBS_INERT = new Set(['optimized']);

function parseInstance(raw: unknown): ItemOutcome {
  return parseOptioned(
    raw, 'ec2', 'instanceArn', 'recommendationOptions', EC2_ACTIONABLE, EC2_INERT, 'currentInstanceType', 'instanceType',
  );
}

function parseVolume(raw: unknown): ItemOutcome {
  return parseOptioned(
    raw, 'ebs', 'volumeArn', 'volumeRecommendationOptions', EBS_ACTIONABLE, EBS_INERT, 'currentVolumeType', 'volumeType',
  );
}

function parseIdle(raw: unknown): ItemOutcome {
  if (!isRecord(raw)) return reject('not_an_object');
  const arn = own(raw, 'resourceArn');
  if (!isSafeId(arn)) return reject('invalid_id');
  if (token(own(raw, 'finding')) !== 'idle') return reject('unknown_finding');
  const s = parseSavingsOpportunity(own(raw, 'savingsOpportunity'));
  if (!s.ok) return reject(s.code);
  if (s.savings === BigInt(0)) return skip('zero_savings');
  const lookBack = nonNegative(own(raw, 'lookBackPeriodInDays'));
  return buildItem({
    source: 'aws_compute_optimizer',
    sourceId: `idle:${arn}`,
    resourceId: arn,
    category: 'idle',
    currentSpendMinor: s.current,
    estimatedSavingsMinor: s.savings,
    currency: s.currency,
    confidence: idleConfidence(lookBack),
    evidence: [
      'aws-co:finding=idle',
      lookBack === null ? null : `aws-co:lookBackDays=${lookBack}`,
      s.pct === null ? 'aws-co:currentSpend=unavailable' : `aws-co:currentSpend=derived-from-savings-pct:${s.pct}`,
      safeText(own(raw, 'resourceType')) === null ? null : `aws-co:resourceType=${safeText(own(raw, 'resourceType'))}`,
    ],
  });
}

/** Normalizes parsed Compute Optimizer JSON. Never throws. */
export function normalizeAwsComputeOptimizer(payload: unknown): NormalizeResult {
  return normalizeEnvelope('aws_compute_optimizer', payload, [
    { key: 'instanceRecommendations', parse: parseInstance },
    { key: 'volumeRecommendations', parse: parseVolume },
    { key: 'idleRecommendations', parse: parseIdle },
  ]);
}

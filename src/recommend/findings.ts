// Adapters between NativeRecommendation and the existing CostFinding seam
// (src/costsource/CostSourceClient.ts), so native recommendations can sit beside
// PointFive findings and PointFive stays an optional source.
//
// Boundary notes:
//   - CostFinding has no currency field and its savings field is a float. The
//     outbound adapter therefore emits ONLY items in the one currency the caller
//     names, converts minor units to a number at this boundary (lossy above 2^53
//     minor units, which are skipped), and counts everything it did not emit.
//   - Severity is always 'info': an opportunity is not a policy violation.
//   - The title carries the R4 label because fleet cloud spend has no value
//     context to pair the saving with.
//   - workloadId stays null unless the caller supplies a resolver.
//   - Time is injected (detectedAt); nothing here reads a clock.

import type { CostFinding } from '@/costsource/CostSourceClient';
import { parseIsoUtc } from '@/costsource/transports/focusExport';
import { RecommendInputError } from './errors';
import { isCurrencyCode, minorToNumber, toMinorUnits } from './money';
import { safeText } from './feedCommon';
import { CATEGORY_DEFAULTS, type Level, type NativeRecommendation, type RecommendationCategory } from './types';
import { validateNativeRecommendation } from './validate';

const CATEGORY_TO_FINDING: Readonly<Record<RecommendationCategory, string>> = {
  rightsize: 'rightsizing',
  idle: 'idle_resource',
  unattached: 'unattached_resource',
  commitment: 'commitment',
  other: 'other',
};

const TITLE_VERB: Readonly<Record<RecommendationCategory, string>> = {
  rightsize: 'Rightsize',
  idle: 'Review idle resource',
  unattached: 'Remove unattached resource',
  commitment: 'Review commitment',
  other: 'Review',
};

const MAX_TITLE = 200;

export interface FindingAdapterContext {
  /** Only items in this currency are emitted. */
  currency: string;
  /** ISO-8601 detection time, supplied by the caller. */
  detectedAt: string;
  resolveWorkloadId?: (resourceId: string) => string | null;
}

export interface FindingsResult {
  findings: CostFinding[];
  skippedOtherCurrency: number;
  skippedUnrepresentable: number;
}

export function toCostFindings(
  items: ReadonlyArray<NativeRecommendation>,
  ctx: FindingAdapterContext,
): FindingsResult {
  if (!Array.isArray(items) || !isCurrencyCode(ctx?.currency)) throw new RecommendInputError('INVALID_INPUT');
  const detected = typeof ctx.detectedAt === 'string' ? parseIsoUtc(ctx.detectedAt) : null;
  if (detected === null) throw new RecommendInputError('INVALID_INPUT');
  const detectedAt = new Date(detected).toISOString();

  const findings: CostFinding[] = [];
  let skippedOtherCurrency = 0;
  let skippedUnrepresentable = 0;
  for (const raw of items) {
    const v = validateNativeRecommendation(raw);
    if (!v.ok) {
      skippedUnrepresentable++;
      continue;
    }
    const it = v.value;
    if (it.currency !== ctx.currency) {
      skippedOtherCurrency++;
      continue;
    }
    const savings = minorToNumber(it.estimatedSavingsMinor, it.currency);
    if (savings === null) {
      skippedUnrepresentable++;
      continue;
    }
    let workloadId: string | null;
    try {
      workloadId = ctx.resolveWorkloadId ? ctx.resolveWorkloadId(it.resourceId) : null;
    } catch {
      workloadId = null;
    }
    findings.push({
      id: `native:${it.source}:${it.sourceId}`,
      sourceId: `native:${it.source}`,
      type: 'opportunity',
      category: CATEGORY_TO_FINDING[it.category],
      title: `${TITLE_VERB[it.category]} ${it.resourceId} (cost only; no value context)`.slice(0, MAX_TITLE),
      resourceId: it.resourceId,
      workloadId,
      estimatedMonthlySavings: savings,
      observedSpendDelta: 0,
      severity: 'info',
      status: 'open',
      detectedAt,
    });
  }
  return { findings, skippedOtherCurrency, skippedUnrepresentable };
}

const FINDING_TO_CATEGORY: Readonly<Record<string, RecommendationCategory>> = {
  rightsizing: 'rightsize',
  rightsize: 'rightsize',
  idle_resource: 'idle',
  idle: 'idle',
  unattached_resource: 'unattached',
  unattached: 'unattached',
  commitment: 'commitment',
};

/**
 * Lifts an existing opportunity finding (for example from PointFive) into the
 * native shape so it can be ranked and de-duplicated beside native feeds.
 * CostFinding has no currency, so the caller states it. PointFive supplies no
 * confidence; the default is 'low' (conservative) unless the caller overrides it.
 * Returns null for anything that is not a valid positive-savings opportunity.
 */
export function fromCostFinding(
  finding: CostFinding,
  currency: string,
  opts: { confidence?: Level } = {},
): NativeRecommendation | null {
  if (finding === null || typeof finding !== 'object' || finding.type !== 'opportunity') return null;
  if (!isCurrencyCode(currency)) return null;
  const savings = toMinorUnits(finding.estimatedMonthlySavings, currency);
  if (savings === null) return null;
  const known = Object.prototype.hasOwnProperty.call(FINDING_TO_CATEGORY, finding.category);
  const category: RecommendationCategory = known ? FINDING_TO_CATEGORY[finding.category] : 'other';
  const defaults = CATEGORY_DEFAULTS[category];
  const result = validateNativeRecommendation({
    source: 'pointfive',
    sourceId: finding.id,
    resourceId: finding.resourceId,
    category,
    currentSpendMinor: null,
    estimatedSavingsMinor: savings,
    currency,
    confidence: opts.confidence ?? 'low',
    effort: defaults.effort,
    risk: defaults.risk,
    evidence: [
      safeText(finding.category) === null ? 'pointfive:category=unrecognized' : `pointfive:category=${safeText(finding.category)}`,
      'pointfive:confidence=not supplied; defaulted',
      'pointfive:currentSpend=unavailable',
    ],
    period: 'monthly',
    valueContext: 'none_available',
  });
  return result.ok ? result.value : null;
}

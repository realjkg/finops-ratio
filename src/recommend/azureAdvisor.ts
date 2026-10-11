// Azure Advisor normalizer (checklist 4.2).
//
// VALIDATION WARNING: the field mapping below is based on the DOCUMENTED shape
// of the Advisor "list recommendations" response (value[] of
// Microsoft.Advisor/recommendations). This build cannot call the API, so the
// mapping has NOT been checked against live responses. It MUST be validated
// against live responses before any figure from it is trusted. Advisor
// recommendation-type GUIDs are deliberately NOT hard-coded because they could
// not be verified.
//
// Input: the parsed JSON body { value: [...] }. Anything else is
// UNRECOGNIZED_PAYLOAD.
//
// Mapping:
//   skip: properties.category other than 'Cost'; non-empty suppressionIds; an
//     item that carries no savings fields at all.
//   savings: properties.extendedProperties.annualSavingsAmount / 12, rounded
//     half away from zero, in savingsCurrency. extendedProperties values are
//     strings in the documented shape; numbers are accepted too. The plain
//     `savingsAmount` field is NOT used: its period is not stated, so an item
//     with only `savingsAmount` is rejected (ambiguous_savings_period).
//   currentSpend: not part of the documented shape, so always null.
//   resource: properties.resourceMetadata.resourceId, else the part of `id`
//     before /providers/Microsoft.Advisor/recommendations/.
//   category: KEYWORD HEURISTIC over shortDescription text and the presence of
//     extendedProperties.targetSku (see classify below). Unsure -> 'other'.
//   confidence: medium when any of the P95 utilization metrics
//     (MaxCpuP95, MaxMemoryP95, MaxTotalNetworkP95) is present, otherwise low.
//     Advisor's `impact` is a benefit rating, not a confidence, and its `risk`
//     is the risk of NOT acting, so neither is used as confidence or risk.
//   effort/risk: category defaults from CATEGORY_DEFAULTS (owner-confirmable).

import { buildItem, normalizeEnvelope, reject, safeText, skip, type ItemOutcome } from './feedCommon';
import { divRound, isCurrencyCode, parseDecimalToMinor } from './money';
import { CATEGORY_DEFAULTS, type Level, type NormalizeResult, type RecommendationCategory } from './types';
import { isRecord, isSafeId, own } from './validate';

const ADVISOR_PATH = '/providers/microsoft.advisor/recommendations/';

export function classifyAzure(text: string, hasTargetSku: boolean): RecommendationCategory {
  const t = text.toLowerCase();
  if (/reserv|savings plan|savingsplan/.test(t)) return 'commitment';
  if (/unattached|orphan|not attached/.test(t)) return 'unattached';
  if (hasTargetSku) return 'rightsize';
  if (/shut ?down|idle|deallocat|unused|not in use/.test(t)) return 'idle';
  if (/right-?size|resize|right size/.test(t)) return 'rightsize';
  return 'other';
}

function resourceFrom(props: Record<string, unknown>, id: string): string | null {
  const meta = own(props, 'resourceMetadata');
  if (isRecord(meta)) {
    const rid = own(meta, 'resourceId');
    if (isSafeId(rid)) return rid;
  }
  const at = id.toLowerCase().indexOf(ADVISOR_PATH);
  if (at > 0) {
    const derived = id.slice(0, at);
    if (isSafeId(derived)) return derived;
  }
  return null;
}

function parseItem(raw: unknown): ItemOutcome {
  if (!isRecord(raw)) return reject('not_an_object');
  const id = own(raw, 'id');
  if (!isSafeId(id)) return reject('invalid_id');
  const props = own(raw, 'properties');
  if (!isRecord(props)) return reject('invalid_shape');
  if (own(props, 'category') !== 'Cost') return skip('not_cost_recommendation');
  const suppression = own(props, 'suppressionIds');
  if (Array.isArray(suppression) && suppression.length > 0) return skip('suppressed');

  const ext = own(props, 'extendedProperties');
  if (!isRecord(ext)) return skip('no_quantified_savings');
  const annual = own(ext, 'annualSavingsAmount');
  const plain = own(ext, 'savingsAmount');
  if ((annual === undefined || annual === null) && (plain === undefined || plain === null)) {
    return skip('no_quantified_savings');
  }
  if (annual === undefined || annual === null) return reject('ambiguous_savings_period');

  const currency = own(ext, 'savingsCurrency');
  if (!isCurrencyCode(currency)) return reject('invalid_currency');
  const annualMinor = parseDecimalToMinor(annual, currency);
  if (annualMinor === null) return reject('invalid_amount');
  if (annualMinor < BigInt(0)) return reject('negative_savings');
  const monthly = divRound(annualMinor, BigInt(12));
  if (monthly === BigInt(0)) return skip('zero_savings');

  const resourceId = resourceFrom(props, id);
  if (resourceId === null) return reject('invalid_resource');

  const sd = own(props, 'shortDescription');
  const sdText = isRecord(sd)
    ? [own(sd, 'problem'), own(sd, 'solution')].filter((s): s is string => typeof s === 'string').join(' ')
    : '';
  const targetSku = safeText(own(ext, 'targetSku'));
  const currentSku = safeText(own(ext, 'currentSku'));
  const category = classify(sdText, own(props, 'impactedField'), targetSku !== null);

  const hasMetric = ['MaxCpuP95', 'MaxMemoryP95', 'MaxTotalNetworkP95'].some((k) => {
    const v = own(ext, k);
    return v !== undefined && v !== null && v !== '';
  });
  const confidence: Level = hasMetric ? 'medium' : 'low';
  const impact = own(props, 'impact');
  const typeId = own(props, 'recommendationTypeId');
  return buildItem({
    source: 'azure_advisor',
    sourceId: id.slice(id.lastIndexOf('/') + 1) || id,
    resourceId,
    category,
    currentSpendMinor: null,
    estimatedSavingsMinor: monthly,
    currency,
    confidence,
    effort: CATEGORY_DEFAULTS[category].effort,
    risk: CATEGORY_DEFAULTS[category].risk,
    evidence: [
      'azure-advisor:savings=annualSavingsAmount/12',
      'azure-advisor:currentSpend=unavailable',
      impact === 'High' || impact === 'Medium' || impact === 'Low' ? `azure-advisor:impact=${impact}` : null,
      typeof typeId === 'string' && /^[0-9a-fA-F-]{36}$/.test(typeId) ? `azure-advisor:typeId=${typeId}` : null,
      currentSku === null ? null : `azure-advisor:currentSku=${currentSku}`,
      targetSku === null ? null : `azure-advisor:targetSku=${targetSku}`,
      hasMetric ? 'azure-advisor:utilizationMetrics=present' : 'azure-advisor:utilizationMetrics=absent',
    ],
  });
}

function classify(text: string, impactedField: unknown, hasTargetSku: boolean): RecommendationCategory {
  const field = typeof impactedField === 'string' ? impactedField : '';
  return classifyAzure(`${text} ${field}`, hasTargetSku);
}

/** Normalizes parsed Azure Advisor list JSON. Never throws. */
export function normalizeAzureAdvisor(payload: unknown): NormalizeResult {
  return normalizeEnvelope('azure_advisor', payload, [{ key: 'value', parse: parseItem }]);
}

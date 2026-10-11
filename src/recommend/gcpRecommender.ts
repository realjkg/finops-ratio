// GCP Recommender normalizer (checklist 4.2).
//
// VALIDATION WARNING: the field mapping below is based on the DOCUMENTED shape
// of the Recommender API list response ({ recommendations: [...] }, each a
// google.cloud.recommender.v1.Recommendation with primaryImpact.costProjection
// as google.type.Money and a duration). This build cannot call the API, so the
// mapping has NOT been checked against live responses. It MUST be validated
// against live responses before any figure from it is trusted.
//
// Input: the parsed JSON body. Anything without a recommendations array is
// UNRECOGNIZED_PAYLOAD.
//
// Mapping:
//   keep: stateInfo.state === 'ACTIVE'; other states are skipped; a missing
//     state is rejected (the documented shape always carries it).
//   skip: primaryImpact.category other than 'COST'; a cost projection that is
//     zero or positive (a cost increase is not a saving).
//   savings: -(costProjection.cost) as Money (units string + nanos), scaled to a
//     30-day month: monthly = total * 2,592,000 s / duration seconds, rounded
//     half away from zero at the currency's minor unit.
//   currentSpend: not part of the documented shape, so always null.
//   resource: the first operations[].resource under content.operationGroups;
//     for commitment recommendations only, the recommendation `name` is used
//     when no operation names a resource.
//   category: from the recommender ID in `name` (known IDs below); unknown
//     recommenders map to 'other' with low confidence.
//   confidence: medium for a known recommender, low for an unknown one. The
//     API has no confidence field; this is an engine default.
//   effort/risk: category defaults from CATEGORY_DEFAULTS (owner-confirmable).

import { buildItem, normalizeEnvelope, reject, safeText, skip, type ItemOutcome } from './feedCommon';
import { ONE, ZERO, absBig, currencyExponent, divRound, isCurrencyCode, pow10 } from './money';
import { CATEGORY_DEFAULTS, type Level, type NormalizeResult, type RecommendationCategory } from './types';
import { isRecord, isSafeId, own } from './validate';

const THIRTY_DAYS_SECONDS = BigInt(2_592_000);
const NANOS = BigInt(1_000_000_000);

/** Recommender IDs taken from the public Recommender documentation. */
export const GCP_RECOMMENDER_CATEGORIES: Readonly<Record<string, RecommendationCategory>> = {
  'google.compute.instance.MachineTypeRecommender': 'rightsize',
  'google.compute.instanceGroupManager.MachineTypeRecommender': 'rightsize',
  'google.cloudsql.instance.OverprovisionedRecommender': 'rightsize',
  'google.compute.instance.IdleResourceRecommender': 'idle',
  'google.cloudsql.instance.IdleRecommender': 'idle',
  'google.compute.image.IdleResourceRecommender': 'idle',
  'google.compute.disk.IdleResourceRecommender': 'unattached',
  'google.compute.address.IdleResourceRecommender': 'unattached',
  'google.compute.commitment.UsageCommitmentRecommender': 'commitment',
};

const NAME_RE = /^(?:projects|folders|organizations|billingAccounts)\/[^/]+\/locations\/[^/]+\/recommenders\/([^/]+)\/recommendations\/[^/]+$/;

/** Parses a protobuf Duration string like "2592000s" to whole seconds. */
function parseSeconds(v: unknown): bigint | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,12})(?:\.0{1,9})?s$/.exec(v);
  if (!m) return null;
  const s = BigInt(m[1]);
  return s > ZERO ? s : null;
}

/** google.type.Money to total nanos (units * 1e9 + nanos); null when malformed or sign-inconsistent. */
function moneyToNanos(m: unknown): { currency: string; nanos: bigint } | null {
  if (!isRecord(m)) return null;
  const currency = own(m, 'currencyCode');
  if (!isCurrencyCode(currency)) return null;
  const unitsRaw = own(m, 'units');
  let units: bigint;
  if (unitsRaw === undefined || unitsRaw === null) units = ZERO;
  else if (typeof unitsRaw === 'string' && /^-?\d{1,15}$/.test(unitsRaw)) units = BigInt(unitsRaw);
  else if (typeof unitsRaw === 'number' && Number.isSafeInteger(unitsRaw)) units = BigInt(unitsRaw);
  else return null;
  const nanosRaw = own(m, 'nanos');
  let nanos = ZERO;
  if (nanosRaw !== undefined && nanosRaw !== null) {
    if (typeof nanosRaw !== 'number' || !Number.isInteger(nanosRaw) || Math.abs(nanosRaw) > 999_999_999) return null;
    nanos = BigInt(nanosRaw);
  }
  // google.type.Money: units and nanos must not have opposite signs.
  if ((units > ZERO && nanos < ZERO) || (units < ZERO && nanos > ZERO)) return null;
  return { currency, nanos: units * NANOS + nanos };
}

function firstResource(content: unknown): string | null {
  if (!isRecord(content)) return null;
  const groups = own(content, 'operationGroups');
  if (!Array.isArray(groups)) return null;
  for (const g of groups) {
    if (!isRecord(g)) continue;
    const ops = own(g, 'operations');
    if (!Array.isArray(ops)) continue;
    for (const op of ops) {
      if (!isRecord(op)) continue;
      const r = own(op, 'resource');
      if (isSafeId(r)) return r;
    }
  }
  return null;
}

function parseItem(raw: unknown): ItemOutcome {
  if (!isRecord(raw)) return reject('not_an_object');
  const name = own(raw, 'name');
  if (!isSafeId(name)) return reject('invalid_id');
  const nameMatch = NAME_RE.exec(name);
  if (!nameMatch) return reject('invalid_id');
  const recommenderId = nameMatch[1];

  const stateInfo = own(raw, 'stateInfo');
  const state = isRecord(stateInfo) ? own(stateInfo, 'state') : undefined;
  if (typeof state !== 'string') return reject('missing_state');
  if (state === 'DISMISSED') return skip('suppressed');
  if (state !== 'ACTIVE') return skip('not_active');

  const impact = own(raw, 'primaryImpact');
  if (!isRecord(impact)) return reject('invalid_shape');
  if (own(impact, 'category') !== 'COST') return skip('not_cost_recommendation');
  const projection = own(impact, 'costProjection');
  if (!isRecord(projection)) return reject('missing_savings');
  const money = moneyToNanos(own(projection, 'cost'));
  if (money === null) return reject('invalid_amount');
  const seconds = parseSeconds(own(projection, 'duration'));
  if (seconds === null) return reject('invalid_duration');
  if (money.nanos >= ZERO) return skip(money.nanos === ZERO ? 'zero_savings' : 'cost_increase');

  // Savings are the magnitude of the (negative) cost change, scaled to 30 days.
  const exp = currencyExponent(money.currency);
  const monthlyNanos = divRound(absBig(money.nanos) * THIRTY_DAYS_SECONDS, seconds);
  const minor = divRound(monthlyNanos * pow10(exp), NANOS);
  if (minor < ONE) return skip('zero_savings');

  const known = Object.prototype.hasOwnProperty.call(GCP_RECOMMENDER_CATEGORIES, recommenderId);
  const category: RecommendationCategory = known ? GCP_RECOMMENDER_CATEGORIES[recommenderId] : 'other';
  const resource = firstResource(own(raw, 'content')) ?? (category === 'commitment' ? name : null);
  if (resource === null) return reject('invalid_resource');

  const confidence: Level = known ? 'medium' : 'low';
  const subtype = safeText(own(raw, 'recommenderSubtype'));
  const priority = own(raw, 'priority');
  return buildItem({
    source: 'gcp_recommender',
    sourceId: name,
    resourceId: resource,
    category,
    currentSpendMinor: null,
    estimatedSavingsMinor: minor,
    currency: money.currency,
    confidence,
    effort: CATEGORY_DEFAULTS[category].effort,
    risk: CATEGORY_DEFAULTS[category].risk,
    evidence: [
      `gcp-recommender:recommender=${safeText(recommenderId, 96) ?? 'unrecognized'}`,
      subtype === null ? null : `gcp-recommender:subtype=${subtype}`,
      typeof priority === 'string' && /^P[1-4]$/.test(priority) ? `gcp-recommender:priority=${priority}` : null,
      'gcp-recommender:currentSpend=unavailable',
      'gcp-recommender:savings=-costProjection scaled to 30 days',
    ],
  });
}

/** Normalizes parsed GCP Recommender list JSON. Never throws. */
export function normalizeGcpRecommender(payload: unknown): NormalizeResult {
  return normalizeEnvelope('gcp_recommender', payload, [{ key: 'recommendations', parse: parseItem }]);
}

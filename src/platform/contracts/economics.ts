// Economics contracts (ADR-0001 §4.1, Stream A): AI usage events, financial records, rate cards and allocations.
// Usage and money are separate records linked by id, never merged: an estimate and a bill for the same calls are two
// records, so neither is counted twice. Absent usage is unknown, never 0; nothing here fills a default.
import { arr, C, checkActor, instantBefore, isPseudonymousRef, isServiceRef, isZeroDecimal, literal, obj, oneOf, opt, req, rule, sameSignOrZero, set, sumsExactly, validator, ACTOR_TYPES, type ActorType, type Problems } from './validate';

export const TOKEN_CATEGORIES = ['input', 'output', 'cachedInput', 'cacheWrite', 'reasoning'] as const;
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];
export const UNIT_KINDS = ['image', 'audio_second', 'video_second', 'request', 'tool_call', 'web_search'] as const;
export const SERVICE_TIERS = ['standard', 'batch', 'priority', 'flex', 'unknown'] as const;
export const USAGE_STATUSES = ['succeeded', 'failed', 'cancelled', 'unknown'] as const;

/**
 * Token counts as canonical integer strings (whole tokens). `accountingProfile` names the provider mapping (e.g. `openai-chat/1`) that
 * says which categories overlap (cached input inside input) and which are additive; no total is computed without it.
 */
export interface TokenUsage { input?: string; output?: string; cachedInput?: string; cacheWrite?: string; reasoning?: string; accountingProfile: string }
export interface UsageUnits { kind: (typeof UNIT_KINDS)[number]; quantity: string }

/** One model invocation attempt as observed by one source. Append-only: a correction is a new event with `supersedes`. */
export interface AIUsageEvent {
  schemaVersion: 'ai-usage-event/1';
  eventId: string;
  /** Resolved by trusted ingress from the authenticated connection, never from the payload. */
  tenantId: string;
  sourceConnectionId: string;
  /** Source-specific stable id (e.g. provider request id + attempt, or report bucket key): the dedup key. */
  dedupKey: string;
  supersedes?: string;
  occurredAt: string;
  receivedAt: string;
  workloadId?: string;
  actorRef?: string;
  actorType: ActorType;
  provider: string;
  modelRequested?: string;
  modelServed?: string;
  sku?: string;
  providerRequestId?: string;
  /** A retry is its own attempt and may be billed separately. */
  attempt?: number;
  serviceTier?: (typeof SERVICE_TIERS)[number];
  /** `reported` by the provider or `estimated` (e.g. by a gateway tokenizer); never mixed in one record. */
  usageBasis: 'reported' | 'estimated';
  /** Absent when the source reported no usage (e.g. a failed call): unknown, never 0. */
  tokenUsage?: TokenUsage;
  units?: UsageUnits[];
  status: (typeof USAGE_STATUSES)[number];
  evidenceRef: string;
}

const profile = rule('accounting-profile@1', 'accounting profile <name>/<version>', (v) => typeof v === 'string' && /^[a-z0-9-]{1,64}\/\d{1,4}$/.test(v));
const TOKENS = obj({ ...Object.fromEntries(TOKEN_CATEGORIES.map((k) => [k, opt(C.tokens)])), accountingProfile: req(profile) });
const UNITS = obj({ kind: req(oneOf(UNIT_KINDS)), quantity: req(C.quantity) });

export const validateAIUsageEvent = validator<AIUsageEvent>(obj({
  schemaVersion: req(literal('ai-usage-event/1')), eventId: req(C.id), tenantId: req(C.id), sourceConnectionId: req(C.id), dedupKey: req(C.id),
  supersedes: opt(C.id), occurredAt: req(C.instant), receivedAt: req(C.instant), workloadId: opt(C.id), actorRef: opt(C.id),
  actorType: req(oneOf(ACTOR_TYPES)), provider: req(C.id), modelRequested: opt(C.model), modelServed: opt(C.model), sku: opt(C.id),
  providerRequestId: opt(C.id), attempt: opt(C.positive), serviceTier: opt(oneOf(SERVICE_TIERS)), usageBasis: req(oneOf(['reported', 'estimated'])),
  tokenUsage: opt(TOKENS), units: opt(arr(UNITS, 1, 32)), status: req(oneOf(USAGE_STATUSES)), evidenceRef: req(C.id),
} satisfies { [K in keyof Required<AIUsageEvent>]: unknown }), {
  'actor-ref@1': (e, p) => checkActor(e.actorType, e.actorRef, p),
  'no-self-supersede@1': (e, p) => { if (e.supersedes === e.eventId) p.push('$.supersedes: an event cannot supersede itself'); },
  'received-after-occurred@1': (e, p) => { if (instantBefore(e.receivedAt, e.occurredAt)) p.push('$.receivedAt: before occurredAt'); },
});

export const FINANCIAL_KINDS = ['billed', 'effective', 'estimated_invocation', 'credit', 'adjustment'] as const;
export const RATE_BASES = ['contract', 'public_list', 'not_applicable', 'unknown'] as const;

/** A money record with provenance. Kinds are never summed together; currencies are never summed together. */
export interface FinancialRecord {
  schemaVersion: 'ai-financial-record/1';
  recordId: string; tenantId: string; sourceConnectionId: string;
  kind: (typeof FINANCIAL_KINDS)[number];
  amount: string; currency: string;
  /** Half-open period [periodStart, periodEnd). */
  periodStart: string; periodEnd: string;
  provider: string; providerAccount?: string; workloadId?: string; model?: string; sku?: string;
  rateBasis: (typeof RATE_BASES)[number];
  /** Required for `estimated_invocation`: the rate card version that priced it. */
  rateCardRef?: { rateCardId: string; version: number };
  configSha256?: string;
  /** Usage events this record prices or bills (link, not copy). */
  linkedUsageEventIds?: string[];
  supersedes?: string;
  evidenceRef: string;
}

function recordRules(r: FinancialRecord, p: Problems) {
  if (r.periodEnd <= r.periodStart) p.push('$.periodEnd: must be after periodStart');
  if (r.kind === 'estimated_invocation' && !r.rateCardRef) p.push('$.rateCardRef: required for an estimated_invocation record');
  if (r.supersedes === r.recordId) p.push('$.supersedes: a record cannot supersede itself');
}
export const validateFinancialRecord = validator<FinancialRecord>(obj({
  schemaVersion: req(literal('ai-financial-record/1')), recordId: req(C.id), tenantId: req(C.id), sourceConnectionId: req(C.id),
  kind: req(oneOf(FINANCIAL_KINDS)), amount: req(C.money), currency: req(C.currency), periodStart: req(C.date), periodEnd: req(C.date),
  provider: req(C.id), providerAccount: opt(C.id), workloadId: opt(C.id), model: opt(C.model), sku: opt(C.id), rateBasis: req(oneOf(RATE_BASES)),
  rateCardRef: opt(obj({ rateCardId: req(C.id), version: req(C.positive) })), configSha256: opt(C.sha256),
  linkedUsageEventIds: opt(set(C.id, 1)), supersedes: opt(C.id), evidenceRef: req(C.id),
} satisfies { [K in keyof Required<FinancialRecord>]: unknown }), {
  'record-rules@1': recordRules,
  'estimate-rate-basis@1': (r, p) => { if (r.kind === 'estimated_invocation' && !['contract', 'public_list'].includes(r.rateBasis)) p.push('$.rateBasis: an estimate is priced at a contract or public list rate'); },
  'credit-not-positive@1': (r, p) => { if (r.kind === 'credit' && !sameSignOrZero(r.amount, '-1')) p.push('$.amount: a credit is negative or 0'); },
});

export const PRICE_UNITS = ['per_1m_tokens', 'per_1k_tokens', 'per_token', 'per_unit'] as const;
/** One priced row. Cache and batch pricing are explicit rows (category `cachedInput`, tier `batch`), never multipliers. */
export interface RateCardEntry { model: string; sku?: string; category: TokenCategory | (typeof UNIT_KINDS)[number]; serviceTier: (typeof SERVICE_TIERS)[number]; unit: (typeof PRICE_UNITS)[number]; price: string }
export interface RateCard {
  schemaVersion: 'rate-card/1';
  rateCardId: string; version: number; tenantId: string; provider: string; currency: string;
  basis: 'contract' | 'public_list';
  /** Half-open [effectiveFrom, effectiveTo); open-ended when effectiveTo is absent. */
  effectiveFrom: string; effectiveTo?: string;
  entries: RateCardEntry[];
  provenance: { kind: 'public_price_page' | 'contract' | 'invoice' | 'owner_entry'; reference: string; retrievedOn: string };
}

const ENTRY = obj({
  model: req(C.model), sku: opt(C.id), category: req(oneOf([...TOKEN_CATEGORIES, ...UNIT_KINDS])), serviceTier: req(oneOf(SERVICE_TIERS)),
  unit: req(oneOf(PRICE_UNITS)), price: req(C.quantity),
});
export const validateRateCard = validator<RateCard>(obj({
  schemaVersion: req(literal('rate-card/1')), rateCardId: req(C.id), version: req(C.positive), tenantId: req(C.id), provider: req(C.id),
  currency: req(C.currency), basis: req(oneOf(['contract', 'public_list'])), effectiveFrom: req(C.date), effectiveTo: opt(C.date),
  entries: req(arr(ENTRY, 1)),
  provenance: req(obj({ kind: req(oneOf(['public_price_page', 'contract', 'invoice', 'owner_entry'])), reference: req(C.id), retrievedOn: req(C.date) })),
} satisfies { [K in keyof Required<RateCard>]: unknown }), {
  'rate-card-rules@1': (r, p) => {
    if (r.effectiveTo !== undefined && r.effectiveTo <= r.effectiveFrom) p.push('$.effectiveTo: must be after effectiveFrom');
    const seen = new Set<string>();
    r.entries.forEach((e, i) => {
      const key = [e.model, e.sku ?? '', e.category, e.serviceTier].join('\u0000');
      if (seen.has(key)) p.push(`$.entries[${i}]: duplicate model, sku, category and tier`);
      seen.add(key);
      if ((e.unit === 'per_unit') !== (UNIT_KINDS as readonly string[]).includes(e.category)) p.push(`$.entries[${i}].unit: does not fit category`);
    });
  },
  'basis-provenance@1': (r, p) => {
    const fits = r.basis === 'public_list' ? ['public_price_page', 'owner_entry'] : ['contract', 'invoice', 'owner_entry'];
    if (!fits.includes(r.provenance.kind)) p.push(`$.provenance.kind: does not support a ${r.basis} basis`);
  },
});

export const ALLOCATION_TARGETS = ['workload', 'team', 'cost_center', 'user', 'service'] as const;
/** Rule-based allocation of one amount in one currency and basis. The unallocated remainder is always explicit. */
export interface Allocation {
  schemaVersion: 'allocation/1';
  allocationId: string; tenantId: string;
  methodology: { ruleSetId: string; version: number };
  periodStart: string; periodEnd: string; currency: string;
  basis: 'billed' | 'effective' | 'estimated_invocation';
  sourceAmount: string;
  shares: { targetKind: (typeof ALLOCATION_TARGETS)[number]; targetRef: string; amount: string; ruleId: string }[];
  unallocated: string;
  unallocatedReasons: string[];
  evidenceRef: string;
}

export const validateAllocation = validator<Allocation>(obj({
  schemaVersion: req(literal('allocation/1')), allocationId: req(C.id), tenantId: req(C.id),
  methodology: req(obj({ ruleSetId: req(C.id), version: req(C.positive) })), periodStart: req(C.date), periodEnd: req(C.date),
  currency: req(C.currency), basis: req(oneOf(['billed', 'effective', 'estimated_invocation'])), sourceAmount: req(C.money),
  shares: req(arr(obj({ targetKind: req(oneOf(ALLOCATION_TARGETS)), targetRef: req(C.id), amount: req(C.money), ruleId: req(C.id) }))),
  unallocated: req(C.money), unallocatedReasons: req(arr(C.reason)), evidenceRef: req(C.id),
} satisfies { [K in keyof Required<Allocation>]: unknown }), {
  'allocation-rules@1': (a, p) => {
    if (a.periodEnd <= a.periodStart) p.push('$.periodEnd: must be after periodStart');
    if (!sumsExactly(a.shares.map((s) => s.amount), a.unallocated, a.sourceAmount)) p.push('$.unallocated: shares plus unallocated must equal sourceAmount exactly');
    if (!isZeroDecimal(a.unallocated) && a.unallocatedReasons.length === 0) p.push('$.unallocatedReasons: required when unallocated is not 0');
  },
  'share-sign@1': (a, p) => {
    a.shares.forEach((s, i) => { if (!sameSignOrZero(s.amount, a.sourceAmount)) p.push(`$.shares[${i}].amount: sign differs from sourceAmount`); });
    if (!sameSignOrZero(a.unallocated, a.sourceAmount)) p.push('$.unallocated: sign differs from sourceAmount');
  },
  'share-targets@1': (a, p) => {
    const targets = new Set<string>();
    a.shares.forEach((s, i) => {
      const key = `${s.targetKind}\u0000${s.targetRef}`;
      if (targets.has(key)) p.push(`$.shares[${i}]: duplicate target`);
      targets.add(key);
      const ok = s.targetKind === 'user' ? isPseudonymousRef(s.targetRef) : s.targetKind === 'service' ? isServiceRef(s.targetRef) : true;
      if (!ok) p.push(`$.shares[${i}].targetRef: does not match targetKind ${s.targetKind}`);
    });
  },
});

// FOCUS row schema for the cost-ingest seam (PR D).
//
// Three layers:
//   1. A source emits a `RawSourceRow` — the FOCUS columns its version supports.
//   2. `upgradeToCanonicalCost` backfills additive columns to reach the v1.4
//      canonical FOCUS shape (`CanonicalCostRow`) — the numerator.
//   3. The engine attaches Ratio value extensions (`RatioFocusExtensions`) to
//      produce a `CanonicalFocusRow` — numerator + denominator, the normalized
//      internal model the rest of Ratio consumes.
//
// x_Ratio* columns are FOCUS-legal vendor extensions (FOCUS spec §3.2). They are
// NOT supplied by the source — cost is the source's job; value is Ratio's.

import type { FocusVersion } from './focusVersions';

// --- v1.0 core (mandatory on every source) ---
export interface FocusCoreV10 {
  BilledCost: number;
  EffectiveCost: number;
  BillingCurrency: string;
  BillingPeriodStart: string; // ISO 8601
  BillingPeriodEnd: string; // ISO 8601
  ChargePeriodStart: string; // ISO 8601
  ChargePeriodEnd: string; // ISO 8601
  BillingAccountId: string;
  SubAccountId: string;
  ServiceName: string;
  ServiceCategory: string;
  ProviderName: string;
  ChargeCategory: string; // e.g. 'Usage'
  ChargeDescription: string;
  ResourceId: string; // identity used to resolve a Ratio workload
  PricingQuantity: number;
  PricingUnit: string;
  UsageQuantity: number;
  UsageUnit: string;
}

// --- additive deltas (grouped by what a RawSourceRow may omit; the FOCUS
// version that introduced each column is recorded in COLUMNS_BY_VERSION) ---
export interface FocusAddedV11 {
  ListCost: number;
  ContractedCost: number;
  ConsumedQuantity: number;
  ConsumedUnit: string;
  CommitmentDiscountStatus: string | null;
}
export interface FocusAddedV12 {
  ServiceSubcategory: string;
  InvoiceIssuerName: string;
}
export interface FocusAddedV13 {
  SkuMeter: string | null;
  // FOCUS 1.5 (working draft) widens the currency rules: this column may hold a
  // provider-issued unit (e.g. platform credits) — ISO 4217 codes stay reserved
  // for national currencies. See classifyCurrencyFormat below.
  PricingCurrency: string;
}
export interface FocusAddedV14 {
  CapacityReservationId: string | null;
  CapacityReservationStatus: string | null;
}

// --- v1.5 additive (WORKING DRAFT — ratification 3 Dec 2026) ---
// FOCUS 1.5's AI-cost properties are recommended and omittable: "a price that
// bills several kinds of tokens on one meter omits the property that would
// misdescribe them" (FR 2099). The backfill default is therefore null (omitted)
// — never a guessed label. Source-supplied values always win.
export type TokenCacheAction = 'Uncached' | 'Read' | 'Write' | 'Other';
export type TokenDirection = 'Input' | 'Output';

/**
 * In FOCUS 1.5 data, model identity and token labels are FOCUS-defined
 * PROPERTIES inside the existing SkuPriceDetails column, not columns: "The model
 * and token properties in 1.5 live here, which is why none of them needed new
 * columns" (Tokenomics Foundation, What FOCUS 1.5 does for AI cost, Nov 2026).
 * Ratio flattens them onto its canonical rows and the FinIO wire.
 */
export const SKU_PRICE_DETAILS_AI_PROPERTIES = [
  'ModelDeveloper',
  'ModelFamily',
  'ModelId',
  'ModelVersion',
  'TokenCacheAction',
  'TokenDirection',
] as const;
export type SkuPriceDetailsAiProperty = (typeof SKU_PRICE_DETAILS_AI_PROPERTIES)[number];

const TOKEN_CACHE_ACTIONS: readonly string[] = ['Uncached', 'Read', 'Write', 'Other'];
const TOKEN_DIRECTIONS: readonly string[] = ['Input', 'Output'];

/** The SkuPriceDetails column as a source supplies it: a JSON object, or its text (CSV exports). */
export interface FocusSkuPriceDetailsColumn {
  SkuPriceDetails: string | Record<string, unknown> | null;
}

/** SkuPriceDetails as an object, or null when absent, empty, malformed or not a JSON object (never throws). */
export function parseSkuPriceDetails(value: unknown): Record<string, unknown> | null {
  let v = value;
  if (typeof v === 'string') {
    const text = v.trim();
    if (text === '') return null;
    try {
      v = JSON.parse(text);
    } catch {
      return null;
    }
  }
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A property value Ratio accepts: a non-empty string, and for the token labels one of FOCUS's allowed values. */
function aiPropertyValue(key: SkuPriceDetailsAiProperty, v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  if (key === 'TokenCacheAction' && !TOKEN_CACHE_ACTIONS.includes(v)) return null;
  if (key === 'TokenDirection' && !TOKEN_DIRECTIONS.includes(v)) return null;
  return v;
}

export interface SkuPriceDetailsAi {
  values: Record<SkuPriceDetailsAiProperty, string | null>;
  /** Properties taken from a same-named top-level column (not where FOCUS 1.5 puts them). */
  fromTopLevelColumns: SkuPriceDetailsAiProperty[];
}

/**
 * Resolve the six AI properties for one raw row. SkuPriceDetails, where FOCUS
 * 1.5 defines them, always wins. A same-named top-level column is accepted only
 * as a fallback for non-standard exports, and is recorded (normalizeRows
 * reports it as aiPropertiesFromTopLevelColumns). A value outside FOCUS's allowed set is omitted, never guessed ("omit
 * rather than misdescribe"); rows such as a context-cache standing charge carry
 * no token labels and stay null.
 */
export function skuPriceDetailsAi(raw: Record<string, unknown>): SkuPriceDetailsAi {
  const details = parseSkuPriceDetails(raw.SkuPriceDetails);
  const values = {} as Record<SkuPriceDetailsAiProperty, string | null>;
  const fromTopLevelColumns: SkuPriceDetailsAiProperty[] = [];
  for (const key of SKU_PRICE_DETAILS_AI_PROPERTIES) {
    const inDetails = aiPropertyValue(key, details?.[key]);
    const topLevel = inDetails === null ? aiPropertyValue(key, raw[key]) : null;
    if (topLevel !== null) fromTopLevelColumns.push(key);
    values[key] = inDetails ?? topLevel;
  }
  return { values, fromTopLevelColumns };
}

export interface FocusAddedV15 {
  // Family 1 — model identity (FR 2018). ModelId is the identifier as it
  // appears in billing (can differ per provider); family/version/developer are
  // as the model developer defines them.
  ModelDeveloper: string | null;
  ModelFamily: string | null;
  ModelId: string | null;
  ModelVersion: string | null;
  // Family 2 — token labels (FR 2099).
  TokenCacheAction: TokenCacheAction | null;
  TokenDirection: TokenDirection | null;
  // Family 3 — requester attribution: the identity and credential behind the
  // charge (user, service account, agent — and the API key it used).
  PrincipalId: string | null;
  CredentialId: string | null;
  // JSON descriptor of calling context; draft shape provisional.
  RequesterDetails: string | null;
  // Family 5 — SKU Price: join key from the cost row to its price record
  // (FocusSkuPriceV15Draft below).
  SkuPriceId: string | null;
}

/**
 * FOCUS 1.5 SKU Price dataset record (working draft — in final review, FR 1057).
 * A price catalog separate from cost rows: list and negotiated prices with the
 * dates each applies; cost rows join via `SkuPriceId`. Column names are
 * provisional until ratification — do not build storage or UI on this type yet.
 */
export interface FocusSkuPriceV15Draft {
  SkuPriceId: string;
  /** Kind of price — e.g. public list, list fixed for a contract, contracted rate. */
  SkuPriceType: string;
  /** One unit price per record. */
  SkuPrice: number;
  /** ISO 4217 code or provider-issued unit (see classifyCurrencyFormat). */
  SkuPriceCurrency: string;
  SkuPriceEffectiveStart: string; // ISO 8601
  SkuPriceEffectiveEnd: string | null; // ISO 8601; null while the price is in force
  /** Empty for a price that is not specific to a contract. */
  ContractId: string | null;
}

// --- Ratio value extensions (the denominator) ---
export interface RatioFocusExtensions {
  x_RatioWorkloadId: string;
  x_RatioTeam: string; // owning team, resolved from the workload (org attribution; billing identity stays in SubAccountId)
  x_RatioValueRatio: number; // value.value_ratio
  x_RatioTotalValue: number; // value.total_value, in BillingCurrency
  x_RatioDemandShape: string; // DemandShape enum value
  x_RatioGovernanceGates: number; // 0-4 gates passed
  x_RatioSourceId: string; // which adapter the row came from
  x_RatioSourceVersion: FocusVersion; // the source's native FOCUS version
}

/** Full FOCUS v1.4 cost columns + the v1.5 working-draft families — no Ratio value yet. */
export type CanonicalCostRow = FocusCoreV10 &
  FocusAddedV11 &
  FocusAddedV12 &
  FocusAddedV13 &
  FocusAddedV14 &
  FocusAddedV15;

/** The normalized internal model: canonical cost columns + Ratio value extensions. */
export type CanonicalFocusRow = CanonicalCostRow & RatioFocusExtensions;

/**
 * Ratio org-attribution extensions (D1). Unlike the value extensions above,
 * these MAY be carried by the source export (x_Ratio* columns in a FOCUS file
 * are vendor extensions) and are mapped onto dedicated cost_facts columns at
 * ingest (src/ingest/focus/validate.ts - keep the spellings in sync; the
 * ingest worker deliberately does not import this module). Nullable
 * everywhere: a row with no evidence of a dimension stays unattributed -
 * absence is reported (allocation coverage), never imputed.
 */
export interface RatioAttributionExtensions {
  x_RatioProjectId?: string | null; // stable project identity across providers - a billing account is NOT the project boundary
  x_RatioBusinessUnit?: string | null; // financial boundary, not the project boundary
  x_RatioCostCenter?: string | null;
  x_RatioOwner?: string | null; // accountable owner
  x_RatioRegion?: string | null;
  x_RatioEnvironment?: string | null; // prod | staging | dev | sandbox
  x_RatioDirectOrShared?: string | null; // direct = billed to the project; shared = needs allocation
}

/** A canonical row that also carries the org-attribution extensions (D1). */
export type CanonicalAttributionRow = CanonicalFocusRow & RatioAttributionExtensions;

/** What a source at a given version actually emits: core + any newer columns. */
export type RawSourceRow = FocusCoreV10 &
  Partial<FocusAddedV11 & FocusAddedV12 & FocusAddedV13 & FocusAddedV14 & FocusAddedV15 & FocusSkuPriceDetailsColumn>;

/**
 * Version-negotiation shim. Upgrades a source's FOCUS export UP to the v1.4
 * canonical cost shape, backfilling columns introduced after the source's
 * version with backwards-compatible, additive defaults. The upgrade is driven
 * by column presence: a v1.4 source (every ratified column present) passes
 * through unchanged for ratified columns; a v1.0 source (newer columns absent)
 * gets each later column filled. Callers report exactly which columns were
 * added (normalizeRows: the ratified columns a raw row lacked) and `draftColumnsAfter` (draft).
 *
 * Defaults are derived from columns the source DOES provide so the canonical row
 * stays internally consistent (e.g. ListCost defaults to BilledCost when the
 * source predates list/contracted pricing).
 *
 * The v1.5 working-draft families are backfilled as null when the source omits
 * them (recommended, omittable properties — omitting beats misdescribing; the
 * registry-derived model identity is applied in normalize.ts, not here).
 */
export function upgradeToCanonicalCost(raw: RawSourceRow): CanonicalCostRow {
  const ai = skuPriceDetailsAi(raw as unknown as Record<string, unknown>).values;
  return {
    ...raw,
    // Key order is the wire order; the introducing FOCUS version of each
    // column is in COLUMNS_BY_VERSION. ListCost .. CommitmentDiscountStatus and
    // InvoiceIssuerName are 1.0 columns a (pre-1.0 style) source may omit.
    ListCost: raw.ListCost ?? raw.BilledCost,
    ContractedCost: raw.ContractedCost ?? raw.EffectiveCost,
    ConsumedQuantity: raw.ConsumedQuantity ?? raw.UsageQuantity,
    ConsumedUnit: raw.ConsumedUnit ?? raw.UsageUnit,
    CommitmentDiscountStatus: raw.CommitmentDiscountStatus ?? null,
    // 1.1: a 1.0 export has no subcategory and none can be derived, so it is
    // empty (how coercion represents an absent string), never a guessed label.
    ServiceSubcategory: raw.ServiceSubcategory ?? '',
    InvoiceIssuerName: raw.InvoiceIssuerName ?? raw.ProviderName,
    SkuMeter: raw.SkuMeter ?? null, // 1.1
    PricingCurrency: raw.PricingCurrency ?? raw.BillingCurrency, // 1.2
    CapacityReservationId: raw.CapacityReservationId ?? null, // 1.1
    CapacityReservationStatus: raw.CapacityReservationStatus ?? null, // 1.1
    // v1.5 additive (working draft — ratification 3 Dec 2026): omitted draft
    // properties stay null. Requester identity in particular is never invented
    // from team attribution — the x_RatioTeam bridge note governs that mapping.
    // Model identity and token labels come from SkuPriceDetails (skuPriceDetailsAi).
    ModelDeveloper: ai.ModelDeveloper,
    ModelFamily: ai.ModelFamily,
    ModelId: ai.ModelId,
    ModelVersion: ai.ModelVersion,
    TokenCacheAction: ai.TokenCacheAction as TokenCacheAction | null,
    TokenDirection: ai.TokenDirection as TokenDirection | null,
    PrincipalId: raw.PrincipalId ?? null,
    CredentialId: raw.CredentialId ?? null,
    RequesterDetails: raw.RequesterDetails ?? null,
    SkuPriceId: raw.SkuPriceId ?? null,
  };
}

export type CurrencyFormatKind = 'iso4217' | 'provider-issued';

/**
 * FOCUS 1.5 (working draft) currency rule: ISO 4217 codes are reserved for
 * national currencies, and a column must not use an ISO 4217 code for anything
 * else. `PricingCurrency` may therefore hold a provider-issued unit (platform
 * credits, normalized billing units) alongside billed cost in national
 * currency. Classifies a currency-column value so downstream code can keep the
 * two apart without assuming every value is a national currency.
 */
export function classifyCurrencyFormat(value: string): CurrencyFormatKind {
  return /^[A-Z]{3}$/.test(value) ? 'iso4217' : 'provider-issued';
}


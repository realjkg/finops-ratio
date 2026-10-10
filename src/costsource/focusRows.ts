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

// --- additive deltas by version ---
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
  PricingCurrency: string;
}
export interface FocusAddedV14 {
  CapacityReservationId: string | null;
  CapacityReservationStatus: string | null;
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

/** Full FOCUS v1.4 cost columns — no Ratio value yet. */
export type CanonicalCostRow = FocusCoreV10 &
  FocusAddedV11 &
  FocusAddedV12 &
  FocusAddedV13 &
  FocusAddedV14;

/** The normalized internal model: v1.4 cost columns + Ratio value extensions. */
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
  Partial<FocusAddedV11 & FocusAddedV12 & FocusAddedV13 & FocusAddedV14>;

/**
 * Version-negotiation shim. Upgrades a source's FOCUS export UP to the v1.4
 * canonical cost shape, backfilling columns introduced after the source's
 * version with backwards-compatible, additive defaults. The upgrade is driven
 * by column presence: a v1.4 source (every column present) passes through
 * unchanged; a v1.0 source (newer columns absent) gets each later column filled.
 * Callers report exactly which columns were added via `columnsAddedAfter`.
 *
 * Defaults are derived from columns the source DOES provide so the canonical row
 * stays internally consistent (e.g. ListCost defaults to BilledCost when the
 * source predates list/contracted pricing).
 */
export function upgradeToCanonicalCost(raw: RawSourceRow): CanonicalCostRow {
  return {
    ...raw,
    // v1.1 additive
    ListCost: raw.ListCost ?? raw.BilledCost,
    ContractedCost: raw.ContractedCost ?? raw.EffectiveCost,
    ConsumedQuantity: raw.ConsumedQuantity ?? raw.UsageQuantity,
    ConsumedUnit: raw.ConsumedUnit ?? raw.UsageUnit,
    CommitmentDiscountStatus: raw.CommitmentDiscountStatus ?? null,
    // v1.2 additive
    ServiceSubcategory: raw.ServiceSubcategory ?? 'Generative AI',
    InvoiceIssuerName: raw.InvoiceIssuerName ?? raw.ProviderName,
    // v1.3 additive
    SkuMeter: raw.SkuMeter ?? null,
    PricingCurrency: raw.PricingCurrency ?? raw.BillingCurrency,
    // v1.4 additive
    CapacityReservationId: raw.CapacityReservationId ?? null,
    CapacityReservationStatus: raw.CapacityReservationStatus ?? null,
  };
}


// FOCUS version primitives for the source-agnostic cost-ingest seam (PR D).
//
// Ratio's canonical internal cost schema targets FOCUS v1.4. Every source may
// export a different FOCUS version (PointFive documents v1.0; private-cloud and
// on-prem exporters may sit anywhere in v1.0-v1.4). The seam upgrades any source
// export UP to the v1.4 canonical model with version-aware, backwards-compatible
// normalization: cross-version deltas are additive (column additions only, no
// breaking changes), per FOCUS's version & conformance rules (focus.finops.org).
//
// FOCUS 1.5 (working draft — ratification 3 Dec 2026) is carried as a draft
// version: its AI-cost column families ride the same additive-delta pattern, so
// canonical rows already carry them and ratification needs no seam rework.
//
// NOTE: the per-version column assignment below is a representative model of the
// additive FOCUS deltas. Exact per-version column parity (notably PointFive's
// documented v1.0 -> v1.4 canonical) must be confirmed against a real export
// during trial setup — see the v2 spec's Workstream 2 parity caveat.

export type FocusVersion = '1.0' | '1.1' | '1.2' | '1.3' | '1.4' | '1.5';

/** All supported FOCUS versions, oldest first. */
export const FOCUS_VERSIONS: readonly FocusVersion[] = ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5'];

/** Ratio's canonical normalization target. */
export const CANONICAL_FOCUS_VERSION: FocusVersion = '1.4';

// --- FOCUS 1.5 working-draft status ---
// 1.5 is NOT yet a published spec (ratification 3 Dec 2026, per the FinOps
// Foundation's 1.5 release scope). Draft versions are carried end to end but
// excluded from A2A version negotiation until ratified.

export const FOCUS_15_RATIFICATION_DATE = '2026-12-03';

/** Versions that exist in the union but are not yet ratified. */
export const DRAFT_FOCUS_VERSIONS: readonly FocusVersion[] = ['1.5'];

/** True for a version still in working-draft status (currently 1.5). */
export function isDraftVersion(version: FocusVersion): boolean {
  return DRAFT_FOCUS_VERSIONS.includes(version);
}

/** Ratified versions only — the range A2A peers may negotiate. */
export const RATIFIED_FOCUS_VERSIONS: readonly FocusVersion[] = FOCUS_VERSIONS.filter(
  (v) => !isDraftVersion(v),
);

/** Ordinal rank of a version (0 = oldest), for comparisons. */
export function focusVersionRank(version: FocusVersion): number {
  return FOCUS_VERSIONS.indexOf(version);
}

/** True if `version` is at least `min`. */
export function isAtLeast(version: FocusVersion, min: FocusVersion): boolean {
  return focusVersionRank(version) >= focusVersionRank(min);
}

// Columns introduced by each FOCUS version, on top of the prior version. The
// v1.0 entry is the mandatory/core baseline every source must provide; later
// entries are purely additive. Used both to backfill older sources and to report
// exactly which columns the version shim had to add to reach the canonical model.
export const COLUMNS_BY_VERSION: Record<FocusVersion, readonly string[]> = {
  '1.0': [
    'BilledCost',
    'EffectiveCost',
    'BillingCurrency',
    'BillingPeriodStart',
    'BillingPeriodEnd',
    'ChargePeriodStart',
    'ChargePeriodEnd',
    'BillingAccountId',
    'SubAccountId',
    'ServiceName',
    'ServiceCategory',
    'ProviderName',
    'ChargeCategory',
    'ChargeDescription',
    'ResourceId',
    'PricingQuantity',
    'PricingUnit',
    'UsageQuantity',
    'UsageUnit',
  ],
  '1.1': ['ListCost', 'ContractedCost', 'ConsumedQuantity', 'ConsumedUnit', 'CommitmentDiscountStatus'],
  '1.2': ['ServiceSubcategory', 'InvoiceIssuerName'],
  '1.3': ['SkuMeter', 'PricingCurrency'],
  '1.4': ['CapacityReservationId', 'CapacityReservationStatus'],
  // FOCUS 1.5 — WORKING DRAFT (ratifies 3 Dec 2026). The five AI-cost column
  // families. Family 4 (consumption currency) is a CurrencyFormat RULE change,
  // not a column: PricingCurrency may hold a provider-issued unit (platform
  // credits), and ISO 4217 codes stay reserved for national currencies — see
  // classifyCurrencyFormat in focusRows.ts.
  '1.5': [
    // Family 1 — model identity (FR 2018): recommended SKU Price Details
    // properties; conformant datasets may omit them.
    'ModelDeveloper',
    'ModelFamily',
    'ModelId',
    'ModelVersion',
    // Family 2 — token labels (FR 2099): first FOCUS-defined properties with a
    // fixed allowed-value set; omitted rather than misdescribed.
    'TokenCacheAction',
    'TokenDirection',
    // Family 3 — requester attribution: the principal/credential behind a charge.
    'PrincipalId',
    'CredentialId',
    'RequesterDetails',
    // Family 5 — SKU Price: the join key to the draft price-catalog dataset.
    // (The published spec carries SkuPriceId in Cost and Usage already; this
    // representative manifest lacked it, so it scaffolds with the 1.5 block.)
    'SkuPriceId',
  ],
};

/**
 * Columns introduced strictly after `version` and at or before the canonical
 * target — i.e. what the shim backfills to reach the canonical (v1.4) model.
 * Unratified (draft) columns are excluded; they are backfilled too, but are
 * reported separately via `draftColumnsAfter` so the upgrade audit keeps
 * ratified and draft provenance apart.
 */
export function columnsAddedAfter(version: FocusVersion): string[] {
  return FOCUS_VERSIONS.filter(
    (v) =>
      focusVersionRank(v) > focusVersionRank(version) &&
      focusVersionRank(v) <= focusVersionRank(CANONICAL_FOCUS_VERSION),
  ).flatMap((v) => [...COLUMNS_BY_VERSION[v]]);
}

/**
 * Working-draft columns introduced strictly after `version` — the 1.5 families
 * the shim backfills onto every canonical row while 1.5 is unratified.
 */
export function draftColumnsAfter(version: FocusVersion): string[] {
  return DRAFT_FOCUS_VERSIONS.filter((v) => focusVersionRank(v) > focusVersionRank(version)).flatMap(
    (v) => [...COLUMNS_BY_VERSION[v]],
  );
}


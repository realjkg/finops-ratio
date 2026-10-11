// The FinIO A2A wire schema: which FOCUS columns a row carries at each negotiated
// version. FROZEN to the grouping the exchange has always sent (a public
// contract). It deliberately differs from COLUMNS_BY_VERSION, which follows the
// FOCUS spec column history for normalization; aligning the wire to it is a
// separate, tested contract change.
import { COLUMNS_BY_VERSION, FOCUS_VERSIONS, isAtLeast, type FocusVersion } from '@/costsource/focusVersions';

export const FINIO_WIRE_COLUMNS_BY_VERSION: Readonly<Record<FocusVersion, readonly string[]>> = {
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
  '1.5': COLUMNS_BY_VERSION['1.5'], // working-draft families: same on the wire
};

/** Every FOCUS column a FinIO row carries at `version`. */
export function finioWireColumns(version: FocusVersion): string[] {
  return FOCUS_VERSIONS.filter((v) => isAtLeast(version, v)).flatMap((v) => [...FINIO_WIRE_COLUMNS_BY_VERSION[v]]);
}

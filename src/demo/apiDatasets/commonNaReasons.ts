// Why a conditional FOCUS column is legitimately empty in every synthetic dataset (N/A, not 0).

/** Reasons that hold for every dataset (conditional FOCUS columns that are legitimately empty). */
export const COMMON_NA_REASONS: Record<string, string> = {
  ChargeClass: 'Not applicable: the line is not a correction',
  CommitmentDiscountCategory: 'Not applicable: the line is not covered by a commitment',
  CommitmentDiscountId: 'Not applicable: the line is not covered by a commitment',
  CommitmentDiscountName: 'Not applicable: the line is not covered by a commitment',
  CommitmentDiscountStatus: 'Not applicable: the line is not covered by a commitment',
  CommitmentDiscountType: 'Not applicable: the line is not covered by a commitment',
  AvailabilityZone: 'Not applicable: the line has no zone (purchase, credit, tax or adjustment)',
  ConsumedQuantity: 'Not applicable: nothing was consumed on this line',
  ConsumedUnit: 'Not applicable: nothing was consumed on this line',
  PricingQuantity: 'Not applicable: the line is not priced by quantity',
  PricingUnit: 'Not applicable: the line is not priced by quantity',
  ContractedUnitPrice: 'Not applicable: the line has no unit price',
  ListUnitPrice: 'Not applicable: the line has no unit price',
  RegionId: 'Not applicable: the line is not tied to a region',
  RegionName: 'Not applicable: the line is not tied to a region',
  ResourceId: 'Not applicable: the line is not tied to a resource',
  ResourceName: 'Not applicable: the line is not tied to a resource',
  ResourceType: 'Not applicable: the line is not tied to a resource',
  SkuId: 'Not applicable: the line has no SKU',
  SkuPriceId: 'Not applicable: the line has no SKU',
  SubAccountId: 'Not applicable: the line is billed at the account level',
  SubAccountName: 'Not applicable: the line is billed at the account level',
  Tags: 'Not applicable: no tags on this line',
  PricingCategory: 'Not applicable: the line is not priced by usage',
};

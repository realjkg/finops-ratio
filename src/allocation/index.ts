// Public API of the allocation module (RFQ readiness checklist, Step 3).
// Pure, deterministic, tenant-scoped, integer-money functions. See README.md.

export { AllocationError, isAllocationError, type AllocationErrorCode } from './errors';
export { LIMITS } from './limits';
export {
  currencyExponent,
  supportedCurrencies,
  parseDecimalToMinor,
  parseDecimalToMinorChecked,
  formatMinor,
  splitLargestRemainder,
  splitByKeys,
  type RoundingMode,
} from './money';
export { fromCanonicalRow, tryFromCanonicalRow, parseTagsStrict, type CanonicalRowInput, type FromCanonicalOptions } from './adapter';
export { type AllocatableRow } from './rows';
export { UNALLOCATED, UNMATCHED_RULE_ID, DIMENSIONS, type Dimension, type Target } from './targets';
export { compileRules, type CostRule, type Condition, type Matcher, type RuleAction } from './rules';
export { type SharedPool, type PoolPolicy } from './pools';
export {
  allocateCosts,
  type AllocationConfig,
  type AllocationLedger,
  type AllocationLine,
  type CurrencyTotals,
} from './allocate';
export { buildShowback, drillDown, type Showback, type ReportRow, type DrillDownQuery } from './reports';
export {
  createChargebackBook,
  recordAllocation,
  closePeriod,
  buildChargeback,
  drillDownChargeback,
  type ChargebackBook,
  type ChargebackStatement,
  type ChangeContext,
} from './chargeback';
export { evaluateTagPolicy, boundedEditDistance, type TagPolicy, type TagKeyRule, type TagComplianceReport } from './tagPolicy';
export { apportionKubernetesCost, K8S_UNITS, type K8sRequest, type K8sApportionment } from './kubernetes';

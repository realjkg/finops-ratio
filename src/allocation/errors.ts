// Error type for the allocation module (RFQ readiness checklist, Step 3).
//
// Trust boundary: every input to this module (rows, rules, pools, tag policies,
// Kubernetes metrics) is untrusted. Any malformed, oversized or cross-tenant
// input is refused with one of the FIXED messages below. The message is chosen
// by code only; it never contains the offending value, so a tag value, an
// amount string or a rule field can never leak through an error. An optional
// numeric `index` (a position computed by this module, not caller text) names
// the offending element of a batch.

export type AllocationErrorCode =
  // money and decimal parsing
  | 'INVALID_DECIMAL'
  | 'NEGATIVE_AMOUNT'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'PRECISION_EXCEEDED'
  | 'UNKNOWN_CURRENCY'
  | 'INVALID_WEIGHT'
  | 'ZERO_WEIGHT'
  | 'EMPTY_SPLIT'
  | 'TOO_MANY_PARTS'
  | 'DUPLICATE_KEY'
  | 'PERCENT_SUM_INVALID'
  // generic text and timestamps
  | 'INVALID_TEXT'
  | 'INVALID_TIMESTAMP'
  // rows
  | 'INVALID_ROW'
  | 'INVALID_TAGS'
  | 'TAGS_TOO_LARGE'
  | 'TOO_MANY_ROWS'
  | 'DUPLICATE_ROW_ID'
  | 'INVALID_TENANT'
  | 'TENANT_MISMATCH'
  | 'INVALID_CONFIG'
  // rules and pools
  | 'TOO_MANY_RULES'
  | 'TOO_MANY_CONDITIONS'
  | 'TOO_MANY_VALUES'
  | 'INVALID_RULE'
  | 'REGEX_NOT_ALLOWED'
  | 'DUPLICATE_RULE_ID'
  | 'DUPLICATE_PRECEDENCE'
  | 'RESERVED_ID'
  | 'INVALID_TARGET'
  | 'TOO_MANY_POOLS'
  | 'INVALID_POOL'
  | 'DUPLICATE_POOL_ID'
  | 'UNKNOWN_POOL'
  // reports and chargeback
  | 'INVALID_REPORT_REQUEST'
  | 'INVALID_ACTOR'
  | 'PERIOD_NOT_FOUND'
  | 'PERIOD_ALREADY_CLOSED'
  | 'NO_OPEN_PERIOD'
  | 'AUDIT_LOG_FULL'
  | 'TOO_MANY_PERIODS'
  // tag policy
  | 'INVALID_POLICY'
  | 'TOO_MANY_POLICY_ENTRIES'
  // Kubernetes
  | 'INVALID_K8S_REQUEST'
  | 'MIXED_UNITS'
  | 'MIXED_CURRENCY'
  | 'NON_POSITIVE_TOTAL'
  | 'ZERO_CAPACITY'
  | 'CAPACITY_EXCEEDED'
  | 'UNKNOWN_GROUP'
  | 'TOO_MANY_ITEMS'
  // internal defense in depth
  | 'RECONCILIATION_FAILED';

const MESSAGES: Readonly<Record<AllocationErrorCode, string>> = {
  INVALID_DECIMAL: 'amount is not a strict decimal number',
  NEGATIVE_AMOUNT: 'a negative amount is not allowed here',
  AMOUNT_OUT_OF_RANGE: 'amount is out of the supported range',
  PRECISION_EXCEEDED: 'amount has more fractional digits than the currency allows',
  UNKNOWN_CURRENCY: 'currency is not a supported ISO 4217 code',
  INVALID_WEIGHT: 'a split weight is not a non-negative integer',
  ZERO_WEIGHT: 'split weights sum to zero',
  EMPTY_SPLIT: 'a split needs at least one target',
  TOO_MANY_PARTS: 'a split has more targets than the cap allows',
  DUPLICATE_KEY: 'a split target appears more than once',
  PERCENT_SUM_INVALID: 'fixed percentages must sum to exactly 100',
  INVALID_TEXT: 'a text field is empty, too long, or contains control characters',
  INVALID_TIMESTAMP: 'timestamp is not a valid UTC date-time',
  INVALID_ROW: 'a row is malformed',
  INVALID_TAGS: 'tags are malformed',
  TAGS_TOO_LARGE: 'tags exceed the size or count cap',
  TOO_MANY_ROWS: 'row count exceeds the cap',
  DUPLICATE_ROW_ID: 'row ids must be unique',
  INVALID_TENANT: 'tenant is missing or malformed',
  TENANT_MISMATCH: 'a row belongs to a different tenant',
  INVALID_CONFIG: 'allocation configuration is malformed',
  TOO_MANY_RULES: 'rule count exceeds the cap',
  TOO_MANY_CONDITIONS: 'a rule has more conditions than the cap allows',
  TOO_MANY_VALUES: 'a list has more values than the cap allows',
  INVALID_RULE: 'a rule is malformed',
  REGEX_NOT_ALLOWED: 'pattern matching is not supported; use equals, prefix or oneOf',
  DUPLICATE_RULE_ID: 'rule and pool ids must be unique',
  DUPLICATE_PRECEDENCE: 'rule precedence values must be unique',
  RESERVED_ID: 'an id uses a reserved name',
  INVALID_TARGET: 'a target is malformed',
  TOO_MANY_POOLS: 'pool count exceeds the cap',
  INVALID_POOL: 'a shared pool is malformed',
  DUPLICATE_POOL_ID: 'pool ids must be unique',
  UNKNOWN_POOL: 'a rule refers to a pool that is not defined',
  INVALID_REPORT_REQUEST: 'report request is malformed',
  INVALID_ACTOR: 'acting subject is missing or malformed',
  PERIOD_NOT_FOUND: 'period does not exist',
  PERIOD_ALREADY_CLOSED: 'period is already closed',
  NO_OPEN_PERIOD: 'no open period is available for the adjustment',
  AUDIT_LOG_FULL: 'audit log reached its cap',
  TOO_MANY_PERIODS: 'period count exceeds the cap',
  INVALID_POLICY: 'tag policy is malformed',
  TOO_MANY_POLICY_ENTRIES: 'tag policy exceeds an entry cap',
  INVALID_K8S_REQUEST: 'Kubernetes request is malformed',
  MIXED_UNITS: 'quantities must all use the declared units',
  MIXED_CURRENCY: 'all costs in one apportionment must share one currency',
  NON_POSITIVE_TOTAL: 'total node cost must be greater than zero',
  ZERO_CAPACITY: 'cluster capacity must be greater than zero',
  CAPACITY_EXCEEDED: 'reserved capacity exceeds node capacity',
  UNKNOWN_GROUP: 'a policy names a group that has no workloads',
  TOO_MANY_ITEMS: 'an input list exceeds its cap',
  RECONCILIATION_FAILED: 'internal reconciliation check failed',
};

export class AllocationError extends Error {
  readonly code: AllocationErrorCode;
  /** Position of the offending element in its input list, when known. A number computed here, never caller text. */
  readonly index: number | undefined;

  constructor(code: AllocationErrorCode, index?: number) {
    super(MESSAGES[code]);
    this.name = 'AllocationError';
    this.code = code;
    this.index = index;
  }
}

export function isAllocationError(e: unknown, code?: AllocationErrorCode): e is AllocationError {
  return e instanceof AllocationError && (code === undefined || e.code === code);
}

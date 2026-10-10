// Pure FOCUS header/row validation and mapping onto cost_facts. Money and
// quantities stay strings. Error messages name the column and the rule and
// NEVER include the offending cell value (row contents must not leak into
// logs, run errors or quarantine reports).
import { isDecimalString } from './decimal';
import { parseFocusTimestamp } from './timestamp';

export const REQUIRED_COLUMNS = ['BilledCost', 'BillingCurrency', 'ChargePeriodStart', 'ChargePeriodEnd', 'BillingPeriodStart'] as const;

/** FOCUS columns mapped onto dedicated cost_facts columns (everything else → extra_columns). */
const MAPPED = new Set<string>([
  ...REQUIRED_COLUMNS,
  'EffectiveCost',
  'ListCost',
  'ContractedCost',
  'ProviderName',
  'ServiceName',
  'ServiceCategory',
  'ChargeCategory',
  'ResourceId',
  'SubAccountId',
  'BillingAccountId',
  'ConsumedQuantity',
  'ConsumedUnit',
  'UsageQuantity',
  'UsageUnit',
  'PricingQuantity',
  'PricingUnit',
  // D1 org-attribution vendor extensions (FOCUS spec allows additional
  // columns; these are promoted out of extra_columns onto dedicated
  // cost_facts columns). Spellings mirror src/costsource/focusRows.ts
  // (RatioAttributionExtensions) - the ingest worker does not import that
  // module.
  'x_RatioProjectId',
  'x_RatioBusinessUnit',
  'x_RatioCostCenter',
  'x_RatioOwner',
  'x_RatioRegion',
  'x_RatioEnvironment',
  'x_RatioDirectOrShared',
]);

const OPTIONAL_NUMERIC = ['EffectiveCost', 'ListCost', 'ContractedCost', 'ConsumedQuantity', 'UsageQuantity', 'PricingQuantity'] as const;

/** Values constrained by cost_facts CHECK constraints (migration 0002). */
const ENVIRONMENTS = new Set(['prod', 'staging', 'dev', 'sandbox']);
const DIRECT_OR_SHARED = new Set(['direct', 'shared']);

export interface FieldError {
  column: string | null;
  code: string;
  message: string;
}

export interface HeaderIndex {
  columns: string[];
  pos: Map<string, number>;
}

export interface FactRow {
  chargePeriodStart: string;
  chargePeriodEnd: string;
  billedCost: string;
  effectiveCost: string | null;
  listCost: string | null;
  contractedCost: string | null;
  billingCurrency: string;
  providerName: string | null;
  serviceName: string | null;
  serviceCategory: string | null;
  chargeCategory: string | null;
  resourceId: string | null;
  subAccountId: string | null;
  billingAccountId: string | null;
  usageQuantity: string | null;
  usageUnit: string | null;
  pricingQuantity: string | null;
  pricingUnit: string | null;
  // D1 org attribution (nullable: absence stays unattributed, never imputed)
  projectId: string | null;
  businessUnit: string | null;
  costCenter: string | null;
  owner: string | null;
  region: string | null;
  environment: string | null;
  directOrShared: string | null;
  extraColumns: Record<string, string>;
}

const MAX_COLUMN_NAME = 256;

/** C1 controls and U+2028/U+2029 are refused in header names: they become JSON keys in extra_columns. */
function hasHeaderOnlyForbidden(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if ((c >= 0x80 && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** True when the text contains a C0 control character other than TAB, LF or CR (incl. NUL, which Postgres text/jsonb reject). */
export function hasForbiddenControl(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
  }
  return false;
}

export function indexHeader(header: string[]): { ok: true; index: HeaderIndex } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const pos = new Map<string, number>();
  header.forEach((raw, i) => {
    const name = raw;
    if (hasForbiddenControl(name) || hasHeaderOnlyForbidden(name)) {
      errors.push({ column: null, code: 'INVALID_CHARACTER', message: `header column ${i + 1} contains a control character` });
      return;
    }
    if (name.length === 0 || name.length > MAX_COLUMN_NAME) {
      errors.push({ column: null, code: 'INVALID_COLUMN_NAME', message: `header column ${i + 1} has an empty or over-long name` });
      return;
    }
    if (pos.has(name)) {
      errors.push({ column: name.slice(0, MAX_COLUMN_NAME), code: 'DUPLICATE_COLUMN', message: 'column appears more than once in the header' });
      return;
    }
    pos.set(name, i);
  });
  for (const col of REQUIRED_COLUMNS) {
    if (!pos.has(col)) errors.push({ column: col, code: 'MISSING_REQUIRED_COLUMN', message: 'required FOCUS column is missing from the header' });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, index: { columns: header, pos } };
}

function cell(values: string[], index: HeaderIndex, col: string): string | null {
  const i = index.pos.get(col);
  if (i === undefined) return null;
  return values[i];
}

function optText(values: string[], index: HeaderIndex, col: string): string | null {
  const v = cell(values, index, col);
  return v === null || v === '' ? null : v;
}

/** Validates one data row of `billingPeriod` ('YYYY-MM-01'). */
export function validateRow(
  values: string[],
  index: HeaderIndex,
  billingPeriod: string,
): { ok: true; fact: FactRow } | { ok: false; errors: FieldError[] } {
  if (values.length !== index.columns.length) {
    return { ok: false, errors: [{ column: null, code: 'COLUMN_COUNT_MISMATCH', message: `row has ${values.length} cells, header has ${index.columns.length}` }] };
  }
  const errors: FieldError[] = [];
  index.columns.forEach((col, i) => {
    if (hasForbiddenControl(values[i])) errors.push({ column: col, code: 'INVALID_CHARACTER', message: 'value contains a control character (only TAB, CR and LF are allowed)' });
  });

  const billed = cell(values, index, 'BilledCost')!;
  if (billed === '') errors.push({ column: 'BilledCost', code: 'MISSING_VALUE', message: 'required value is empty' });
  else if (!isDecimalString(billed)) errors.push({ column: 'BilledCost', code: 'UNPARSEABLE_NUMBER', message: 'value is not a finite decimal number' });

  const numeric: Record<string, string | null> = {};
  for (const col of OPTIONAL_NUMERIC) {
    const v = optText(values, index, col);
    if (v !== null && !isDecimalString(v)) errors.push({ column: col, code: 'UNPARSEABLE_NUMBER', message: 'value is not a finite decimal number' });
    numeric[col] = v;
  }

  const currency = cell(values, index, 'BillingCurrency')!;
  if (currency === '') errors.push({ column: 'BillingCurrency', code: 'MISSING_VALUE', message: 'required value is empty' });
  else if (!/^[A-Z]{3}$/.test(currency)) errors.push({ column: 'BillingCurrency', code: 'INVALID_CURRENCY', message: 'value must be a three-letter ISO 4217 code in capitals' });

  const ts: Record<string, ReturnType<typeof parseFocusTimestamp>> = {};
  for (const col of ['ChargePeriodStart', 'ChargePeriodEnd', 'BillingPeriodStart'] as const) {
    const v = cell(values, index, col)!;
    if (v === '') {
      errors.push({ column: col, code: 'MISSING_VALUE', message: 'required value is empty' });
      ts[col] = null;
      continue;
    }
    ts[col] = parseFocusTimestamp(v);
    if (!ts[col]) errors.push({ column: col, code: 'UNPARSEABLE_TIMESTAMP', message: 'value is not a valid ISO 8601 date-time' });
  }
  const periodStartMs = Date.UTC(Number(billingPeriod.slice(0, 4)), Number(billingPeriod.slice(5, 7)) - 1, 1);
  if (ts.BillingPeriodStart && ts.BillingPeriodStart.epochMs !== periodStartMs) {
    errors.push({ column: 'BillingPeriodStart', code: 'PERIOD_MISMATCH', message: `row does not belong to billing period ${billingPeriod}` });
  }
  // Compared at the precision Postgres stores (µs), exactly as cost_facts_charge_period
  // CHECK (charge_period_end >= charge_period_start) will (PR #69 review): never at ms.
  if (ts.ChargePeriodStart && ts.ChargePeriodEnd && ts.ChargePeriodEnd.epochUs < ts.ChargePeriodStart.epochUs) {
    errors.push({ column: 'ChargePeriodEnd', code: 'CHARGE_PERIOD_INVERTED', message: 'ChargePeriodEnd is before ChargePeriodStart' });
  }
  for (const [col, allowed] of [
    ['x_RatioEnvironment', ENVIRONMENTS],
    ['x_RatioDirectOrShared', DIRECT_OR_SHARED],
  ] as const) {
    const v = optText(values, index, col);
    if (v !== null && !allowed.has(v)) errors.push({ column: col, code: 'INVALID_VALUE', message: 'value is not one of the allowed values' });
  }
  if (errors.length) return { ok: false, errors };

  // Null prototype: a column named __proto__ (or constructor/prototype) is an
  // ordinary own key here, never the prototype setter (review M2, fifth round).
  const extraColumns: Record<string, string> = Object.create(null) as Record<string, string>;
  index.columns.forEach((col, i) => {
    if (!MAPPED.has(col) && values[i] !== '') extraColumns[col] = values[i];
  });
  const consumed = numeric.ConsumedQuantity ?? numeric.UsageQuantity;
  return {
    ok: true,
    fact: {
      chargePeriodStart: ts.ChargePeriodStart!.iso,
      chargePeriodEnd: ts.ChargePeriodEnd!.iso,
      billedCost: billed,
      effectiveCost: numeric.EffectiveCost,
      listCost: numeric.ListCost,
      contractedCost: numeric.ContractedCost,
      billingCurrency: currency,
      providerName: optText(values, index, 'ProviderName'),
      serviceName: optText(values, index, 'ServiceName'),
      serviceCategory: optText(values, index, 'ServiceCategory'),
      chargeCategory: optText(values, index, 'ChargeCategory'),
      resourceId: optText(values, index, 'ResourceId'),
      subAccountId: optText(values, index, 'SubAccountId'),
      billingAccountId: optText(values, index, 'BillingAccountId'),
      usageQuantity: consumed,
      usageUnit: optText(values, index, 'ConsumedUnit') ?? optText(values, index, 'UsageUnit'),
      pricingQuantity: numeric.PricingQuantity,
      pricingUnit: optText(values, index, 'PricingUnit'),
      projectId: optText(values, index, 'x_RatioProjectId'),
      businessUnit: optText(values, index, 'x_RatioBusinessUnit'),
      costCenter: optText(values, index, 'x_RatioCostCenter'),
      owner: optText(values, index, 'x_RatioOwner'),
      region: optText(values, index, 'x_RatioRegion'),
      environment: optText(values, index, 'x_RatioEnvironment'),
      directOrShared: optText(values, index, 'x_RatioDirectOrShared'),
      extraColumns,
    },
  };
}

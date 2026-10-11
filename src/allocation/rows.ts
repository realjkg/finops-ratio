// The allocatable row: the one input shape the whole allocation module reads.
//
// Trust boundary: a row may come from an ingest adapter, a file or a test, so
// every field is re-validated here at runtime even though TypeScript types the
// shape. Strings are length-capped and free of control characters; the amount
// is a strict decimal parsed into integer minor units (BigInt) for the row's
// currency; the period start is a strict UTC timestamp; tags are copied into a
// frozen, null-prototype object, so a tag named `__proto__`, `constructor` or
// `prototype` is an inert own key and can never reach Object.prototype.
// Unknown extra fields on a row are ignored. Errors are fixed text and never
// echo a field value.

import { AllocationError } from './errors';
import { LIMITS, checkText, isPlainObject, own } from './limits';
import { EXACT_EXTRA, EXACT_UNIT, ZERO, currencyExponent, divRoundHalfEven, parseDecimalScaled, parseDecimalToMinorChecked, pow10, type RoundingMode } from './money';
import { parseStrictUtc } from './time';

export interface AllocatableRow {
  /** Unique within one call. Drill-down and audit refer to it. */
  id: string;
  tenant: string;
  /** ISO 4217 code, uppercase. */
  currency: string;
  /** Strict decimal text, e.g. "12.34"; negative for credits. */
  amount: string;
  /** Strict UTC timestamp, e.g. "2026-03-01T00:00:00Z". */
  periodStart: string;
  account: string;
  service: string;
  region?: string;
  resourceId?: string;
  tags: Record<string, string>;
}

/** A validated row: money in minor units, time normalized, tags frozen in a null-prototype object. */
export interface NormalizedRow {
  readonly id: string;
  readonly tenant: string;
  readonly currency: string;
  readonly minor: bigint;
  /** The exact amount scaled by 10^(exponent + EXACT_EXTRA). Equals `minor` * 10^EXACT_EXTRA unless the row has sub-minor digits. */
  readonly exact: bigint;
  /** True when the amount had digits beyond the currency's minor unit and was rounded (half-even mode only). */
  readonly rounded: boolean;
  /** True when digits beyond the exact scale were rounded half-even (exact mode only). */
  readonly beyondExactScale: boolean;
  readonly periodStart: string;
  /** `YYYY-MM` of `periodStart`, UTC. */
  readonly month: string;
  readonly account: string;
  readonly service: string;
  readonly region: string | null;
  readonly resourceId: string | null;
  readonly tags: Readonly<Record<string, string>>;
}

/** Validates a tags value and returns a frozen null-prototype copy. Values must be strings; keys are own enumerable data properties. */
export function normalizeTags(value: unknown, index?: number): Readonly<Record<string, string>> {
  if (!isPlainObject(value)) throw new AllocationError('INVALID_TAGS', index);
  const keys = Object.keys(value);
  if (keys.length > LIMITS.maxTagsPerRow) throw new AllocationError('TAGS_TOO_LARGE', index);
  const out = Object.create(null) as Record<string, string>;
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !('value' in desc)) throw new AllocationError('INVALID_TAGS', index); // accessors are refused
    checkText(key, LIMITS.maxTagKeyLength, 'INVALID_TAGS', { requireTrimmed: false }, index);
    const v: unknown = desc.value;
    if (typeof v !== 'string') throw new AllocationError('INVALID_TAGS', index);
    checkText(v, LIMITS.maxTagValueLength, 'INVALID_TAGS', { allowEmpty: true, requireTrimmed: false }, index);
    Object.defineProperty(out, key, { value: v, enumerable: true, writable: false, configurable: false });
  }
  return Object.freeze(out);
}

function optionalText(raw: unknown, max: number, index: number | undefined): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  return checkText(raw, max, 'INVALID_ROW', {}, index);
}

/** Validates one untrusted row. `index` is its position in the batch, attached to any error. */
export type RowPrecision = RoundingMode | 'exact';

export function normalizeRow(row: unknown, rounding: RowPrecision = 'refuse', index?: number): NormalizedRow {
  if (!isPlainObject(row)) throw new AllocationError('INVALID_ROW', index);
  const id = checkText(own(row, 'id'), LIMITS.maxIdLength, 'INVALID_ROW', {}, index);
  const tenant = checkText(own(row, 'tenant'), LIMITS.maxTenantLength, 'INVALID_ROW', {}, index);
  const currency = own(row, 'currency');
  const amount = own(row, 'amount');
  let parsed: { minor: bigint; rounded: boolean };
  let exact: bigint;
  let beyond = false;
  try {
    if (rounding === 'exact') {
      // Carry sub-minor digits (up to EXACT_EXTRA of them) so nothing vanishes; rounding happens once, at output.
      const exp = currencyExponent(currency);
      const p = parseDecimalScaled(amount, exp + EXACT_EXTRA, 'half-even');
      exact = p.value;
      beyond = p.rounded;
      const unit = pow10(EXACT_EXTRA);
      parsed = { minor: divRoundHalfEven(p.value, unit), rounded: p.rounded || p.value % unit !== ZERO };
    } else {
      parsed = parseDecimalToMinorChecked(amount, currency, rounding);
      exact = parsed.minor * EXACT_UNIT;
    }
  } catch (e) {
    if (e instanceof AllocationError) throw new AllocationError(e.code, index);
    throw e;
  }
  let when;
  try {
    when = parseStrictUtc(own(row, 'periodStart'));
  } catch (e) {
    if (e instanceof AllocationError) throw new AllocationError(e.code, index);
    throw e;
  }
  const account = checkText(own(row, 'account'), LIMITS.maxAccountLength, 'INVALID_ROW', { allowEmpty: true }, index);
  const service = checkText(own(row, 'service'), LIMITS.maxServiceLength, 'INVALID_ROW', { allowEmpty: true }, index);
  const region = optionalText(own(row, 'region'), LIMITS.maxRegionLength, index);
  const resourceId = optionalText(own(row, 'resourceId'), LIMITS.maxResourceIdLength, index);
  const tags = normalizeTags(own(row, 'tags'), index);
  return Object.freeze({
    id,
    tenant,
    currency: currency as string, // validated by parseDecimalToMinorChecked above
    minor: parsed.minor,
    exact,
    beyondExactScale: beyond,
    rounded: parsed.rounded,
    periodStart: when.iso,
    month: when.month,
    account,
    service,
    region,
    resourceId,
    tags,
  });
}

/** Validates a tenant argument (the caller's authenticated tenant). */
export function checkTenant(tenant: unknown): string {
  return checkText(tenant, LIMITS.maxTenantLength, 'INVALID_TENANT');
}

/**
 * Validates a batch: row cap first (before any per-row work), then each row,
 * then tenant scope and id uniqueness. Any failure refuses the whole batch.
 */
export function normalizeRows(
  tenant: string,
  rows: unknown,
  rounding: RowPrecision = 'refuse',
): NormalizedRow[] {
  if (!Array.isArray(rows)) throw new AllocationError('INVALID_ROW');
  if (rows.length > LIMITS.maxRows) throw new AllocationError('TOO_MANY_ROWS');
  const out: NormalizedRow[] = new Array<NormalizedRow>(rows.length);
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const n = normalizeRow(rows[i], rounding, i);
    if (n.tenant !== tenant) throw new AllocationError('TENANT_MISMATCH', i);
    if (seen.has(n.id)) throw new AllocationError('DUPLICATE_ROW_ID', i);
    seen.add(n.id);
    out[i] = n;
  }
  return out;
}

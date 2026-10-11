// Adapter from the repo's canonical FOCUS row to an AllocatableRow.
//
// Trust boundary: a canonical row is already normalized by the cost-ingest
// seam (src/costsource/focusRows.ts), but its optional columns (Tags, region)
// are not typed there and arrive as free text from an exporter. The adapter
// therefore parses them strictly: Tags may be a JSON string or an object (on
// the row itself or in `extraColumns`), is capped in size and count, must be a
// flat object of string values, and is never merged into any prototype.
// Currency must be a supported ISO 4217 code; the amount must be a strict
// decimal. Anything else throws a fixed-text AllocationError.
//
// Column mapping follows the FOCUS ingest table in .obvious/obvious.md:
//   BillingAccountId -> tenant (override with opts.tenant when the caller's
//   authenticated tenant is not the billing account), SubAccountId -> account,
//   ServiceName -> service, ResourceId -> resourceId, BillingCurrency ->
//   currency, ChargePeriodStart -> periodStart (normalized to UTC),
//   BilledCost (default) or EffectiveCost -> amount.
// `BilledCost` is a JS number on the canonical type. A float with binary noise
// (0.1 + 0.2) has more digits than any currency allows; allocate such data with
// rounding 'half-even' and read `roundedRows` in the totals.
//
// Type-only import: this module has no runtime dependency on the cost-ingest seam.

import type { CanonicalFocusRow } from '@/costsource/focusRows';
import { AllocationError } from './errors';
import { LIMITS, isPlainObject, own } from './limits';
import { currencyExponent, parseDecimalScaled } from './money';
import { normalizeTags, type AllocatableRow } from './rows';
import { parseFocusTimestamp } from './time';

/** The canonical columns the adapter reads, plus the untyped optional columns it knows how to find. */
export type CanonicalRowInput = Pick<
  CanonicalFocusRow,
  'BilledCost' | 'EffectiveCost' | 'BillingCurrency' | 'ChargePeriodStart' | 'BillingAccountId' | 'SubAccountId' | 'ServiceName' | 'ResourceId'
> & {
  /** FOCUS `Tags`: a JSON object as text, or an already parsed object. */
  Tags?: unknown;
  /** Ratio region extension (preferred over `RegionId` in extra columns). */
  x_RatioRegion?: string | null;
  /** Unmapped columns kept by the ingest worker (cost_facts.extra_columns). */
  extraColumns?: Readonly<Record<string, unknown>> | null;
};

export interface FromCanonicalOptions {
  /** Row id. Required: canonical rows carry no stable identity of their own. */
  id: string;
  /** Overrides the tenant (default: BillingAccountId). */
  tenant?: string;
  /** Which cost column becomes the amount (default: BilledCost). */
  costBasis?: 'BilledCost' | 'EffectiveCost';
}

/** Converts a JS number to plain decimal text without an exponent. Refuses NaN, Infinity and magnitudes outside 1e-20..1e21. */
export function numberToDecimalString(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new AllocationError('INVALID_DECIMAL');
  let s = String(n);
  if (s.includes('e') || s.includes('E')) {
    if (Math.abs(n) >= 1e21) throw new AllocationError('AMOUNT_OUT_OF_RANGE');
    s = n.toFixed(20);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (s === '0' || s === '-0') throw new AllocationError('AMOUNT_OUT_OF_RANGE'); // underflow: not a real cost
  }
  return s;
}

/**
 * Strict Tags parser. Accepts a JSON object as text (capped at
 * LIMITS.maxTagsJsonLength characters) or a plain object. Rejects arrays,
 * nested values, non-string values, accessor properties and oversized input.
 * Returns a frozen null-prototype object.
 */
export function parseTagsStrict(input: unknown): Readonly<Record<string, string>> {
  if (input === undefined || input === null) return normalizeTags({});
  if (typeof input === 'string') {
    if (input.length > LIMITS.maxTagsJsonLength) throw new AllocationError('TAGS_TOO_LARGE');
    if (input.trim() === '') return normalizeTags({});
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new AllocationError('INVALID_TAGS');
    }
    return normalizeTags(parsed);
  }
  return normalizeTags(input);
}

function costOf(row: CanonicalRowInput, basis: 'BilledCost' | 'EffectiveCost'): string {
  const v: unknown = basis === 'EffectiveCost' ? row.EffectiveCost : row.BilledCost;
  if (typeof v === 'number') return numberToDecimalString(v);
  if (typeof v === 'string') return v;
  throw new AllocationError('INVALID_DECIMAL');
}

function textOrUndefined(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new AllocationError('INVALID_ROW');
  return v;
}

/**
 * Maps one canonical FOCUS row to an AllocatableRow. Throws a fixed-text
 * AllocationError for an unsupported currency, a malformed amount or timestamp,
 * or malformed Tags. Tags are read from `row.Tags` first, then from
 * `extraColumns.Tags`.
 */
export function fromCanonicalRow(row: CanonicalRowInput, opts: FromCanonicalOptions): AllocatableRow {
  if (!isPlainObject(row as unknown) || !isPlainObject(opts as unknown)) throw new AllocationError('INVALID_ROW');
  const r = row as unknown as Record<string, unknown>;
  const extra = r.extraColumns;
  if (extra !== undefined && extra !== null && !isPlainObject(extra)) throw new AllocationError('INVALID_ROW');
  const extraObj = (extra ?? undefined) as Record<string, unknown> | undefined;

  const currency = row.BillingCurrency;
  currencyExponent(currency); // refuse unsupported currencies here, not later
  const amount = costOf(row, opts.costBasis ?? 'BilledCost');
  parseDecimalScaled(amount, currencyExponent(currency), 'half-even'); // grammar check only; rounding is decided at allocation
  const when = parseFocusTimestamp(row.ChargePeriodStart);

  const rawTags = r.Tags !== undefined && r.Tags !== null ? r.Tags : extraObj ? own(extraObj, 'Tags') : undefined;
  const tags = parseTagsStrict(rawTags);
  const region = textOrUndefined(r.x_RatioRegion) ?? (extraObj ? textOrUndefined(own(extraObj, 'RegionId')) : undefined);
  const resourceId = textOrUndefined(row.ResourceId);

  const out: AllocatableRow = {
    id: opts.id,
    tenant: opts.tenant ?? row.BillingAccountId,
    currency,
    amount,
    periodStart: when.iso,
    account: row.SubAccountId ?? '',
    service: row.ServiceName ?? '',
    tags: { ...tags },
  };
  if (region !== undefined) out.region = region;
  if (resourceId !== undefined) out.resourceId = resourceId;
  return out;
}

export type TryFromCanonicalResult = { ok: true; row: AllocatableRow } | { ok: false; code: AllocationError['code'] };

/** Non-throwing variant for quarantining bad rows one at a time. The failure carries only the fixed error code. */
export function tryFromCanonicalRow(row: CanonicalRowInput, opts: FromCanonicalOptions): TryFromCanonicalResult {
  try {
    return { ok: true, row: fromCanonicalRow(row, opts) };
  } catch (e) {
    if (e instanceof AllocationError) return { ok: false, code: e.code };
    throw e;
  }
}

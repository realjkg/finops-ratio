// buildDailySeries: aggregates canonical FOCUS cost rows into per-(tenant,
// currency, account, service, region) daily series.
//
// Trust boundary: `rows` are untrusted (they may be parsed JSON). Every row is
// validated before it can influence a total; any defect refuses the whole
// call with a fixed-text DetectionError (no partial results, no echo of input).
// The caller supplies the tenant; a row from another BillingAccountId is a
// cross-tenant read and is refused, not skipped.
//
// Documented rules:
//  - Cost field: the caller must choose BilledCost or EffectiveCost. The design
//    monitors EffectiveCost (amortized usage); BilledCost is offered for
//    invoice-shaped views. There is no default.
//  - Day bucket: the UTC day of ChargePeriodStart. A charge period longer than
//    24 hours is excluded and counted (design D-09: a multi-day row would
//    otherwise look like a one-day spike).
//  - Included rows: ChargeCategory in `includeCategories` (default ['Usage']).
//    Rows with a non-empty ChargeClass (corrections) are excluded. A Usage row
//    whose ChargeFrequency is present and is not 'Usage-Based' is excluded.
//  - Credits and refunds: a credit or refund recorded as Usage with a negative
//    amount is netted into the day's total on purpose (design 3.1), so a day
//    can be zero or negative. Rows in other categories (Credit, Tax,
//    Purchase, Adjustment) are excluded by default, so their negatives never
//    reach a series. `negativeAmounts: 'reject'` refuses any negative included
//    amount instead.
//  - Duplicates: rows that share a non-empty RowId are one charge. An exact
//    repeat is dropped and counted; a repeat with a different amount, day or
//    series is refused. Rows without a RowId are separate charges and are all
//    summed (FOCUS allows many rows per resource per day); upstream ingest owns
//    de-duplication of RowId-less rows.
//  - Rounding: each daily total is summed with compensation and rounded once to
//    6 decimal places (round6).
//  - Caps: rows, series count and series span are bounded (LIMITS); callers may
//    lower a cap, never raise it. A call over a cap is refused whole.

import { parseDay, parseInstant, formatDay } from './dates';
import { sum } from './stats';
import {
  DetectionError,
  LIMITS,
  compareStrings,
  isCurrency,
  isIdentifier,
  round6,
  seriesId,
  type CostField,
  type DailySeries,
  type SeriesKey,
} from './types';

/** The subset of a canonical FOCUS row this module reads. */
export interface CostRowInput {
  BilledCost: number;
  EffectiveCost: number;
  BillingCurrency: string;
  ChargePeriodStart: string;
  ChargePeriodEnd: string;
  BillingAccountId: string;
  SubAccountId: string;
  ServiceName: string;
  ChargeCategory: string;
  x_RatioRegion?: string | null;
  ChargeFrequency?: string | null;
  ChargeClass?: string | null;
  /** Optional ingest-assigned unique row id, used to drop exact duplicates. */
  RowId?: string | null;
}

export interface BuildSeriesOptions {
  /** The authenticated tenant (FOCUS BillingAccountId). Rows of any other tenant are refused. */
  readonly tenant: string;
  /** Explicit cost-field choice; there is no default. */
  readonly costField: CostField;
  readonly includeCategories?: readonly string[];
  readonly negativeAmounts?: 'net' | 'reject';
  /** Inclusive UTC day window; rows outside it are skipped and counted. */
  readonly fromDay?: string;
  readonly toDay?: string;
  /** May lower the row cap, never raise it. */
  readonly maxRows?: number;
  /** May lower the series cap, never raise it. */
  readonly maxSeries?: number;
}

export interface BuildSeriesStats {
  readonly rowsRead: number;
  readonly rowsAggregated: number;
  /** Excluded by category, correction class or non-usage-based frequency. */
  readonly rowsExcluded: number;
  /** Excluded because the charge period is longer than 24 hours. */
  readonly rowsMultiDay: number;
  readonly rowsOutOfWindow: number;
  readonly duplicatesDropped: number;
}

export interface BuildSeriesResult {
  readonly series: readonly DailySeries[];
  readonly stats: BuildSeriesStats;
}

const DEFAULT_CATEGORIES: readonly string[] = ['Usage'];
const MAX_SPAN_MS = 86_400_000;

function lowerCap(requested: number | undefined, hardCap: number): number {
  if (requested === undefined) return hardCap;
  if (!Number.isInteger(requested) || requested < 1) throw new DetectionError('OPTIONS_INVALID');
  return Math.min(requested, hardCap);
}

interface Cell {
  total: number;
  parts: number[];
}

interface Accumulator {
  readonly key: SeriesKey;
  readonly days: Map<number, Cell>;
}

interface SeenRow {
  readonly seriesKey: string;
  readonly day: number;
  readonly amount: number;
}

export function buildDailySeries(
  rows: readonly CostRowInput[],
  options: BuildSeriesOptions,
): BuildSeriesResult {
  if (options === null || typeof options !== 'object') throw new DetectionError('OPTIONS_INVALID');
  if (!isIdentifier(options.tenant)) throw new DetectionError('OPTIONS_INVALID');
  if (options.costField !== 'BilledCost' && options.costField !== 'EffectiveCost') {
    throw new DetectionError('OPTIONS_INVALID');
  }
  const negativeRule = options.negativeAmounts ?? 'net';
  if (negativeRule !== 'net' && negativeRule !== 'reject') throw new DetectionError('OPTIONS_INVALID');
  const categories = options.includeCategories ?? DEFAULT_CATEGORIES;
  if (!Array.isArray(categories) || categories.length === 0 || categories.length > 32) {
    throw new DetectionError('OPTIONS_INVALID');
  }
  for (const c of categories) {
    if (!isIdentifier(c)) throw new DetectionError('OPTIONS_INVALID');
  }
  const categorySet = new Set<string>(categories);
  const fromDn = options.fromDay === undefined ? -Infinity : parseDay(options.fromDay, 'OPTIONS_INVALID');
  const toDn = options.toDay === undefined ? Infinity : parseDay(options.toDay, 'OPTIONS_INVALID');
  if (fromDn > toDn) throw new DetectionError('OPTIONS_INVALID');
  const maxRows = lowerCap(options.maxRows, LIMITS.maxRows);
  const maxSeries = lowerCap(options.maxSeries, LIMITS.maxSeries);

  if (!Array.isArray(rows)) throw new DetectionError('ROW_MALFORMED');
  // The cap is checked before any row is touched.
  if (rows.length > maxRows) throw new DetectionError('ROW_CAP_EXCEEDED');

  const accumulators = new Map<string, Accumulator>();
  const seenRowIds = new Map<string, SeenRow>();
  let rowsAggregated = 0;
  let rowsExcluded = 0;
  let rowsMultiDay = 0;
  let rowsOutOfWindow = 0;
  let duplicatesDropped = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] as unknown;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new DetectionError('ROW_MALFORMED', i);
    }
    const r = row as Record<string, unknown>;

    // Shape and identifiers.
    if (!isIdentifier(r.BillingAccountId)) throw new DetectionError('IDENTIFIER_INVALID', i);
    if (r.BillingAccountId !== options.tenant) throw new DetectionError('CROSS_TENANT_ROW', i);
    if (!isIdentifier(r.SubAccountId)) throw new DetectionError('IDENTIFIER_INVALID', i);
    if (!isIdentifier(r.ServiceName)) throw new DetectionError('IDENTIFIER_INVALID', i);
    if (!isIdentifier(r.ChargeCategory)) throw new DetectionError('IDENTIFIER_INVALID', i);
    const region = r.x_RatioRegion === undefined || r.x_RatioRegion === null ? '' : r.x_RatioRegion;
    if (!isIdentifier(region, true)) throw new DetectionError('IDENTIFIER_INVALID', i);
    if (!isCurrency(r.BillingCurrency)) throw new DetectionError('CURRENCY_INVALID', i);
    const rowId = r.RowId === undefined || r.RowId === null ? '' : r.RowId;
    if (!isIdentifier(rowId, true)) throw new DetectionError('IDENTIFIER_INVALID', i);
    const chargeClass = r.ChargeClass === undefined || r.ChargeClass === null ? '' : r.ChargeClass;
    if (typeof chargeClass !== 'string' || chargeClass.length > LIMITS.maxIdentifierLength) {
      throw new DetectionError('ROW_MALFORMED', i);
    }
    const frequency = r.ChargeFrequency === undefined || r.ChargeFrequency === null ? '' : r.ChargeFrequency;
    if (typeof frequency !== 'string' || frequency.length > LIMITS.maxIdentifierLength) {
      throw new DetectionError('ROW_MALFORMED', i);
    }

    // Time.
    const start = parseInstant(r.ChargePeriodStart, i);
    const end = parseInstant(r.ChargePeriodEnd, i);
    if (end.epochMs <= start.epochMs) throw new DetectionError('TIMESTAMP_INVALID', i);

    // Amount (only the selected field is read).
    const amount = r[options.costField];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || Math.abs(amount) > LIMITS.maxAbsAmount) {
      throw new DetectionError('AMOUNT_INVALID', i);
    }

    // Inclusion rules, applied only after the row is known to be well formed.
    const included =
      categorySet.has(r.ChargeCategory as string) &&
      chargeClass === '' &&
      !(r.ChargeCategory === 'Usage' && frequency !== '' && frequency !== 'Usage-Based');
    if (!included) {
      rowsExcluded += 1;
      continue;
    }
    if (end.epochMs - start.epochMs > MAX_SPAN_MS) {
      rowsMultiDay += 1;
      continue;
    }
    if (start.dayNumber < fromDn || start.dayNumber > toDn) {
      rowsOutOfWindow += 1;
      continue;
    }
    if (amount < 0 && negativeRule === 'reject') throw new DetectionError('NEGATIVE_AMOUNT', i);

    const key: SeriesKey = {
      tenant: options.tenant,
      currency: r.BillingCurrency as string,
      account: r.SubAccountId as string,
      service: r.ServiceName as string,
      region: region as string,
    };
    const id = seriesId(key);

    if (rowId !== '') {
      const earlier = seenRowIds.get(rowId);
      if (earlier !== undefined) {
        if (earlier.seriesKey !== id || earlier.day !== start.dayNumber || earlier.amount !== amount) {
          throw new DetectionError('DUPLICATE_CONFLICT', i);
        }
        duplicatesDropped += 1;
        continue;
      }
      seenRowIds.set(rowId, { seriesKey: id, day: start.dayNumber, amount });
    }

    let acc = accumulators.get(id);
    if (acc === undefined) {
      if (accumulators.size >= maxSeries) throw new DetectionError('SERIES_CAP_EXCEEDED', i);
      acc = { key, days: new Map() };
      accumulators.set(id, acc);
    }
    let cell = acc.days.get(start.dayNumber);
    if (cell === undefined) {
      cell = { total: 0, parts: [] };
      acc.days.set(start.dayNumber, cell);
    }
    cell.parts.push(amount);
    rowsAggregated += 1;
  }

  const ids = Array.from(accumulators.keys()).sort(compareStrings);
  const series: DailySeries[] = [];
  for (const id of ids) {
    const acc = accumulators.get(id) as Accumulator;
    const dayNumbers = Array.from(acc.days.keys()).sort((a, b) => a - b);
    const first = dayNumbers[0] as number;
    const last = dayNumbers[dayNumbers.length - 1] as number;
    if (last - first + 1 > LIMITS.maxDaysPerSeries) throw new DetectionError('SERIES_TOO_LONG');
    series.push({
      id,
      key: acc.key,
      costField: options.costField,
      points: dayNumbers.map((dn) => ({
        day: formatDay(dn),
        value: round6(sum((acc.days.get(dn) as Cell).parts)),
      })),
    });
  }

  return {
    series,
    stats: {
      rowsRead: rows.length,
      rowsAggregated,
      rowsExcluded,
      rowsMultiDay,
      rowsOutOfWindow,
      duplicatesDropped,
    },
  };
}

/** A validated view of a series: day numbers and values, ascending. */
export interface SeriesView {
  readonly series: DailySeries;
  readonly dns: readonly number[];
  readonly values: readonly number[];
}

/**
 * Validates an untrusted DailySeries and returns day numbers. Checks the
 * identity fields, that `id` matches the key, strictly ascending unique valid
 * days, finite values in range, and the span cap. Throws SERIES_INVALID or
 * SERIES_TOO_LONG with the series' index only.
 */
export function viewSeries(series: DailySeries, index?: number): SeriesView {
  if (series === null || typeof series !== 'object') throw new DetectionError('SERIES_INVALID', index);
  const key = series.key as SeriesKey | undefined;
  if (key === undefined || key === null || typeof key !== 'object') {
    throw new DetectionError('SERIES_INVALID', index);
  }
  if (
    !isIdentifier(key.tenant) ||
    !isIdentifier(key.account) ||
    !isIdentifier(key.service) ||
    !isIdentifier(key.region, true) ||
    !isCurrency(key.currency)
  ) {
    throw new DetectionError('SERIES_INVALID', index);
  }
  if (series.id !== seriesId(key)) throw new DetectionError('SERIES_INVALID', index);
  if (series.costField !== 'BilledCost' && series.costField !== 'EffectiveCost') {
    throw new DetectionError('SERIES_INVALID', index);
  }
  const points = series.points;
  if (!Array.isArray(points)) throw new DetectionError('SERIES_INVALID', index);
  if (points.length > LIMITS.maxDaysPerSeries) throw new DetectionError('SERIES_TOO_LONG', index);
  const dns: number[] = [];
  const values: number[] = [];
  let previous = -Infinity;
  for (const p of points) {
    if (p === null || typeof p !== 'object') throw new DetectionError('SERIES_INVALID', index);
    const dn = parseDay(p.day, 'SERIES_INVALID', index);
    if (dn <= previous) throw new DetectionError('SERIES_INVALID', index);
    if (typeof p.value !== 'number' || !Number.isFinite(p.value) || Math.abs(p.value) > LIMITS.maxAbsAmount * 1000) {
      throw new DetectionError('SERIES_INVALID', index);
    }
    previous = dn;
    dns.push(dn);
    values.push(p.value);
  }
  if (dns.length > 0 && (dns[dns.length - 1] as number) - (dns[0] as number) + 1 > LIMITS.maxDaysPerSeries) {
    throw new DetectionError('SERIES_TOO_LONG', index);
  }
  return { series, dns, values };
}

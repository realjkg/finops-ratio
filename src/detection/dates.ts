// UTC-only calendar arithmetic for the detection module.
//
// Why this file exists: the existing daysInMonthOf in src/lib/forecast.ts once
// built the last day of a month with the local-time Date constructor (design
// finding F1), so its answer depended on the process time zone. Nothing here
// constructs or reads a local-time Date. Days are integers (days since
// 1970-01-01 UTC) and every conversion is integer arithmetic (the proleptic
// Gregorian "civil from days" algorithm), so a host TZ cannot influence a
// result and a DST transition cannot create a 23- or 25-hour day.
//
// Trust boundary: all inputs are strings or numbers from a caller. Parsers are
// strict (fixed shape, explicit UTC offset required) and throw DetectionError
// with fixed text; they never echo the input.

import { DetectionError, type DetectionErrorCode } from './types';

export const MS_PER_DAY = 86_400_000;
const MIN_YEAR = 2000;
const MAX_YEAR = 2200;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in `month` (1 to 12) of `year`. Pure arithmetic. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Days since 1970-01-01 for a proleptic Gregorian date (month 1 to 12). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12; // March = 0
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

export interface Civil {
  readonly year: number;
  readonly month: number; // 1 to 12
  readonly day: number; // 1 to 31
}

export function civilFromDays(dn: number): Civil {
  const z = dn + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? y + 1 : y, month, day };
}

/** Weekday of a day number: 0 = Sunday ... 6 = Saturday (1970-01-01 was a Thursday). */
export function weekdayOf(dn: number): number {
  return (((dn + 4) % 7) + 7) % 7;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function formatDay(dn: number): string {
  const c = civilFromDays(dn);
  return `${pad(c.year, 4)}-${pad(c.month, 2)}-${pad(c.day, 2)}`;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses `YYYY-MM-DD` into a day number. Throws `code` on any defect. */
export function parseDay(value: unknown, code: DetectionErrorCode = 'AS_OF_INVALID', index?: number): number {
  if (typeof value !== 'string') throw new DetectionError(code, index);
  const m = DAY_RE.exec(value);
  if (!m) throw new DetectionError(code, index);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < MIN_YEAR || year > MAX_YEAR) throw new DetectionError(code, index);
  if (month < 1 || month > 12) throw new DetectionError(code, index);
  if (day < 1 || day > daysInMonth(year, month)) throw new DetectionError(code, index);
  return daysFromCivil(year, month, day);
}

export function isDayString(value: unknown): value is string {
  try {
    parseDay(value);
    return true;
  } catch {
    return false;
  }
}

export interface ParsedInstant {
  /** UTC day number containing the instant. */
  readonly dayNumber: number;
  /** Milliseconds since the epoch (sub-millisecond digits are truncated). */
  readonly epochMs: number;
}

const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses an ISO 8601 instant that carries an explicit offset (`Z` or
 * `+hh:mm`). A timestamp with no offset is refused: engines parse it in local
 * time, which is exactly the class of bug design finding F1 recorded.
 */
export function parseInstant(value: unknown, index?: number): ParsedInstant {
  if (typeof value !== 'string' || value.length > 40) {
    throw new DetectionError('TIMESTAMP_INVALID', index);
  }
  const m = INSTANT_RE.exec(value);
  if (!m) throw new DetectionError('TIMESTAMP_INVALID', index);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (year < MIN_YEAR || year > MAX_YEAR) throw new DetectionError('TIMESTAMP_INVALID', index);
  if (month < 1 || month > 12) throw new DetectionError('TIMESTAMP_INVALID', index);
  if (day < 1 || day > daysInMonth(year, month)) throw new DetectionError('TIMESTAMP_INVALID', index);
  if (hour > 23 || minute > 59 || second > 59) throw new DetectionError('TIMESTAMP_INVALID', index);
  let offsetSeconds = 0;
  const zone = m[8] as string;
  if (zone !== 'Z') {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) throw new DetectionError('TIMESTAMP_INVALID', index);
    offsetSeconds = (oh * 3600 + om * 60) * (zone[0] === '-' ? -1 : 1);
  }
  const millis = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0;
  const localDay = daysFromCivil(year, month, day);
  const utcSeconds = localDay * 86_400 + hour * 3600 + minute * 60 + second - offsetSeconds;
  const dayNumber = Math.floor(utcSeconds / 86_400);
  return { dayNumber, epochMs: utcSeconds * 1000 + millis };
}

export function addDays(day: string, n: number): string {
  return formatDay(parseDay(day) + n);
}

/** `YYYY-MM` of a day number. */
export function monthKeyOf(dn: number): string {
  const c = civilFromDays(dn);
  return `${pad(c.year, 4)}-${pad(c.month, 2)}`;
}

/** Day number of the last day of the month containing `dn`. */
export function monthEndOf(dn: number): number {
  const c = civilFromDays(dn);
  return daysFromCivil(c.year, c.month, daysInMonth(c.year, c.month));
}

/** Day number of the first day of the month containing `dn`. */
export function monthStartOf(dn: number): number {
  const c = civilFromDays(dn);
  return daysFromCivil(c.year, c.month, 1);
}

/**
 * The last COMPLETE UTC day relative to an injected `now`: the UTC day before
 * the one containing `now`. This is the as-of day callers pass to the forecast
 * and detection functions. Reads only the instant's epoch value.
 */
export function lastCompleteDay(now: Date): string {
  const ms = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(ms)) throw new DetectionError('AS_OF_INVALID');
  const dn = Math.floor(ms / MS_PER_DAY) - 1;
  const day = formatDay(dn);
  parseDay(day); // range-check (year bounds)
  return day;
}

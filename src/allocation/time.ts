// UTC timestamp and month helpers for the allocation module.
//
// Trust boundary: timestamps arrive as untrusted strings. Two grammars exist.
// The STRICT grammar is what `AllocatableRow.periodStart` and injected clock
// values must use: `YYYY-MM-DDTHH:MM:SS[.fff]Z`, a real calendar date, year 1970
// to 9999. The FOCUS grammar (adapter input only) also accepts a bare date, a
// space for `T`, numeric offsets, and an offset-less value (FOCUS mandates UTC),
// and always normalizes to the strict form. Nothing here reads the system clock:
// time is injected by the caller, so every test is offline and deterministic.

import { AllocationError } from './errors';

export interface ParsedInstant {
  /** Normalized `YYYY-MM-DDTHH:MM:SS.mmmZ`. */
  iso: string;
  /** `YYYY-MM` in UTC. */
  month: string;
  epochMs: number;
}

const STRICT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const FOCUS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const NORMALIZED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function build(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  ms: number,
  offsetMinutes: number,
): ParsedInstant {
  if (y < 1970 || y > 9999 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) {
    throw new AllocationError('INVALID_TIMESTAMP');
  }
  if (d > daysInMonth(y, mo)) throw new AllocationError('INVALID_TIMESTAMP');
  const epochMs = Date.UTC(y, mo - 1, d, h, mi, s, ms) - offsetMinutes * 60_000;
  const iso = new Date(epochMs).toISOString();
  // A far-future offset can push the instant past year 9999, where toISOString changes shape.
  if (!NORMALIZED_RE.test(iso)) throw new AllocationError('INVALID_TIMESTAMP');
  return { iso, month: iso.slice(0, 7), epochMs };
}

/** Strict UTC timestamp: `YYYY-MM-DDTHH:MM:SS[.fff]Z`. */
export function parseStrictUtc(text: unknown): ParsedInstant {
  if (typeof text !== 'string' || text.length > 30) throw new AllocationError('INVALID_TIMESTAMP');
  const m = STRICT_RE.exec(text);
  if (!m) throw new AllocationError('INVALID_TIMESTAMP');
  const ms = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0;
  return build(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms, 0);
}

/** FOCUS timestamp (adapter input): bare date, offsets and offset-less (UTC) values accepted, output normalized to UTC. */
export function parseFocusTimestamp(text: unknown): ParsedInstant {
  if (typeof text !== 'string' || text.length > 40) throw new AllocationError('INVALID_TIMESTAMP');
  const m = FOCUS_RE.exec(text);
  if (!m) throw new AllocationError('INVALID_TIMESTAMP');
  let offsetMinutes = 0;
  const zone = m[8];
  if (zone !== undefined && zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    const zh = Number(digits.slice(0, 2));
    const zm = Number(digits.slice(2, 4));
    if (zh > 14 || zm > 59 || (zh === 14 && zm !== 0)) throw new AllocationError('INVALID_TIMESTAMP');
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (zh * 60 + zm);
  }
  const ms = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0;
  return build(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4] ?? '0'),
    Number(m[5] ?? '0'),
    Number(m[6] ?? '0'),
    ms,
    offsetMinutes,
  );
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** True for a valid `YYYY-MM` between 1970-01 and 9999-12. */
export function isMonth(text: unknown): text is string {
  if (typeof text !== 'string') return false;
  const m = MONTH_RE.exec(text);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return y >= 1970 && y <= 9999 && mo >= 1 && mo <= 12;
}

/** The month after `month` (`YYYY-MM`). Throws INVALID_TIMESTAMP past 9999-12. */
export function nextMonth(month: string): string {
  if (!isMonth(month)) throw new AllocationError('INVALID_TIMESTAMP');
  let y = Number(month.slice(0, 4));
  let mo = Number(month.slice(5, 7)) + 1;
  if (mo > 12) {
    mo = 1;
    y += 1;
  }
  if (y > 9999) throw new AllocationError('INVALID_TIMESTAMP');
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}`;
}

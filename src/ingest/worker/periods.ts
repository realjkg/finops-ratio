// Billing-period ranges. Periods are 'YYYY-MM-01' strings bounded to
// 2000-01..9999-12 (a five-digit year can never occur). Iteration counts
// months by ordinal instead of comparing strings: nextPeriod('9999-12-01')
// was '10000-01-01', which sorts BEFORE '9999-12-01', so a string-compare
// loop never ended (Copilot H2, third review).
import { IngestError } from '../errors';

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])-01$/;
export const MIN_PERIOD_YEAR = 2000;

const invalid = (m: string) => new IngestError('INVALID_RANGE', m);

/** Months since year 0 of a valid, in-bounds period; INVALID_RANGE otherwise. */
function ordinal(p: string): number {
  const m = typeof p === 'string' ? PERIOD.exec(p) : null;
  if (!m) throw invalid('a period must be YYYY-MM-01');
  const year = Number(m[1]);
  if (year < MIN_PERIOD_YEAR) throw invalid(`periods must lie within ${MIN_PERIOD_YEAR}-01..9999-12`);
  return year * 12 + Number(m[2]) - 1;
}

const fromOrdinal = (n: number) => `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}-01`;

/** INVALID_RANGE unless both ends are valid, in-bounds periods and from <= to. */
export function assertPeriodRange(range: { from: string; to: string }): void {
  if (ordinal(range.from) > ordinal(range.to)) throw invalid('range from is after to');
}

/** Every period from `from` to `to`, inclusive (validated as assertPeriodRange). */
export function periodsBetween(from: string, to: string): string[] {
  const a = ordinal(from);
  const b = ordinal(to);
  if (a > b) throw invalid('range from is after to');
  const out: string[] = [];
  for (let n = a; n <= b; n++) out.push(fromOrdinal(n));
  return out;
}

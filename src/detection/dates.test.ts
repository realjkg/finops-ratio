// Tests for UTC-only date arithmetic. Includes the F1 regression class: results
// must not depend on the process time zone, and DST days must be 24 hours.

import { describe, expect, it } from 'vitest';
import {
  addDays,
  civilFromDays,
  daysFromCivil,
  daysInMonth,
  formatDay,
  isLeapYear,
  lastCompleteDay,
  monthEndOf,
  monthKeyOf,
  monthStartOf,
  parseDay,
  parseInstant,
  weekdayOf,
} from '@/detection/dates';
import { DetectionError } from '@/detection/types';

describe('calendar arithmetic', () => {
  it('knows leap years, including century rules', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2028)).toBe(true);
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
  });

  it('returns the right month length for February in leap and common years', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('round-trips every day over a six-year span', () => {
    const start = daysFromCivil(2024, 1, 1);
    const end = daysFromCivil(2030, 1, 1);
    for (let dn = start; dn < end; dn += 1) {
      const c = civilFromDays(dn);
      expect(daysFromCivil(c.year, c.month, c.day)).toBe(dn);
      expect(parseDay(formatDay(dn))).toBe(dn);
    }
  });

  it('anchors the epoch: 1970-01-01 is day 0 and a Thursday', () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(weekdayOf(0)).toBe(4);
    expect(weekdayOf(parseDay('2026-10-11'))).toBe(0); // a Sunday
    expect(weekdayOf(parseDay('2026-10-12'))).toBe(1);
    expect(weekdayOf(-1)).toBe(3);
  });

  it('computes month boundaries across leap and common February', () => {
    expect(formatDay(monthEndOf(parseDay('2028-02-10')))).toBe('2028-02-29');
    expect(formatDay(monthEndOf(parseDay('2026-02-10')))).toBe('2026-02-28');
    expect(formatDay(monthEndOf(parseDay('2026-12-31')))).toBe('2026-12-31');
    expect(formatDay(monthStartOf(parseDay('2026-03-31')))).toBe('2026-03-01');
    expect(monthKeyOf(parseDay('2026-03-31'))).toBe('2026-03');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('parseDay', () => {
  it('accepts valid days and refuses malformed ones with a fixed message', () => {
    expect(formatDay(parseDay('2026-02-28'))).toBe('2026-02-28');
    const bad: unknown[] = [
      '2026-02-29', // not a leap year
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '2026-4-3',
      '2026-04-03T00:00:00Z',
      '',
      ' 2026-04-03',
      '1999-12-31', // before the supported range
      '2201-01-01',
      20260403,
      null,
      undefined,
      {},
    ];
    for (const value of bad) {
      expect(() => parseDay(value)).toThrow(DetectionError);
    }
  });

  it('never echoes the input in the error', () => {
    const secret = 'SECRET-TOKEN-xyz';
    try {
      parseDay(secret);
      throw new Error('expected parseDay to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DetectionError);
      expect((err as Error).message).not.toContain(secret);
      expect((err as DetectionError).code).toBe('AS_OF_INVALID');
    }
  });

  it('accepts a 29 February in a leap year', () => {
    expect(formatDay(parseDay('2028-02-29'))).toBe('2028-02-29');
  });
});

describe('parseInstant', () => {
  it('buckets by the UTC day of the instant for Z and offsets', () => {
    expect(formatDay(parseInstant('2026-03-08T00:00:00Z').dayNumber)).toBe('2026-03-08');
    expect(formatDay(parseInstant('2026-03-08T23:59:59Z').dayNumber)).toBe('2026-03-08');
    // 23:30 at UTC-06:00 is 05:30 UTC on the next day.
    expect(formatDay(parseInstant('2026-03-08T23:30:00-06:00').dayNumber)).toBe('2026-03-09');
    // 01:30 at UTC+09:00 is 16:30 UTC on the previous day.
    expect(formatDay(parseInstant('2026-03-08T01:30:00+09:00').dayNumber)).toBe('2026-03-07');
  });

  it('refuses timestamps without an explicit offset (local-time parsing risk)', () => {
    expect(() => parseInstant('2026-03-08T01:30:00')).toThrow(DetectionError);
    expect(() => parseInstant('2026-03-08')).toThrow(DetectionError);
  });

  it('refuses out-of-range fields, leap second and 24:00', () => {
    const bad = [
      '2026-03-08T24:00:00Z',
      '2026-03-08T23:60:00Z',
      '2026-03-08T23:59:60Z',
      '2026-02-29T00:00:00Z',
      '2026-03-08T00:00:00+24:00',
      '2026-03-08T00:00:00+05:60',
      '2026-03-08T00:00:00z',
      'not a date',
      '2026-03-08T00:00:00Z'.repeat(3),
    ];
    for (const value of bad) {
      expect(() => parseInstant(value)).toThrow(DetectionError);
    }
    expect(() => parseInstant(12345 as unknown)).toThrow(DetectionError);
  });

  it('keeps millisecond precision and truncates finer digits', () => {
    const a = parseInstant('2026-03-08T00:00:00.123456789Z');
    const b = parseInstant('2026-03-08T00:00:00Z');
    expect(a.epochMs - b.epochMs).toBe(123);
  });

  it('reports the index it was given, never the value', () => {
    try {
      parseInstant('garbage', 7);
      throw new Error('expected parseInstant to throw');
    } catch (err) {
      expect((err as DetectionError).index).toBe(7);
      expect((err as Error).message).not.toContain('garbage');
    }
  });
});

describe('DST-day immunity', () => {
  it('has exactly 24 UTC hours on the US spring-forward day (2026-03-08)', () => {
    // Hourly instants written in America/Chicago offsets across the transition:
    // -06:00 before 02:00 local, -05:00 after. Every UTC day must still map
    // to exactly 24 hourly instants over a 48-hour window.
    const counts = new Map<string, number>();
    const startMs = parseInstant('2026-03-08T00:00:00Z').epochMs;
    for (let h = 0; h < 48; h += 1) {
      const ms = startMs + h * 3_600_000;
      const day = formatDay(Math.floor(ms / 86_400_000));
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    expect(counts.get('2026-03-08')).toBe(24);
    expect(counts.get('2026-03-09')).toBe(24);
  });

  it('maps local-offset instants around the transition to the correct UTC day', () => {
    // 2026-03-08 01:59 CST (-06:00) and 03:00 CDT (-05:00) are 59 minutes apart.
    const before = parseInstant('2026-03-08T01:59:00-06:00');
    const after = parseInstant('2026-03-08T03:00:00-05:00');
    expect(after.epochMs - before.epochMs).toBe(60_000);
    expect(before.dayNumber).toBe(after.dayNumber);
    // EU spring-forward (2026-03-29) in Europe/Berlin: +01:00 then +02:00.
    const euBefore = parseInstant('2026-03-29T01:59:00+01:00');
    const euAfter = parseInstant('2026-03-29T03:00:00+02:00');
    expect(euAfter.epochMs - euBefore.epochMs).toBe(60_000);
  });
});

describe('time zone independence (finding F1)', () => {
  it('gives identical answers under TZ=Asia/Tokyo, America/Chicago and UTC', () => {
    const original = process.env.TZ;
    const probe = () => ({
      feb2026: daysInMonth(2026, 2),
      feb2028: daysInMonth(2028, 2),
      end: formatDay(monthEndOf(parseDay('2026-02-10'))),
      instant: formatDay(parseInstant('2026-02-28T23:30:00-06:00').dayNumber),
      weekday: weekdayOf(parseDay('2026-03-01')),
      complete: lastCompleteDay(new Date(Date.UTC(2026, 2, 1, 0, 30))),
    });
    try {
      const results = ['UTC', 'Asia/Tokyo', 'America/Chicago', 'Pacific/Kiritimati'].map((tz) => {
        process.env.TZ = tz;
        return probe();
      });
      for (const r of results) expect(r).toEqual(results[0]);
      expect(results[0]).toEqual({
        feb2026: 28,
        feb2028: 29,
        end: '2026-02-28',
        instant: '2026-03-01',
        weekday: 0,
        complete: '2026-02-28',
      });
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe('lastCompleteDay', () => {
  it('is the UTC day before the injected now', () => {
    expect(lastCompleteDay(new Date('2026-10-11T00:00:00Z'))).toBe('2026-10-10');
    expect(lastCompleteDay(new Date('2026-10-11T23:59:59Z'))).toBe('2026-10-10');
    expect(lastCompleteDay(new Date('2026-03-01T00:00:00Z'))).toBe('2026-02-28');
    expect(lastCompleteDay(new Date('2028-03-01T12:00:00Z'))).toBe('2028-02-29');
  });

  it('refuses invalid dates and non-dates', () => {
    expect(() => lastCompleteDay(new Date(Number.NaN))).toThrow(DetectionError);
    expect(() => lastCompleteDay('2026-10-11' as unknown as Date)).toThrow(DetectionError);
    expect(() => lastCompleteDay(new Date('1990-01-01T00:00:00Z'))).toThrow(DetectionError);
  });
});

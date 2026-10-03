// PR #54 fifth Copilot review M1: Date.UTC maps years 0-99 to 1900-1999; FOCUS
// timestamps in years 1-99 must keep their year (proleptic Gregorian, as
// Postgres and ISO 8601 do).
import { describe, expect, it } from 'vitest';
import { parseFocusTimestamp } from './timestamp';
import { indexHeader, validateRow } from './validate';
import { FOCUS_HEADER, focusRow } from '../testing/focusCsv';

/** The instant via setUTCFullYear (never the Date.UTC 0-99 mapping). */
function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, s, ms);
  return t.getTime();
}

describe('parseFocusTimestamp keeps years 1-99', () => {
  it('0001-01-01 is the first instant of year 1 (not 1901)', () => {
    expect(parseFocusTimestamp('0001-01-01')?.epochMs).toBe(-62135596800000);
    expect(parseFocusTimestamp('0001-01-01T00:00:00Z')?.epochMs).toBe(utc(1, 1, 1));
  });

  it('the 0099/0100 boundary is in order and one hour apart', () => {
    const a = parseFocusTimestamp('0099-12-31T23:00:00Z')!;
    const b = parseFocusTimestamp('0100-01-01T00:00:00Z')!;
    expect(a.epochMs).toBe(utc(99, 12, 31, 23));
    expect(b.epochMs - a.epochMs).toBe(3_600_000);
  });

  it('calendar checks use the real year (0004 is a leap year; Feb 29 of year 100 does not exist)', () => {
    expect(parseFocusTimestamp('0004-02-29')).not.toBeNull();
    expect(parseFocusTimestamp('0100-02-29')).toBeNull();
  });

  it('charge-period ordering across 0099/0100 is not reported inverted', () => {
    const r = indexHeader([...FOCUS_HEADER]);
    if (!r.ok) throw new Error('header');
    const row = focusRow('2026-07-01', { ChargePeriodStart: '0099-12-31T23:00:00Z', ChargePeriodEnd: '0100-01-01T00:00:00Z' });
    const v = validateRow(FOCUS_HEADER.map((h) => (row as Record<string, string>)[h] ?? ''), r.index, '2026-07-01');
    if (!v.ok) expect(v.errors.map((e) => e.code)).not.toContain('CHARGE_PERIOD_INVERTED');
    // ...and an end genuinely before the start still is.
    const inv = focusRow('2026-07-01', { ChargePeriodStart: '0100-01-01T00:00:00Z', ChargePeriodEnd: '0099-12-31T23:00:00Z' });
    const w = validateRow(FOCUS_HEADER.map((h) => (inv as Record<string, string>)[h] ?? ''), r.index, '2026-07-01');
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.errors.map((e) => e.code)).toContain('CHARGE_PERIOD_INVERTED');
  });
});

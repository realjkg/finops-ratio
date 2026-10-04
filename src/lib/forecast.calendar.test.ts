// PR 4-0 — the budget calendar must not depend on the host time zone.
//
// Bug: daysInMonthOf built the month end with the LOCAL-time constructor
// (new Date(y, m + 1, 0) = local midnight) and read it back with getUTCDate().
// East of UTC, local midnight is still the previous UTC day, so February 2026
// had 27 days under TZ=Asia/Tokyo and June 2026 (the demo month) had 29.
//
// The budget calendar is UTC (see forecast.ts): a budget day/month is the UTC
// calendar day/month of the instant. These tests pin that in three ways:
//   1. pure (year, month) arithmetic, checked against Date.UTC;
//   2. the Date-taking helpers in THIS process, whatever TZ it runs under;
//   3. the same helpers, and computeBudgetStatus, in child processes run under
//      five fixed zones (+0, +9, +14, -8/-7 with DST, -11). This is part of the
//      normal `npm test`, so CI catches a regression with no special setup.
//
// Expected month lengths and weekday counts below are an independent oracle,
// generated with Python's `calendar` module (not with this code).

import path from 'path';
import { execFile } from 'child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUDGET_PROFILES } from '@/data/budgets';
import { DEMO_NOW, WORKLOADS } from '@/data/workloads';
import { spendMtdFor, type BudgetStatus } from './budgetStatus';
import {
  daysInMonth,
  daysInMonthOf,
  isLeapYear,
  projectMonthlySpend,
  remainingWeekdaysInMonth,
} from './forecast';

const ROOT = path.resolve(__dirname, '..', '..');
const PROBE = path.join(__dirname, 'calendarTzProbe.ts');

// [UTC instant, days in its UTC month, Mon–Fri left in the month after its UTC day, label]
const CASES: Array<[string, number, number, string]> = [
  // February, leap and non-leap
  ['2026-02-10T12:00:00.000Z', 28, 13, 'non-leap Feb'],
  ['2026-02-26T18:00:00.000Z', 28, 1, 'non-leap Feb, two days before the end'],
  ['2026-02-28T23:59:59.999Z', 28, 0, 'non-leap Feb, last instant'],
  ['2024-02-10T12:00:00.000Z', 29, 14, 'leap Feb'],
  ['2024-02-29T00:00:00.000Z', 29, 0, 'leap day, first instant'],
  ['2000-02-15T06:00:00.000Z', 29, 10, 'leap Feb (400-year rule)'],
  ['2100-02-15T06:00:00.000Z', 28, 9, 'non-leap Feb (100-year rule)'],
  // 30-day months
  ['2026-04-01T00:00:00.000Z', 30, 21, '30-day month, first instant'],
  ['2026-04-30T23:30:00.000Z', 30, 0, '30-day month, last day late UTC (already May in Tokyo)'],
  ['2026-06-25T17:42:00.000Z', 30, 3, '30-day month, DEMO_NOW'],
  ['2026-06-29T20:00:00.000Z', 30, 1, '30-day month, day before the end'],
  ['2026-09-15T14:00:00.000Z', 30, 11, '30-day month'],
  // 31-day months
  ['2026-01-15T03:00:00.000Z', 31, 11, '31-day month'],
  ['2026-05-31T23:59:59.999Z', 31, 0, '31-day month, last instant'],
  ['2026-07-01T00:00:00.000Z', 31, 22, '31-day month, first instant (still June in LA)'],
  ['2026-08-31T12:00:00.000Z', 31, 0, '31-day month, last day'],
  // DST transition months (US: 8 Mar / 1 Nov 2026; EU: 29 Mar / 25 Oct 2026)
  ['2026-03-08T10:00:00.000Z', 31, 17, 'US DST start day'],
  ['2026-03-29T01:30:00.000Z', 31, 2, 'EU DST start day'],
  ['2026-03-30T22:00:00.000Z', 31, 1, 'DST-start month, day before the end'],
  ['2026-03-31T23:59:59.999Z', 31, 0, 'DST-start month, last instant'],
  ['2026-10-25T01:30:00.000Z', 31, 5, 'EU DST end day'],
  ['2026-11-01T09:30:00.000Z', 30, 21, 'US DST end day'],
  ['2026-11-30T23:00:00.000Z', 30, 0, 'DST-end month, last day late UTC'],
  // Year boundaries
  ['2025-12-31T12:00:00.000Z', 31, 0, 'Dec 31'],
  ['2026-12-31T23:59:59.999Z', 31, 0, 'last instant of a year'],
  ['2027-01-01T00:00:00.000Z', 31, 20, 'first instant of a year (still 2026 in LA)'],
  ['2023-12-31T23:00:00.000Z', 31, 0, 'year boundary into a leap year'],
];

// Zones and their expected UTC offsets (getTimezoneOffset, minutes) on
// 2026-01-15 and 2026-07-15. Checking them proves the child really ran in that
// zone; a silently ignored TZ would make the matrix vacuous.
const TZ_MATRIX = [
  { tz: 'UTC', jan: 0, jul: 0 },
  { tz: 'Asia/Tokyo', jan: -540, jul: -540 },
  { tz: 'Pacific/Kiritimati', jan: -840, jul: -840 },
  { tz: 'America/Los_Angeles', jan: 480, jul: 420 },
  { tz: 'Pacific/Pago_Pago', jan: 660, jul: 660 },
] as const;

interface ProbeOutput {
  tz: string | null;
  resolvedTimeZone: string;
  offsets: { jan: number; jul: number };
  calendar: Array<{ iso: string; daysInMonth: number; remainingWeekdays: number }>;
  budget: Array<{ id: string; status: BudgetStatus | null }>;
}

function runProbe(tz: string): Promise<ProbeOutput> {
  const instants = JSON.stringify(CASES.map(([iso]) => iso));
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', PROBE, instants],
      {
        cwd: ROOT,
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`probe failed under TZ=${tz}: ${err.message}\n${stderr}`));
        else resolve(JSON.parse(stdout) as ProbeOutput);
      },
    );
  });
}

// One child per zone, shared by every test that needs it.
const probes = new Map<string, Promise<ProbeOutput>>();
function probeFor(tz: string): Promise<ProbeOutput> {
  let p = probes.get(tz);
  if (!p) {
    p = runProbe(tz);
    probes.set(tz, p);
  }
  return p;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

describe('pure calendar arithmetic (no Date, no time zone)', () => {
  it('isLeapYear follows the Gregorian 4/100/400 rule', () => {
    expect([2024, 2028, 2000, 2400, 1600].map(isLeapYear)).toEqual([true, true, true, true, true]);
    expect([2026, 2025, 2100, 1900, 2200].map(isLeapYear)).toEqual([false, false, false, false, false]);
  });

  it('daysInMonth(year, month 1–12) for every month of 2026 and every February edge', () => {
    expect(Array.from({ length: 12 }, (_, i) => daysInMonth(2026, i + 1))).toEqual([
      31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ]);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2100, 2)).toBe(28);
  });

  it('agrees with Date.UTC for every month of 1600–2400', () => {
    for (let y = 1600; y <= 2400; y += 1) {
      for (let m = 1; m <= 12; m += 1) {
        const oracle = new Date(Date.UTC(y, m, 0)).getUTCDate();
        if (daysInMonth(y, m) !== oracle) {
          throw new Error(`daysInMonth(${y}, ${m}) = ${daysInMonth(y, m)}, expected ${oracle}`);
        }
      }
    }
  });

  it('rejects a month outside 1–12 instead of wrapping (catches a 0-based index)', () => {
    for (const bad of [0, 13, -1, 1.5, Number.NaN]) {
      expect(() => daysInMonth(2026, bad)).toThrow(RangeError);
    }
  });
});

describe(`Date helpers in this process (TZ=${process.env.TZ ?? '<unset>'})`, () => {
  it.each(CASES)('%s: %i days, %i weekdays left (%s)', (iso, days, weekdays) => {
    const d = new Date(iso);
    expect(daysInMonthOf(d)).toBe(days);
    expect(remainingWeekdaysInMonth(d)).toBe(weekdays);
  });
});

// The oracle for the budgetStatus caller path at DEMO_NOW (2026-06-25, UTC):
// June has 30 days, so 5 remain after the 25th, 3 of them weekdays.
const DEMO_DAYS_IN_MONTH = 30;
const DEMO_REMAINING_WEEKDAYS = 3;

describe.each(TZ_MATRIX)('child process under TZ=$tz', ({ tz, jan, jul }) => {
  let probe: ProbeOutput;
  beforeAll(async () => {
    probe = await probeFor(tz);
  }, 60_000);

  it('really runs in that zone', () => {
    expect(probe.tz).toBe(tz);
    expect(probe.offsets).toEqual({ jan, jul });
  });

  it('daysInMonthOf and remainingWeekdaysInMonth match the oracle for every case', () => {
    const expected = CASES.map(([iso, daysInMonth, remainingWeekdays]) => ({
      iso,
      daysInMonth,
      remainingWeekdays,
    }));
    expect(probe.calendar).toEqual(expected);
  });

  it('computeBudgetStatus at DEMO_NOW uses the UTC month (30 days, 5 left, 3 weekdays)', () => {
    expect(DEMO_NOW.toISOString()).toBe('2026-06-25T17:42:00.000Z');
    expect(probe.budget.length).toBe(WORKLOADS.length);
    for (const { id, status } of probe.budget) {
      const workload = WORKLOADS.find((w) => w.id === id)!;
      const profile = BUDGET_PROFILES.find((b) => b.workload_id === id)!;
      expect(status, id).not.toBeNull();
      const oracle = projectMonthlySpend({
        spendMtd: spendMtdFor(workload, DEMO_NOW),
        dailySpendHistory: profile.daily_spend_history,
        allocation: profile.daily_allocation,
        currentDay: 25,
        daysInMonth: DEMO_DAYS_IN_MONTH,
        remainingWeekdays: DEMO_REMAINING_WEEKDAYS,
      });
      expect(status!.monthly.remainingDays, id).toBe(5);
      expect(status!.monthly.projectedEom, id).toBe(round2(oracle.projectedEom));
    }
  });
});

describe('every zone produces the identical BudgetStatus', () => {
  it('the whole computeBudgetStatus output is TZ-independent', async () => {
    const outputs = await Promise.all(TZ_MATRIX.map(({ tz }) => probeFor(tz)));
    const [first, ...rest] = outputs;
    for (const other of rest) {
      expect({ tz: other.tz, budget: other.budget }).toEqual({ tz: other.tz, budget: first.budget });
    }
  }, 60_000);
});

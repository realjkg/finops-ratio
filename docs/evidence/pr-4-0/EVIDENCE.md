# PR 4-0 — evidence: `daysInMonthOf` time-zone bug

Branch `fix/4-0-days-in-month-tz`, from `origin/main` at 827773f. Not pushed;
no PR. No DB, migration, `pages/` or UI changes.

| Commit | What |
|---|---|
| 5087243 | Tests first (red): `src/lib/forecast.calendar.test.ts`, `src/lib/calendarTzProbe.ts`, `red/` |
| 2555ae3 | Fix: `src/lib/forecast.ts` only |
| (this commit) | This file, `mutations/`, `gates/` |

## 1. Root cause

```ts
// 827773f, src/lib/forecast.ts
export function daysInMonthOf(date: Date): number {
  return new Date(date.getUTCFullYear(), date.getUTCMonth() + 1, 0).getUTCDate();
}
```

The code mixes local time and UTC. The year and month are read in UTC. The
month end is built with the local-time constructor, `new Date(y, m, 0)`,
which gives local midnight on the last day. That value is then read back
with `getUTCDate()`. East of UTC (offset > 0), local midnight is still the
previous UTC day, so every month comes out one day short:

| TZ | Feb 2026 | Jun 2026 (DEMO_NOW month) | `remainingWeekdaysInMonth(DEMO_NOW)` |
|---|---|---|---|
| UTC | 28 | 30 | 3 |
| Asia/Tokyo (+9) | **27** | **29** | **2** |
| Pacific/Kiritimati (+14) | **27** | **29** | **2** |
| America/Los_Angeles (−8/−7) | 28 | 30 | 3 |
| Pacific/Pago_Pago (−11) | 28 | 30 | 3 |

West of UTC, and at UTC, the result happened to be correct. Local midnight
there falls on the same UTC date, so the bug never appears in a
UTC-or-Americas CI or dev box.

**The budget calendar is UTC (proleptic Gregorian).** This is now documented
above the calendar helpers in `forecast.ts`. A budget day or month is the UTC
calendar day or month of the instant, so the server, the build machine and
every browser agree. This was already the intent of every other helper,
which all read `getUTC*`. Only this line broke it.

## 2. Fix (2555ae3)

- `isLeapYear(year)` and `daysInMonth(year, month1to12)` are pure
  arithmetic, with no `Date` and no time zone. They are valid for any year,
  with no `Date.UTC` two-digit-year quirk. `daysInMonth` throws a
  `RangeError` for a month outside 1–12 or a non-integer month, so a 0-based
  index fails loudly instead of wrapping.
- `daysInMonthOf(date)` = `daysInMonth(date.getUTCFullYear(), date.getUTCMonth() + 1)`.
- `remainingWeekdaysInMonth` is unchanged apart from its comment. It was
  already UTC-consistent (`Date.UTC` + `getUTCDay`) and was wrong only
  through its loop bound, `daysInMonthOf`.

## 3. Every affected caller

Direct:
- `src/lib/forecast.ts` `remainingWeekdaysInMonth`: its loop bound came from
  `daysInMonthOf`, so it missed the last day of the month east of UTC.
- `src/lib/budgetStatus.ts` `computeBudgetStatus`: passes `daysInMonth` and
  `remainingWeekdays` to `projectMonthlySpend`. This affected
  `monthly.remainingDays`, `projectedEom`, `projectedPctOfBudget`,
  `confidence` (its √remainingDays margin), and through them `status` and
  `daysUntilBreach`.

Indirect, through `computeBudgetStatus`. Each one is evaluated in whichever
process runs it: the Next server, the prerender at build time, or the
browser. Before the fix, its numbers depended on that host's TZ:
- `src/components/detail/BudgetProfileTab.tsx` (Budget tab, browser `now`).
- `src/mission/missionModel.ts` → `MissionBoard`, and
  `src/executive/initiativeModel.ts` (`buildInitiativeBoard`), which also
  feeds `src/executive/reportModel.ts` (PDF/XLSX report, `/api/report/snapshot`).
- `src/costsource/normalize.ts` → every cost-source adapter (`Mock`,
  `FocusFile`, `PointFiveLive`, `CloudConnector`).

Impact at `DEMO_NOW` (2026-06-25T17:42Z), before the fix. Measured on
827773f:

| workload | UTC: remainingDays / projectedEom | Asia/Tokyo: remainingDays / projectedEom |
|---|---|---|
| wl-support | 5 / 13309.56 | 4 / 12818.81 |
| wl-marketing | 5 / 4764.58 | 4 / 4588.18 |
| wl-fraud | 5 / 4295.52 | 4 / 4144.32 |
| (all 7) | 5 | 4 (month-end spend under-projected by about 3.7%) |

No status label flipped at `DEMO_NOW`, but all of the figures above did.

### Audit for the same class of bug (local-time vs UTC)

I grepped `src/` and `pages/` (excluding tests) for:
- the local getters and setters (`getFullYear/Month/Date/Day/Hours/Minutes`,
  `setFullYear/Month/Date/Hours`);
- the multi-argument local constructor `new Date(y, m, …)`;
- string parsing: `Date.parse(` and `new Date(<string>)`;
- `toLocale*String`, `Intl.DateTimeFormat` and `getTimezoneOffset`.

The hits fall into four groups.

**1. Fixed here.** `forecast.ts` `daysInMonthOf`.

**2. Found, the same class, out of scope for this PR.**
`src/finio/focusValidation.ts` `parseIso` calls `Date.parse(value)` on the
FOCUS period strings. JavaScript reads a zoneless date-time
(`2026-03-08T02:00:00`) as host-local time, so the verdict depends on the
host TZ. On a daylight-saving day it changes:
- the half-open period `[2026-03-08T02:00:00, 2026-03-08T03:00:00)` is
  accepted under `TZ=UTC`;
- it is rejected as `start >= end` under `TZ=America/Los_Angeles`, where both
  bounds parse to the same instant.

I reproduced this with plain `node`. It is not a budget-calendar bug and
this PR does not change it. It is tracked in follow-up issue #64.

**3. Local display formatting, deliberate, not calendar logic.** These render
an instant for the person looking at the screen, in their own zone. They
compute no budget day, month or period.
- `src/findings/FindingsPage.tsx:579`:
  `new Date(record.createdAt).toLocaleString('en-US', { …, timeZoneName: 'short' })`,
  which also prints the zone name.
- `src/finio/FinioPage.tsx:254`:
  `new Date(loadState.handshake.expiresAt).toLocaleTimeString()`.

The other `toLocaleString('en-US', …)` hits format numbers, not dates
(`lib/format.ts`, `MockAIClient.ts`, `TokenomicsPage.tsx`, `FinioPage.tsx:36`,
`pages/api/v1/ai/chat.ts`).

**4. UTC-consistent, or parsing zoned instants only.**

| Helper | Calendar |
|---|---|
| `forecast.ts` `remainingWeekdaysInMonth` (weekday counting) | `Date.UTC` + `getUTCDay` |
| `forecast.ts` `fractionalHour` (hour of "today") | `getUTCHours/Minutes` |
| `budgetStatus.ts` `spendMtdFor`, `currentDay` ("today") | `getUTCDate` |
| `billingPeriod.ts` `currentBillingPeriod` (month boundaries) | `Date.UTC(getUTCFullYear, getUTCMonth[+1], 1)` |
| `costsource/CostSourcePage.tsx` `currentWindow`, `transports/httpFocusTransport.ts` `currentMonthWindow` | same as above |
| `executive/reportModel.ts` `periodLabel` | `toLocaleString(…, { timeZone: 'UTC' })` |
| `executive/reportFilename.ts` | `toISOString` |
| `ingest/focus/timestamp.ts` `daysInMonth`, `ingest/fixtures/syntheticFocus.ts` | `setUTCFullYear` / `Date.UTC` + `getUTCDate` |
| `costsource/transports/focusExport.ts` `parseIsoUtc`, `PointFiveLiveAdapter.ts` `detectedAt` | own parser: `Date.UTC`, then an explicit offset; zoneless strings are read as UTC |
| `transports/awsS3Transport.ts:146`, `focusExport.ts:627` | `Date.parse` on S3 `LastModified`, which carries `Z` |
| `lib/format.ts` `timeAgo`; sorts in `AlertHistoryTab.tsx` and `layout/Footer.tsx` | `new Date(iso)` on `triggered_at` values that carry `Z` |
| `ingest/worker/doctor.ts`, `quarantine.ts`, `ingest/db/migrate.ts` | `new Date(<pg timestamptz value>)`, an instant |
| `data/workloads.ts` `DEMO_NOW` | literal with `Z` |

As a broader sweep, I ran the whole `npm test` suite after the fix under
five host TZs (§6). It passed in every one.

## 4. Tests (`src/lib/forecast.calendar.test.ts`, 47 tests)

The expected month lengths and weekday counts are an independent oracle,
generated with Python's `calendar` module and hard-coded in the test.

1. **Pure arithmetic.** These tests use no Date and no TZ:
   - `isLeapYear` on the 4/100/400 rule;
   - all 12 months of 2026, and February in 1900, 2000, 2024 and 2100;
   - `daysInMonth` against `Date.UTC(y, m, 0)` for every month from 1600 to 2400;
   - a `RangeError` for months 0, 13, −1, 1.5 and NaN.
2. **In-process.** The `Date`-taking helpers run in the test process's own
   TZ, over 27 cases:
   - February in leap and non-leap years, including the 100- and 400-year rules;
   - 30- and 31-day months;
   - US and EU DST start and end days and months;
   - year boundaries;
   - first and last instants of a month, and instants whose local date
     differs from the UTC date (e.g. `2026-04-30T23:30Z` is May in Tokyo,
     and `2027-01-01T00:00Z` is still 2026 in LA);
   - the remaining weekday count in every case, including "day before the
     end" cases where the last day is a weekday.
3. **TZ matrix in child processes.** The test runs
   `node --import tsx src/lib/calendarTzProbe.ts`, using the same pattern as
   `src/ingest/worker/periods.test.ts`, under each of these zones:
   - `UTC`
   - `Asia/Tokyo`
   - `Pacific/Kiritimati`
   - `America/Los_Angeles`
   - `Pacific/Pago_Pago`

   For each zone it asserts:
   - the child really ran in that zone: `process.env.TZ`, plus
     `getTimezoneOffset` in January and July. For LA these are 480 and 420
     (the DST offset), so a silently ignored TZ cannot pass;
   - all 27 cases match the oracle;
   - `computeBudgetStatus` for all 7 workloads at `DEMO_NOW` gives
     `remainingDays` = 5, and `projectedEom` equals `projectMonthlySpend`
     fed the oracle's inputs (30 days, 3 weekdays);
   - the entire `BudgetStatus` output is identical across all five zones.

This runs inside the normal `npm test` and adds about 2 s. There is one child
per zone, five in all. They start one after another, from each zone's
`describe` `beforeAll`, and the cross-zone test reuses their results. It needs nothing beyond `tsx`, which is already a
devDependency, and Node's bundled ICU time-zone data. CI catches a
regression with no special setup.

### Red (tests at 5087243 against the unfixed `forecast.ts`)

| Host TZ | Result | File |
|---|---|---|
| UTC (as CI runs) | 9 failed / 38 passed. The 4 pure tests fail because the helpers do not exist yet. Tokyo and Kiritimati fail the oracle and budget tests (27 for Feb 2026, 29 for Jun 2026, `remainingDays` 4, `projectedEom` too low). The cross-zone identity test fails. UTC, LA and Pago Pago pass, as the root cause predicts. | `red/red-host-UTC.txt` |
| Asia/Tokyo | 36 failed / 11 passed. Additionally, all 27 in-process cases fail. | `red/red-host-Asia-Tokyo.txt` |

The UTC-host run shows why the matrix is needed. With the host at UTC, the
in-process cases pass even on the buggy code, and only the child processes
catch it.

## 5. Mutations

Each mutation was applied to the fixed `forecast.ts` and run with
`TZ=UTC npx vitest run src/lib/forecast.calendar.test.ts`, the CI default
host. The source was restored afterwards, and `git diff` is clean. Full
outputs are in `mutations/`.

| # | Mutation | Result |
|---|---|---|
| M1a | Local/UTC mix, the original bug: `new Date(getUTCFullYear(), getUTCMonth()+1, 0).getUTCDate()` | **killed**, 5 failed. Tokyo and Kiritimati fail on the oracle and the budget; the cross-zone identity test fails. |
| M1b | Local/UTC mix, reversed: `daysInMonth(date.getFullYear(), date.getMonth()+1)` | **killed**, 4 failed. The oracle fails in Tokyo, Kiritimati, LA and Pago Pago, on the month-edge instants. |
| M1c | Local/UTC mix in weekday counting: `new Date(year, month, day).getUTCDay()` | **killed**, 2 failed. The oracle fails in Tokyo and Kiritimati. |
| M2a | Off-by-one month index: `daysInMonth(getUTCFullYear(), getUTCMonth())`, 0-based | **killed**, 27 failed. All in-process cases fail; the probe throws `RangeError` for January, so every zone fails. |
| M2b | Off-by-one month index in the `Date.UTC` idiom: `Date.UTC(y, getUTCMonth(), 0)` | **killed**, 34 failed. Every case and every zone fails. |
| M3a | Handles only zones within ±12 h: local *noon* on the last day instead of midnight | **killed**, 3 failed. Only Kiritimati (+14) catches it. |
| M3b | Handles only Asia/Tokyo: the local month end shifted by a hard-coded +9 h | **killed**, 3 failed. Only Kiritimati catches it. |

M3a and M3b pass in UTC, Tokyo, LA and Pago Pago. That is why the matrix
includes a +14 zone.

## 6. Gates (at 2555ae3; outputs in `gates/`)

| Gate | Result |
|---|---|
| `npm run lint` | exit 0 |
| `npm run typecheck` (`tsc --noEmit`) | exit 0 |
| `npm test` (container TZ unset = UTC) | exit 0: 106 files, 2546 tests passed |
| `npm test` under `TZ=` Asia/Tokyo, Pacific/Kiritimati, America/Los_Angeles, Pacific/Pago_Pago | exit 0 in each: 106 files, 2546 tests passed |
| `npm run build` (`next build`, Turbopack) | exit 0. Next rewrote `tsconfig.json` and `next-env.d.ts` as it did before; I restored both with `git checkout`. |
| `npm run check:bundle` | exit 0, `pass: true` |
| `npm run test:db` | not run: there are no DB changes |

## 7. Notes

- Because the budget calendar is UTC, "today" for the budget is the UTC
  day. For example, a viewer in Tokyo at 08:00 local time on 1 July is
  still on the budget day of 30 June. That is the documented design, and
  this PR does not change it. Making the budget follow a tenant's local
  calendar would be a product decision and a separate change.
- `src/lib/calendarTzProbe.ts` is a test helper, not a test file. Nothing in
  the app imports it. It lives next to the code it probes so that `tsx`
  resolves the `@/` paths the same way the app does.

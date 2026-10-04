// Child-process probe for forecast.calendar.test.ts (PR 4-0). Not a test file
// and not imported by the app.
//
// The test runs this once per time zone (`TZ=<zone> node --import tsx
// calendarTzProbe.ts '<json array of ISO instants>'`) and prints one JSON
// document with:
//   - the zone the process actually resolved, plus its UTC offsets in January
//     and July, so the test can prove the TZ really took effect;
//   - what the Date-taking calendar helpers in forecast.ts return for each
//     instant;
//   - the monthly figures computeBudgetStatus produces for every demo workload
//     at DEMO_NOW (the caller path: budgetStatus.ts -> forecast.ts).
// The expected values live in the test, not here.

import { BUDGET_PROFILES } from '@/data/budgets';
import { DEMO_NOW, WORKLOADS } from '@/data/workloads';
import { computeBudgetStatus } from './budgetStatus';
import { daysInMonthOf, remainingWeekdaysInMonth } from './forecast';

const instants: string[] = JSON.parse(process.argv[2] ?? '[]');

const out = {
  tz: process.env.TZ ?? null,
  resolvedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  offsets: {
    jan: new Date('2026-01-15T12:00:00Z').getTimezoneOffset(),
    jul: new Date('2026-07-15T12:00:00Z').getTimezoneOffset(),
  },
  calendar: instants.map((iso) => {
    const d = new Date(iso);
    return {
      iso,
      daysInMonth: daysInMonthOf(d),
      remainingWeekdays: remainingWeekdaysInMonth(d),
    };
  }),
  budget: WORKLOADS.map((w) => {
    const profile = BUDGET_PROFILES.find((b) => b.workload_id === w.id);
    return {
      id: w.id,
      status: profile ? computeBudgetStatus(w, profile, DEMO_NOW) : null,
    };
  }),
};

process.stdout.write(JSON.stringify(out));

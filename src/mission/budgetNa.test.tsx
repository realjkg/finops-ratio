// Pilot P0: the daily/portfolio gauges and the Budget tab show N/A with a reason
// for an invalid budget (never 0%), and no longer clamp an overrun to 100%.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WORKLOADS } from '@/data/workloads';
import { budgetFor } from '@/data/budgets';
import { computeBudgetStatus } from '@/lib/budgetStatus';
import { BudgetProfileTab } from '@/components/detail/BudgetProfileTab';
import { buildMissionBoard, toMissionView } from './missionModel';
import { FuelAndValue } from './FuelAndValue';
import { FleetHeader } from './FleetHeader';

const w = WORKLOADS[0];
const withDaily = (daily_budget: number) => ({ ...w, costs: { ...w.costs, daily_budget } });
const NOW = new Date('2026-06-15T12:00:00Z');

describe('mission gauges', () => {
  it('N/A with a reason for an invalid daily budget; overrun is not clamped', () => {
    const bad = toMissionView(withDaily(0));
    expect(bad.fuelPct).toBeNull();
    expect(bad.fuelNa).toMatch(/approved budget/i);
    const html = renderToStaticMarkup(<FuelAndValue {...bad} />);
    expect(html).toContain('N/A');
    expect(html).not.toContain('aria-valuenow="0"');
    expect(toMissionView(withDaily(1)).fuelPct).toBeGreaterThan(100);
  });

  it('portfolio gauge is N/A when any mission budget is invalid, a percent otherwise', () => {
    const { fleet } = buildMissionBoard([withDaily(0), ...WORKLOADS.slice(1)]);
    expect(fleet.fleetFuelPct).toBeNull();
    expect(renderToStaticMarkup(<FleetHeader fleet={fleet} />)).toMatch(/N\/A/);
    expect(buildMissionBoard().fleet.fleetFuelPct).toBeGreaterThanOrEqual(0);
  });
});

describe('budget status and Budget tab', () => {
  it('flags an invalid budget instead of reporting 0', () => {
    const s = computeBudgetStatus({ ...withDaily(0), costs: { ...w.costs, daily_budget: 0, monthly_budget: 0 } }, budgetFor(w.id)!, NOW);
    expect(s.daily.pctUsedNa).toMatch(/approved budget/i);
    expect(s.monthly.pctUsedNa).toMatch(/approved budget/i);
    expect(computeBudgetStatus(w, budgetFor(w.id)!, NOW).monthly.pctUsedNa).toBeNull();
  });

  it('renders N/A text, not 0%, for the consumed and projected figures', () => {
    const bad = { ...w, costs: { ...w.costs, daily_budget: 0, monthly_budget: 0 } };
    const html = renderToStaticMarkup(<BudgetProfileTab workload={bad} budget={budgetFor(w.id)!} now={NOW} />);
    expect(html).toMatch(/N\/A[^<]*approved budget/i);
    expect(html).not.toMatch(/>0% of \$0/);
  });
});

// Visible-text and per-period assertions (review round 2): they target the rendered
// value span and reason text, not aria attributes, and separate daily from monthly.
const VISIBLE = />N\/A \([^<]*approved budget[^<]*\)<\/span>/;
const bad = (c: Partial<typeof w.costs>) => ({ ...w, costs: { ...w.costs, ...c } });

describe('visible N/A text', () => {
  it('daily gauge and portfolio gauge show N/A plus the reason in the value span', () => {
    expect(renderToStaticMarkup(<FuelAndValue {...toMissionView(withDaily(0))} />)).toMatch(VISIBLE);
    expect(renderToStaticMarkup(<FleetHeader fleet={buildMissionBoard([withDaily(0), ...WORKLOADS.slice(1)]).fleet} />)).toMatch(VISIBLE);
  });

  it('portfolio overspend is not clamped', () => {
    const tiny = WORKLOADS.map((x) => ({ ...x, costs: { ...x.costs, daily_budget: 1 } }));
    const { fleet } = buildMissionBoard(tiny);
    expect(fleet.fleetFuelPct).toBeGreaterThan(100);
    expect(renderToStaticMarkup(<FleetHeader fleet={fleet} />)).toContain(`>${fleet.fleetFuelPct}%</span>`);
  });

  it('daily and monthly N/A come from their own budget and period', () => {
    const dailyOnly = computeBudgetStatus(bad({ daily_budget: 0 }), budgetFor(w.id)!, NOW);
    expect([dailyOnly.daily.pctUsedNa === null, dailyOnly.monthly.pctUsedNa === null]).toEqual([false, true]);
    const monthlyOnly = computeBudgetStatus(bad({ monthly_budget: 0 }), budgetFor(w.id)!, NOW);
    expect([monthlyOnly.daily.pctUsedNa === null, monthlyOnly.monthly.pctUsedNa === null]).toEqual([true, false]);
  });

  it.each([
    ['daily', { daily_budget: 0 }],
    ['monthly', { monthly_budget: 0 }],
  ])('Budget tab marks only the %s projected percent N/A', (_n, costs) => {
    const html = renderToStaticMarkup(<BudgetProfileTab workload={bad(costs)} budget={budgetFor(w.id)!} now={NOW} />);
    expect(html.match(/\(N\/A of budget\)/g)).toHaveLength(1);
    expect(html.match(/N\/A \([^<]*approved budget/g)).toHaveLength(1);
  });
});

describe('monthly trajectory verdict and Budget tab bars', () => {
  it('verdict is N/A with a reason for an invalid monthly budget, never "projected 0%"', () => {
    const m = toMissionView(bad({ monthly_budget: 0 }));
    expect(m.trajectoryVerdict).toMatch(/^Forecast vs budget N\/A \(.*approved budget/i);
    expect(m.trajectoryVerdict).not.toMatch(/0%/);
    expect(toMissionView(w).trajectoryVerdict).toMatch(/\d+% of budget/);
  });

  it('bars do not announce 0: no aria-valuenow, N/A text alternative with the reason', () => {
    const html = renderToStaticMarkup(<BudgetProfileTab workload={bad({ daily_budget: 0, monthly_budget: 0 })} budget={budgetFor(w.id)!} now={NOW} />);
    expect(html).not.toContain('aria-valuenow');
    expect(html.match(/aria-valuetext="N\/A \([^"]*approved budget/g)).toHaveLength(2);
    const ok = renderToStaticMarkup(<BudgetProfileTab workload={w} budget={budgetFor(w.id)!} now={NOW} />);
    expect(ok).toContain('aria-valuenow');
  });
});

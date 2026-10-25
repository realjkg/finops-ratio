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

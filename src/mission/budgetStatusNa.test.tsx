// Pilot P0 (review round 3): an invalid budget gives a neutral "N/A" status, not
// labels or counts derived from a zero budget. Valid budgets keep their statuses.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WORKLOADS } from '@/data/workloads';
import { budgetFor } from '@/data/budgets';
import { computeBudgetStatus } from '@/lib/budgetStatus';
import { BudgetProfileTab } from '@/components/detail/BudgetProfileTab';
import { buildAIContext } from '@/ai/buildAIContext';
import { InitiativeCard } from '@/executive/InitiativeCard';
import { buildInitiativeBoard, toInitiativeView } from '@/executive/initiativeModel';
import { languageFor } from '@/lib/languageMap';
import { BUDGET_PROFILES } from '@/data/budgets';
import Reports from '../../pages/reports';
import { buildMissionBoard, toMissionView } from './missionModel';
import { MissionCard } from './MissionCard';
import { FleetHeader } from './FleetHeader';

// zustand serves its initial state during server rendering, so the page is
// rendered against a fake store holding the invalid-budget workload.
const fake = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('@/store/useStore', () => ({ useStore: (sel: (s: unknown) => unknown) => sel(fake.state) }));

const [first, ...rest] = WORKLOADS;
const zero = { ...first, costs: { ...first.costs, daily_budget: 0, monthly_budget: 0 } };
const NOW = new Date('2026-06-15T12:00:00Z');

describe('budget status', () => {
  it('is N/A with no breach days for an invalid budget; unchanged for a valid one', () => {
    const s = computeBudgetStatus(zero, budgetFor(first.id)!, NOW);
    expect([s.daily.status, s.monthly.status, s.monthly.daysUntilBreach]).toEqual(['na', 'na', null]);
    const ok = computeBudgetStatus(first, budgetFor(first.id)!, NOW);
    expect(['healthy', 'soft', 'hard', 'kill']).toContain(ok.daily.status);
    expect(['on_track', 'at_risk', 'breach_projected']).toContain(ok.monthly.status);
  });
});

describe('technical /mission', () => {
  it('card shows a neutral Budget N/A status, not CRITICAL', () => {
    const m = toMissionView(zero);
    expect(m.status).toBe('na');
    const html = renderToStaticMarkup(<MissionCard mission={m} onOpen={() => {}} />);
    expect(html).toContain('BUDGET N/A');
    expect(html).not.toMatch(/CRITICAL|Critical|ON TRACK|AT RISK/);
    expect(toMissionView(first).status).not.toBe('na');
  });

  it('needs-attention excludes it and a separate Budget N/A count is shown', () => {
    const { fleet } = buildMissionBoard([zero, ...rest]);
    expect(fleet.needsAttention).toBe(buildMissionBoard(rest).fleet.needsAttention);
    expect(fleet.budgetNa).toBe(1);
    expect(renderToStaticMarkup(<FleetHeader fleet={fleet} />)).toContain('Budget N/A: 1');
    expect(renderToStaticMarkup(<FleetHeader fleet={buildMissionBoard(rest).fleet} />)).not.toContain('Budget N/A:');
  });
});

describe('executive view', () => {
  it('card says Budget N/A, not Pending Approval, and pending count excludes it', () => {
    const v = toInitiativeView(zero);
    expect(v.status).toBe('budget_na');
    const html = renderToStaticMarkup(<InitiativeCard initiative={v} lang={languageFor('executive')} showLens />);
    expect(html).toContain('Budget N/A');
    expect(html).not.toMatch(/Pending Approval|action required/);
    expect(buildInitiativeBoard([zero, ...rest]).summary.pendingApproval).toBe(buildInitiativeBoard(rest).summary.pendingApproval);
  });
});

describe('/workloads Budget tab', () => {
  it('daily and monthly sections show N/A, no Healthy, no breach claims', () => {
    const html = renderToStaticMarkup(<BudgetProfileTab workload={zero} budget={budgetFor(first.id)!} now={NOW} />);
    expect(html.match(/>N\/A<\/span>/g)).toHaveLength(2);
    expect(html).not.toMatch(/Healthy|Breach projected|breach in/i);
  });
});

describe('/reports page', () => {
  it('shows N/A with the reason and Budget N/A status, not a bare %', () => {
    fake.state = { workloads: [zero, ...rest], budgets: BUDGET_PROFILES, alerts: [], now: NOW, simulation: null, simulationBusy: false };
    const html = renderToStaticMarkup(<Reports />);
    expect(html).toMatch(/<td>N\/A \([^<]*approved budget[^<]*\)<\/td>/);
    expect(html).toContain('<td>Budget N/A</td>');
    expect(html).not.toMatch(/<td>%<\/td>/);
  });
});

// Review round 4: N/A hides only what the invalid period implies; real alert-driven
// and valid-period signals stay in statuses and counts.
const fraud = WORKLOADS.find((x) => x.id === 'wl-fraud')!;
const dailyZero = { ...fraud, costs: { ...fraud.costs, daily_budget: 0 } };
const bothZero = { ...fraud, costs: { ...fraud.costs, daily_budget: 0, monthly_budget: 0 } };
const others = WORKLOADS.filter((x) => x.id !== 'wl-fraud');

describe('valid-period and alert signals survive an invalid budget', () => {
  it('daily budget invalid, monthly valid, critical alert: still CRITICAL and counted', () => {
    const m = toMissionView(dailyZero);
    expect(m.status).toBe('critical');
    expect(renderToStaticMarkup(<MissionCard mission={m} onOpen={() => {}} />)).toContain('CRITICAL');
    expect(toInitiativeView(dailyZero).status).toBe('pending_approval');
    expect(buildMissionBoard([dailyZero, ...others]).fleet.needsAttention).toBe(buildMissionBoard(WORKLOADS).fleet.needsAttention);
    expect(buildInitiativeBoard([dailyZero, ...others]).summary.pendingApproval).toBe(buildInitiativeBoard(WORKLOADS).summary.pendingApproval);
    expect(buildAIContext([dailyZero, ...others]).initiatives.map((i) => i.id)).toContain('wl-fraud');
  });

  it('both budgets invalid, critical alert: alert status still counts; the AI context says it is omitted', () => {
    expect(toMissionView(bothZero).status).toBe('critical');
    expect(buildMissionBoard([bothZero, ...others]).fleet.needsAttention).toBe(buildMissionBoard(WORKLOADS).fleet.needsAttention);
    expect(buildInitiativeBoard([bothZero, ...others]).summary.pendingApproval).toBe(buildInitiativeBoard(WORKLOADS).summary.pendingApproval);
    const ctx = buildAIContext([bothZero, ...others]);
    expect(ctx.initiatives.map((i) => i.id)).not.toContain('wl-fraud');
    expect(ctx.omitted).toEqual([{ id: 'wl-fraud', name: fraud.name, reason: expect.stringMatching(/approved budget/i) }]);
  });

  it('with nothing adverse left, an invalid budget is N/A, never on-track', () => {
    expect(toMissionView(bothZero, { alerts: [] }).status).toBe('na');
    expect(toMissionView(dailyZero, { alerts: [] }).status).not.toBe('nominal');
  });
});

describe('figures derived from an invalid budget', () => {
  it('Budget tab shows remaining N/A, not $0.00 remaining', () => {
    const html = renderToStaticMarkup(<BudgetProfileTab workload={dailyZero} budget={budgetFor('wl-fraud')!} now={NOW} />);
    expect(html).toContain('Remaining N/A');
    expect(html).not.toContain('$0.00 remaining');
  });

  it('a sub-cent seeded budget is N/A everywhere, with the below-a-cent reason', () => {
    const tiny = { ...first, costs: { ...first.costs, daily_budget: 0.004, monthly_budget: 0.004 } };
    const m = toMissionView(tiny, { alerts: [] });
    expect(m.fuelNa).toMatch(/below \$0\.01/);
    expect(m.trajectoryVerdict).toMatch(/N\/A \(.*below \$0\.01/);
    expect(m.status).toBe('na');
    expect(toInitiativeView(tiny).budgetConsumedNa).toMatch(/below \$0\.01/);
    const html = renderToStaticMarkup(<BudgetProfileTab workload={tiny} budget={budgetFor(first.id)!} now={NOW} />);
    expect(html).toMatch(/N\/A \([^<]*below \$0\.01/);
    expect(html).not.toMatch(/\d{5,}%/);
  });
});

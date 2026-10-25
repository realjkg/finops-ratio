// Pilot P0 (review round 3): an invalid budget gives a neutral "N/A" status, not
// labels or counts derived from a zero budget. Valid budgets keep their statuses.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WORKLOADS } from '@/data/workloads';
import { budgetFor } from '@/data/budgets';
import { computeBudgetStatus } from '@/lib/budgetStatus';
import { BudgetProfileTab } from '@/components/detail/BudgetProfileTab';
import { InitiativeCard } from '@/executive/InitiativeCard';
import { buildInitiativeBoard, toInitiativeView } from '@/executive/initiativeModel';
import { languageFor } from '@/lib/languageMap';
import { useStore } from '@/store/useStore';
import Reports from '../../pages/reports';
import { buildMissionBoard, toMissionView } from './missionModel';
import { MissionCard } from './MissionCard';
import { FleetHeader } from './FleetHeader';

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
    const saved = useStore.getState().workloads;
    useStore.setState({ workloads: [zero, ...saved.slice(1)] });
    try {
      const html = renderToStaticMarkup(<Reports />);
      expect(html).toMatch(/<td>N\/A \([^<]*approved budget[^<]*\)<\/td>/);
      expect(html).toContain('<td>Budget N/A</td>');
      expect(html).not.toMatch(/<td>%<\/td>/);
    } finally {
      useStore.setState({ workloads: saved });
    }
  });
});

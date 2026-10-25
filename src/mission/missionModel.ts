// Mission Board view-model (Ratio v2 Workstream 1, Layer 1). Pure functions that
// map the unchanged v1 engine outputs onto the "Mission Control" metaphor — no
// engine changes, no new math. Every field traces to a real data-model field or
// engine output per the spec mapping table:
//
//   Mission        -> one Workload (§2.1)
//   Fuel gauge     -> budget_consumed_ratio = daily_spend / daily_budget (§6, §10.4)
//   Fuel color     -> budget-bar scale (§10.4)
//   Trajectory     -> monthly forecast projected_eom vs budget (§6.2)
//   Mission clock  -> days_until_budget_breach (§6.4)
//   Mission status -> budget threshold status + forecast status + active alerts (§4, §5)
//   Value badge    -> value.value_ratio (R4 — always shown with the gauge)

import { ALERTS } from '@/data/alerts';
import { budgetFor } from '@/data/budgets';
import { DEMO_NOW, WORKLOADS } from '@/data/workloads';
import { computeBudgetStatus } from '@/lib/budgetStatus';
import { derivePortfolioRatio } from '@/lib/derive';
import { budgetConsumed } from '@/lib/metricContracts';
import type { ForecastStatus } from '@/lib/forecast';
import { headlineEvidenceStatus } from '@/lib/valueEvidence';
import { budgetColor, PROVIDER_LABEL, ratioColor } from '@/lib/scales';
import type { Alert, BudgetProfile, AlertSeverity, EvidenceStatus, Workload } from '@/types';

export interface ProjectionContext { budgets?: BudgetProfile[]; alerts?: Alert[]; now?: Date }

export type MissionStatus = 'nominal' | 'caution' | 'critical';

export interface MissionView {
  id: string;
  name: string;
  model: string;
  providerLabel: string;
  team: string;
  // Fuel gauge = daily budget consumed (actual today / approved daily budget).
  // `fuelPct` is the whole percent, not clamped; null = N/A with `fuelNa` as the
  // reason. `fuelRatio` is the raw ratio (0 when N/A, so do not display it).
  fuelRatio: number;
  fuelPct: number | null;
  fuelNa: string | null;
  fuelColor: string;
  spentToday: number;
  dailyBudget: number;
  remainingToday: number;
  // Value badge (R4) — never rendered without the gauge.
  valueRatio: number;
  valueColor: string;
  /** Provenance mark on the ratio — weakest value input's status (audit C1/C2). */
  valueEvidenceStatus?: EvidenceStatus;
  // Trajectory (monthly forecast).
  status: MissionStatus;
  forecast: ForecastStatus;
  projectedPctOfBudget: number;
  trajectoryVerdict: string;
  daysUntilBreach: number | null;
  alertCount: number;
}

export interface FleetSummary {
  fleetFuelRatio: number;
  fleetFuelPct: number | null;
  fleetFuelNa: string | null;
  fleetFuelColor: string;
  valueReturned: number;
  missionCount: number;
  needsAttention: number;
}

const STATUS_RANK: Record<MissionStatus, number> = { nominal: 0, caution: 1, critical: 2 };

// Daily fuel threshold -> status, per the 70/90/100 budget thresholds (§4).
function fuelStatus(fuelRatio: number): MissionStatus {
  if (fuelRatio >= 1) return 'critical';
  if (fuelRatio >= 0.7) return 'caution';
  return 'nominal';
}

// Monthly forecast status -> mission status (a breach projection is critical even
// when the partial day's fuel still reads low).
function forecastToStatus(forecast: ForecastStatus): MissionStatus {
  if (forecast === 'breach_projected') return 'critical';
  if (forecast === 'at_risk') return 'caution';
  return 'nominal';
}

function alertToStatus(severity: AlertSeverity | null): MissionStatus {
  if (severity === 'critical') return 'critical';
  if (severity === 'warning') return 'caution';
  return 'nominal';
}

function worst(...statuses: MissionStatus[]): MissionStatus {
  return statuses.reduce((a, b) => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a), 'nominal');
}

function maxAlertSeverity(workloadId: string, alerts: Alert[] = ALERTS): { severity: AlertSeverity | null; count: number } {
  const open = alerts.filter((a) => a.workload_id === workloadId && !a.acknowledged);
  let severity: AlertSeverity | null = null;
  for (const a of open) {
    if (a.severity === 'critical') severity = 'critical';
    else if (a.severity === 'warning' && severity !== 'critical') severity = 'warning';
    else if (a.severity === 'info' && severity === null) severity = 'info';
  }
  return { severity, count: open.length };
}

// One-line, plain-language trajectory verdict keyed to the forecast status.
function trajectoryVerdict(forecast: ForecastStatus, projectedPct: number, na: string | null): string {
  if (na) return `Forecast vs budget N/A (${na})`;
  const pct = Math.round(projectedPct * 100);
  switch (forecast) {
    case 'on_track':
      return `On course to land at ${pct}% of budget`;
    case 'at_risk':
      return `Tight — landing at ${pct}% of budget`;
    case 'breach_projected':
      return `Overrun — projected ${pct}% of budget, needs a decision`;
  }
}

export function toMissionView(workload: Workload, context: ProjectionContext = {}): MissionView {
  const budget = context.budgets ? context.budgets.find(b => b.workload_id === workload.id) : budgetFor(workload.id);
  if (!budget) throw new Error(`No budget profile for workload ${workload.id}`);

  const status = computeBudgetStatus(workload, budget, context.now ?? DEMO_NOW);
  const fuelRatio = status.daily.pctUsed;
  const { severity, count } = maxAlertSeverity(workload.id, context.alerts);
  const fuel = budgetConsumed(status.daily.spentToday, status.daily.dailyBudget);

  return {
    id: workload.id,
    name: workload.name,
    model: workload.model,
    providerLabel: PROVIDER_LABEL[workload.model_provider],
    team: workload.team,
    fuelRatio,
    fuelPct: fuel.pct === null ? null : Math.round(fuel.pct),
    fuelNa: fuel.naReason,
    fuelColor: budgetColor(fuelRatio),
    spentToday: status.daily.spentToday,
    dailyBudget: status.daily.dailyBudget,
    remainingToday: status.daily.remaining,
    valueRatio: workload.value.value_ratio,
    valueColor: ratioColor(workload.value.value_ratio),
    valueEvidenceStatus: headlineEvidenceStatus(workload.value),
    status: worst(fuelStatus(fuelRatio), forecastToStatus(status.monthly.status), alertToStatus(severity)),
    forecast: status.monthly.status,
    projectedPctOfBudget: status.monthly.projectedPctOfBudget,
    trajectoryVerdict: trajectoryVerdict(status.monthly.status, status.monthly.projectedPctOfBudget, status.monthly.pctUsedNa),
    daysUntilBreach: status.monthly.daysUntilBreach,
    alertCount: count,
  };
}

export function buildMissionBoard(
  workloads: Workload[] = WORKLOADS,
  context: ProjectionContext = {},
): { missions: MissionView[]; fleet: FleetSummary } {
  const missions = workloads.map(w => toMissionView(w, context));

  // Fleet fuel = aggregate daily budget consumed across the fleet, matching the
  // per-mission daily fuel gauge.
  const totalSpentToday = missions.reduce((sum, m) => sum + m.spentToday, 0);
  const totalDailyBudget = missions.reduce((sum, m) => sum + m.dailyBudget, 0);
  const fleetFuelRatio = totalDailyBudget > 0 ? totalSpentToday / totalDailyBudget : 0;
  // One invalid mission budget makes the aggregate meaningless: N/A, not a partial sum.
  const fleetFuelNa = missions.find((m) => m.fuelNa)?.fuelNa ?? budgetConsumed(totalSpentToday, totalDailyBudget).naReason;

  const portfolio = derivePortfolioRatio(workloads);
  const needsAttention = missions.filter((m) => m.status !== 'nominal').length;

  return {
    missions,
    fleet: {
      fleetFuelRatio,
      fleetFuelPct: fleetFuelNa ? null : Math.round(fleetFuelRatio * 100),
      fleetFuelNa,
      fleetFuelColor: budgetColor(fleetFuelRatio),
      valueReturned: portfolio.portfolio_ratio,
      missionCount: missions.length,
      needsAttention,
    },
  };
}


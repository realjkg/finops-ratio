// Test-only oracle for the Frank mock. Every number here is computed directly
// from the bundled seed (WORKLOADS, ALERTS, MODEL_REGISTRY) with its own
// arithmetic. It must NEVER import anything from src/ai/mock or MockAIClient:
// the point is an independent second derivation to compare answers against.

import { ALERTS } from '@/data/alerts';
import { MODEL_REGISTRY } from '@/data/models';
import { WORKLOADS } from '@/data/workloads';
import type { Workload } from '@/types';

export const usd = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export const x1 = (r: number): string => `${r.toFixed(1)}×`;

export const TEAMS = [...new Set(WORKLOADS.map((w) => w.team))];
export const wl = (id: string): Workload => {
  const w = WORKLOADS.find((x) => x.id === id);
  if (!w) throw new Error(`oracle: no workload ${id}`);
  return w;
};

export interface Roll {
  spend: number;
  value: number;
  ratio: number;
  n: number;
  members: Workload[];
}
export function roll(ws: Workload[]): Roll {
  const spend = ws.reduce((s, w) => s + w.costs.monthly_spend, 0);
  const value = ws.reduce((s, w) => s + w.value.total_value, 0);
  return { spend, value, ratio: spend > 0 ? value / spend : 0, n: ws.length, members: ws };
}
export const team = (name: string): Roll => roll(WORKLOADS.filter((w) => w.team === name));
export const model = (name: string): Roll => roll(WORKLOADS.filter((w) => w.model === name));
export const portfolio = (): Roll => roll(WORKLOADS);

export const teamsByCost = (): string[] =>
  [...TEAMS].sort((a, b) => team(b).spend - team(a).spend);
export const teamsByRatio = (): string[] =>
  [...TEAMS].sort((a, b) => team(b).ratio - team(a).ratio);

export const alertsOf = (id: string) => ALERTS.filter((a) => a.workload_id === id);

// Seeded MoM trend: prior = spend / (1 + pct/100); change = spend - prior.
export function impliedMonthlyChange(ws: Workload[]): number {
  return ws.reduce(
    (s, w) => s + (w.costs.monthly_spend - w.costs.monthly_spend / (1 + w.cost_trend_pct / 100)),
    0,
  );
}

// --- Migration oracle (independent re-derivation, defaults copied by hand) ---
export const DEFAULTS = {
  gpuHourlyUsd: 2.5,
  minGpus: 2,
  utilisation: 0.5,
  tokensPerSecondPerGpu: 1000,
  hoursPerMonth: 730,
  opsOverheadPct: 0.25,
  migrationOneTimeUsd: 25000,
};
export interface MigOverrides {
  gpuHourlyUsd?: number;
  gpuCount?: number;
  migrationOneTimeUsd?: number;
}
export function migrate(ws: Workload[], o: MigOverrides = {}) {
  let tokens = 0;
  let api = 0;
  for (const w of ws) {
    const m = MODEL_REGISTRY.find((r) => r.model_name === w.model);
    if (!m) throw new Error(`oracle: model ${w.model}`);
    const inT = w.costs.tokens_in_today * 30;
    const outT = w.costs.tokens_out_today * 30;
    const cT = w.costs.tokens_cached_today * 30;
    tokens += inT + outT + cT;
    api +=
      (inT / 1e6) * m.pricing.input_per_1m +
      (outT / 1e6) * m.pricing.output_per_1m +
      (cT / 1e6) * (m.pricing.cached_input_per_1m ?? m.pricing.input_per_1m * 0.25);
  }
  const rate = o.gpuHourlyUsd ?? DEFAULTS.gpuHourlyUsd;
  const perGpu =
    DEFAULTS.tokensPerSecondPerGpu * DEFAULTS.utilisation * 3600 * DEFAULTS.hoursPerMonth;
  const gpus = o.gpuCount ?? Math.max(DEFAULTS.minGpus, Math.ceil(tokens / perGpu));
  const gpuCost = gpus * rate * DEFAULTS.hoursPerMonth;
  const selfHost = gpuCost * (1 + DEFAULTS.opsOverheadPct);
  const saving = api - selfHost;
  const oneTime = o.migrationOneTimeUsd ?? DEFAULTS.migrationOneTimeUsd;
  return {
    tokens,
    api,
    gpus,
    selfHost,
    saving,
    oneTime,
    payback: saving > 0 ? oneTime / saving : null,
    breakEvenTokens: api > 0 ? (selfHost * tokens) / api : null,
    coverage: (gpus * perGpu) / tokens,
  };
}

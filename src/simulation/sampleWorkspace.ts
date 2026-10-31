// The read-only SAMPLE workspace behind /simulation when server simulation is off (public deployments).
// Pure view-models over the bundled synthetic seed (src/data): no data request after the page loads, no storage, no clock.
// Money is summed and shown as integer cents, so no floating-point sum reaches the screen.
import { ALERTS } from '@/data/alerts';
import { BUDGET_PROFILES } from '@/data/budgets';
import { MODEL_REGISTRY } from '@/data/models';
import { WORKLOADS } from '@/data/workloads';
import type { Persona } from '@/lib/persona';

export const SAMPLE_LABEL = 'Synthetic sample data · nothing is saved';
export const SAMPLE_PERSONAS: Record<Persona, { title: string; blurb: string }> = {
  executive: { title: 'Executive', blurb: 'Review value and budget risk across every workload.' },
  technical: { title: 'Technical', blurb: 'Find the biggest cost drivers and the alerts behind them.' },
  procurement: { title: 'Procurement', blurb: 'Compare model prices and see where spend is concentrated.' },
};

const cents = (usd: number) => Math.round(usd * 100);

/** Integer cents as "$13,632.00" (no floats). */
export function formatCents(c: number): string {
  const abs = Math.abs(c);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${c < 0 ? '-' : ''}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

export interface SampleRow { label: string; detail: string; value: string; flag?: 'risk' | 'ok' }
export interface SampleView {
  persona: Persona;
  stats: { label: string; value: string }[];
  heading: string;
  rows: SampleRow[];
  note: string;
}

const budgetShare = (spendCents: number, budgetCents: number) => (budgetCents > 0 ? Math.round((spendCents * 100) / budgetCents) : 0);

export function sampleView(persona: Persona): SampleView {
  const spend = WORKLOADS.map((w) => ({ w, c: cents(w.costs.monthly_spend), b: cents(w.costs.monthly_budget) }));
  const total = spend.reduce((s, x) => s + x.c, 0);
  const budget = spend.reduce((s, x) => s + x.b, 0);
  const open = ALERTS.filter((a) => !a.acknowledged);
  const critical = open.filter((a) => a.severity === 'critical');
  const byName = new Map(WORKLOADS.map((w) => [w.id, w.name]));
  if (persona === 'executive') {
    return {
      persona,
      stats: [
        { label: 'Monthly AI spend', value: formatCents(total) },
        { label: 'Budget used', value: `${budgetShare(total, budget)}% of ${formatCents(budget)}` },
        { label: 'Critical alerts', value: String(critical.length) },
      ],
      heading: 'Budget risk by workload',
      rows: [...spend].sort((a, b) => budgetShare(b.c, b.b) - budgetShare(a.c, a.b)).slice(0, 5).map(({ w, c, b }) => ({
        label: w.name, detail: `${w.team} · ${formatCents(c)} of ${formatCents(b)}`, value: `${budgetShare(c, b)}%`, flag: budgetShare(c, b) >= 90 ? 'risk' : 'ok',
      })),
      note: 'Spend is each workload’s monthly run rate in the synthetic seed. (watch) means at or above 90% of its budget.',
    };
  }
  if (persona === 'technical') {
    return {
      persona,
      stats: [
        { label: 'Workloads', value: String(WORKLOADS.length) },
        { label: 'Open alerts', value: String(open.length) },
        { label: 'Budget profiles', value: String(BUDGET_PROFILES.length) },
      ],
      heading: 'Largest cost drivers',
      rows: [...spend].sort((a, b) => b.c - a.c).slice(0, 5).map(({ w, c }) => ({
        label: w.name, detail: `${w.model} · ${w.team}`, value: formatCents(c), flag: w.cost_trend_pct > 15 ? 'risk' : undefined,
      })),
      note: `(watch) means monthly spend is up more than 15% on last month. Open alerts: ${open.slice(0, 2).map((a) => `${byName.get(a.workload_id) ?? a.workload_id} (${a.severity})`).join('; ') || 'none'}.`,
    };
  }
  const models = [...MODEL_REGISTRY].sort((a, b) => a.pricing.input_per_1m - b.pricing.input_per_1m);
  return {
    persona,
    stats: [
      { label: 'Models compared', value: String(models.length) },
      { label: 'Monthly AI spend', value: formatCents(total) },
      { label: 'Cheapest input', value: `$${models[0].pricing.input_per_1m} per 1M tokens` },
    ],
    heading: 'Model prices (per 1M tokens, input / output)',
    rows: models.slice(0, 6).map((m) => ({
      label: m.display_name, detail: `${m.provider} · ${m.cost_tier}`, value: `$${m.pricing.input_per_1m} / $${m.pricing.output_per_1m}`,
    })),
    note: 'Prices are the synthetic registry’s list rates, not a quote.',
  };
}

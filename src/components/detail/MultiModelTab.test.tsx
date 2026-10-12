// MultiModelTab renders the Multi-Model guardrail: a projected-overshoot line
// (amount + % over) for candidate models that break the workload's daily
// budget at today's volume, and no warning when every candidate fits. Store
// defaults put the tab in read-only (non-simulation) mode — the guardrail must
// be visible there too, since the comparison is where a switch is chosen.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MultiModelTab } from './MultiModelTab';
import { MODEL_REGISTRY } from '@/data/models';
import { WORKLOADS } from '@/data/workloads';
import type { Workload } from '@/types';

function byId(id: string): Workload {
  const w = WORKLOADS.find((x) => x.id === id);
  if (!w) throw new Error(`missing seed workload: ${id}`);
  return w;
}

describe('MultiModelTab — projected-overshoot guardrail', () => {
  it('warns with amount + % over for budget-breaking candidates (Fraud Triage, $160 budget)', () => {
    const html = renderToStaticMarkup(
      <MultiModelTab workload={byId('wl-fraud')} models={MODEL_REGISTRY} />,
    );
    expect(html).toContain('Projected overspend');
    expect(html).toContain('daily budget $160');
    expect(html).toContain('$837/day'); // ultra-tier GPT-4.5 at Fraud Triage volume
    expect(html).toContain('+423%'); // percent over the daily budget
  });

  it('stays quiet when no candidate breaks the daily budget', () => {
    const roomy = byId('wl-fraud');
    const noOvershoot: Workload = {
      ...roomy,
      costs: { ...roomy.costs, daily_budget: 1_000_000 },
    };
    const html = renderToStaticMarkup(
      <MultiModelTab workload={noOvershoot} models={MODEL_REGISTRY} />,
    );
    expect(html).not.toContain('Projected overspend');
  });
});

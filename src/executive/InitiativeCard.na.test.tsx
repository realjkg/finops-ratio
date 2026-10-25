// Pilot P0: an N/A budget metric renders as N/A with its reason and an empty
// bar, never as 0%.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InitiativeCard } from './InitiativeCard';
import { languageFor } from '@/lib/languageMap';
import { WORKLOADS } from '@/data/workloads';
import { toInitiativeView } from './initiativeModel';

const w = WORKLOADS[0];
const render = (budget: number) =>
  renderToStaticMarkup(
    <InitiativeCard initiative={toInitiativeView({ ...w, costs: { ...w.costs, monthly_budget: budget } })} lang={languageFor('executive')} showLens={false} />,
  );

describe('InitiativeCard budget consumed', () => {
  it('shows N/A with the reason when the approved budget is invalid', () => {
    const html = render(0);
    expect(html).toMatch(/N\/A/);
    expect(html).toMatch(/approved budget/i);
    expect(html).not.toContain('aria-valuenow="0"');
  });
  it('caps only the bar width for an over-budget workload, not the printed percent', () => {
    const html = render(1);
    expect(html).toMatch(/width:100%/);
    expect(html).toMatch(/\d{3,}%/);
  });
});

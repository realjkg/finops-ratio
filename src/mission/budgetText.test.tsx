// Release blocker D2: an invalid budget is never printed as currency or as a
// denominator ("$308 / $0.00", "$0.01", "-$5.00", "$NaN"). Spend is shown with "budget N/A".
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WORKLOADS } from '@/data/workloads';
import { MissionCard } from './MissionCard';
import { FuelAndValue } from './FuelAndValue';
import { toMissionView } from './missionModel';
import { MultiModelTab } from '@/components/detail/MultiModelTab';
import { MODEL_REGISTRY } from '@/data/models';

const w = WORKLOADS.find((x) => x.id === 'wl-fraud')!;
const withDaily = (daily_budget: number) => ({ ...w, costs: { ...w.costs, daily_budget } });

describe.each([[0], [-5], [Number.NaN], [0.0099], [0.004]])('invalid daily budget %s', (b) => {
  const m = toMissionView(withDaily(b), { alerts: [] });
  it('mission card shows spend and "budget N/A", no denominator or currency budget', () => {
    const html = renderToStaticMarkup(<MissionCard mission={m} onOpen={() => {}} />);
    expect(html).toContain('budget N/A');
    expect(html).not.toMatch(/ \/ \$|\$NaN|-\$\d|\$0\.0\d<|spent of \$/);
  });
  it('fuel gauge text alternative has no budget amount', () => {
    const html = renderToStaticMarkup(<FuelAndValue {...m} />);
    expect(html).not.toMatch(/spent of|\$NaN|-\$\d/);
    expect(html).toContain('budget N/A');
  });
  it('multi-model guardrail does not print the invalid daily budget', () => {
    const html = renderToStaticMarkup(<MultiModelTab workload={withDaily(b)} models={MODEL_REGISTRY} />);
    expect(html).not.toMatch(/daily budget \$|\$NaN|-\$\d/);
    expect(html).toContain('Daily budget N/A');
  });
});

describe('valid daily budget is unchanged', () => {
  it('still prints spend / budget', () => {
    const m = toMissionView(w, { alerts: [] });
    expect(renderToStaticMarkup(<FuelAndValue {...m} />)).toContain('/ $160');
  });
});

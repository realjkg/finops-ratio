import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WORKLOADS } from '@/data/workloads';
import { LANGUAGE_MAP } from '@/lib/languageMap';
import { InitiativeCard } from './InitiativeCard';
import { toInitiativeView } from './initiativeModel';

const modeled = WORKLOADS[0];
const recorded = { ...modeled, costs: { ...modeled.costs, recorded_mtd: modeled.costs.monthly_spend } };
const html = (w: typeof modeled, persona: keyof typeof LANGUAGE_MAP) =>
  renderToStaticMarkup(<InitiativeCard initiative={toInitiativeView(w)} lang={LANGUAGE_MAP[persona]} showLens={false} />);

describe('budget label follows the cost source for every persona', () => {
  it('modeled cost is an estimate for the executive, procurement and technical lenses', () => {
    expect(html(modeled, 'executive')).toContain('>Estimated budget consumption to date<');
    expect(html(modeled, 'procurement')).toContain('>Estimated budget · month to date<');
    expect(html(modeled, 'technical')).toContain('>Estimated fuel · month to date<');
    for (const p of ['executive', 'procurement', 'technical'] as const) expect(html(modeled, p)).not.toMatch(/>Budget used|>Budget · month|>Fuel · month/);
  });
  it('recorded cost earns Budget used (executive) with its basis, and the plain persona terms elsewhere', () => {
    expect(html(recorded, 'executive')).toContain('>Budget used · month to date · Basis: simulation postings<');
    expect(html(recorded, 'procurement')).toContain('>Budget · month to date<');
    expect(html(recorded, 'technical')).toContain('>Fuel · month to date<');
  });
});

// The /demo landing figure and the attribution value line carry the portfolio's computed status.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttributionPage } from '@/attribution/AttributionPage';
import Demo from '../../pages/demo';
import { portfolioEvidence, EVIDENCE_META } from './valueEvidence';
import { WORKLOADS } from '@/data/workloads';

vi.mock('@/lib/persona', async (orig) => ({ ...(await orig<typeof import('@/lib/persona')>()), usePersona: () => ({ persona: 'executive', setPersona: () => {} }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, pathname: '/demo', isReady: true, push: async () => true, replace: async () => true }) }));

const label = EVIDENCE_META[portfolioEvidence(WORKLOADS.map((w) => w.value)).status!].label;

describe('portfolio Value / cost figures outside the simulation', () => {
  it('/demo: the Portfolio Value / cost metric has an explain mark', () => {
    const html = renderToStaticMarkup(<Demo />);
    expect(html).toMatch(new RegExp(`Portfolio Value / cost[^]*?<button[^>]*aria-expanded="false"[^>]*>${label}</button>`));
  });
  it('attribution: the value-context line has an explain mark in parentheses', () => {
    const html = renderToStaticMarkup(<AttributionPage />);
    expect(html).toMatch(new RegExp(`cost this month \\([^]*?<button[^>]*>${label}</button>[^]*?\\)\\.`));
  });
});

// Honesty: no fake freshness; the seeded spend is named AI spend, stamped with the seed's own as-of date.
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DEMO_NOW } from '@/data/workloads';
import { PersonaProvider } from '@/components/PersonaProvider';
import { InitiativeDashboard } from './InitiativeDashboard';
import { SpendSummaryBar } from './SpendSummaryBar';

const bar = { totalMonthlySpend: 41212, projectedSavings: 4800, initiativesActive: 11, pendingApproval: 2 };
const html = renderToStaticMarkup(<SpendSummaryBar summary={bar} />);

it('stamps the seed as-of date derived from DEMO_NOW, never a relative freshness claim', () => {
  expect(html).toContain(`Seeded dataset as of ${DEMO_NOW.toISOString().slice(0, 10)}`);
  expect(html).not.toMatch(/min ago|Updated/i);
});

it('says AI spend (tile and dashboard subtitle), never cloud spend', () => {
  const page = renderToStaticMarkup(<PersonaProvider><InitiativeDashboard /></PersonaProvider>);
  expect(html).toContain('AI spend');
  expect(page).toContain('AI spend, value, and approvals');
  expect(html + page).not.toMatch(/cloud spend/i);
});

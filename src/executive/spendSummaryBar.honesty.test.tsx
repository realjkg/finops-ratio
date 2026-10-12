// Honesty: the executive headline strip must not claim freshness it does not have, and must name
// what the number is (seeded AI inference spend), stamped with the seed's own as-of date.
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DEMO_NOW } from '@/data/workloads';
import { PersonaProvider } from '@/components/PersonaProvider';
import { InitiativeDashboard } from './InitiativeDashboard';
import { SpendSummaryBar } from './SpendSummaryBar';

const html = renderToStaticMarkup(
  <SpendSummaryBar summary={{ totalMonthlySpend: 41212, projectedSavings: 4800, initiativesActive: 11, pendingApproval: 2 }} />,
);

it('stamps the seed as-of date derived from DEMO_NOW, never a relative freshness claim', () => {
  expect(html).toContain(`Seeded dataset as of ${DEMO_NOW.toISOString().slice(0, 10)}`);
  expect(html).not.toMatch(/min ago|Updated/i);
});

it('labels the spend as AI spend, not total cloud spend', () => {
  expect(html).toContain('AI spend');
  expect(html).not.toMatch(/cloud spend/i);
});

it('the dashboard subtitle says AI spend, never Cloud spend', () => {
  const page = renderToStaticMarkup(<PersonaProvider><InitiativeDashboard /></PersonaProvider>);
  expect(page).toContain('AI spend, value, and approvals');
  expect(page).not.toMatch(/Cloud spend/i);
});

// User-facing copy never shows config ids or internal planning references, and
// the signed-out simulation pages explain themselves and offer a way forward.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WORKLOADS } from '@/data/workloads';
import { budgetFor } from '@/data/budgets';
import { BudgetProfileTab } from '@/components/detail/BudgetProfileTab';
import { SignInRequired } from '@/simulation/SignInRequired';

const NOW = new Date('2026-06-15T12:00:00Z');
const RAW_ACTION = /alert_escalate|throttle_\d+pct|pause_workload|alert_only/;

describe('budget thresholds', () => {
  it('name every configured breach action in words', () => {
    for (const w of WORKLOADS) {
      const html = renderToStaticMarkup(<BudgetProfileTab workload={w} budget={budgetFor(w.id)!} now={NOW} />);
      expect(html).not.toMatch(RAW_ACTION);
    }
    const w = WORKLOADS.find((x) => budgetFor(x.id)?.on_hard_breach === 'throttle_50pct')!;
    const html = renderToStaticMarkup(<BudgetProfileTab workload={w} budget={budgetFor(w.id)!} now={NOW} />);
    expect(html).toContain('Escalate · Throttle 50%');
  });
});

describe('SignInRequired', () => {
  it('explains the page, links to sign-in and back to the demo', () => {
    const html = renderToStaticMarkup(<SignInRequired title="Agent workflows" detail="Queue an evidence review." />);
    expect(html).toContain('<h1');
    expect(html).toContain('Agent workflows');
    expect(html).toContain('Queue an evidence review.');
    expect(html).toMatch(/href="\/simulation"[^>]*>Choose a simulated identity</);
    expect(html).toMatch(/href="\/demo"[^>]*>Back to the seeded demo</);
    expect(html).toContain('aria-busy="false"');
  });

  it('says it is restoring while a session is loading, and keeps the sign-in link', () => {
    const html = renderToStaticMarkup(<SignInRequired title="Customer workflow" detail="Detail text" loading />);
    expect(html).toContain('Restoring your workspace…');
    expect(html).not.toContain('Detail text');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Choose a simulated identity');
  });
});

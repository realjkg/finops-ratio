// Release blocker D1: the mock AI keeps the headline totals and the opportunities
// list when a workload has an invalid monthly budget (negative, NaN over the wire,
// sub-cent, zero) or only an invalid daily budget. "Budget N/A" is said only for the
// budget-percent claims, never as a reason to drop dollars.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKLOADS } from '@/data/workloads';
import { buildAIContext } from '../buildAIContext';
import { last, restoreClock, useFastClock } from './__testkit__/ask';

beforeAll(useFastClock);
afterAll(restoreClock);

const fraud = WORKLOADS.find((x) => x.id === 'wl-fraud')!;
const ctxFor = (costs: Record<string, number>) =>
  JSON.parse(JSON.stringify(buildAIContext(WORKLOADS.map((x) => (x.id === 'wl-fraud' ? { ...fraud, costs: { ...fraud.costs, ...costs } } : x)))));

describe.each([
  ['negative', { monthly_budget: -5 }],
  ['NaN (null over the wire)', { monthly_budget: NaN }],
  ['0.0099', { monthly_budget: 0.0099 }],
  ['0.004', { monthly_budget: 0.004 }],
  ['zero', { monthly_budget: 0 }],
  ['daily-only invalid', { daily_budget: 0 }],
])('Fraud monthly budget %s', (_n, costs) => {
  const ctx = ctxFor(costs);
  it('summary totals equal the headline', async () => {
    const text = await last(['Summarize the portfolio'], ctx);
    expect(text).toContain('Total spend: $41,212/mo across 11 initiatives.');
    expect(text).toContain('Projected savings: $2,408/mo.');
  });
  it('the savings answer keeps the headline and lists Fraud', async () => {
    const text = await last(['How much can we save?'], ctx);
    expect(text).toContain('**$2,408/mo**');
    expect(text).toContain('• Fraud Triage Agent: $840/mo');
  });
});

// Regression: the five existing intents keep their EXACT current outputs for
// their current example questions (captured from main before this change),
// and the two screenshot failures are fixed.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockAIClient } from '@/ai/MockAIClient';
import { CTX, UNSUPPORTED, chat, last, restoreClock, useFastClock } from './__testkit__/ask';

beforeAll(useFastClock);
afterAll(restoreClock);

const HELP = [
  "I'm Frank Coster, your FinOps accountability partner. I reason over your initiative portfolio — value ratios, budget status, and savings opportunities. Try:",
  '• "Which initiatives are at risk?"',
  '• "What\'s driving cloud cost?"',
  '• "How much can we save?"',
  '• "Summarize the portfolio"',
].join('\n');

const AT_RISK = [
  '6 initiative(s) need attention:',
  '• **Customer Support Agent** — At Risk, $13,632/mo at 13.8× return (value evidence: assumed)',
  '• **Sales Copilot** — At Risk, $6,800/mo at 7.4× return (value evidence: assumed)',
  '• **Code Review Bot** — At Risk, $2,400/mo at 20.8× return (value evidence: assumed)',
  '• **Document Summarizer** — At Risk, $1,150/mo at 5.3× return (value evidence: assumed)',
  '• **Marketing Content Gen** — Pending Approval, $4,900/mo at 2.3× return (value evidence: assumed), $1,568/mo savings identified',
  '• **Fraud Triage Agent** — Pending Approval, $4,200/mo at -0.2× return (value evidence: assumed), $840/mo savings identified',
  'Total portfolio: $41,212/mo across 11 initiatives.',
].join('\n');

const COST_DRIVER =
  'The largest cost driver is **Customer Support Agent** at $13,632/mo (13.8× return (value evidence: assumed) — R4: cost paired with value). It is currently **At Risk** — consider a budget review. Cache hit rate: 16.5% of its input tokens are billed at the cached rate.';

const SAVINGS = [
  'Projected savings across the portfolio: **$2,408/mo**.',
  'Top opportunities by initiative:',
  '• Marketing Content Gen: $1,568/mo',
  '• Fraud Triage Agent: $840/mo',
].join('\n');

const SUMMARY = [
  '**Portfolio summary — 2026-06-25**',
  'Total spend: $41,212/mo across 11 initiatives.',
  'Status: 5 on track, 2 pending approval.',
  'Projected savings: $2,408/mo.',
].join('\n');

describe('legacy intents are byte-identical for their example questions', () => {
  it.each([
    ['Which initiatives are at risk?', AT_RISK],
    ["What's driving cloud cost?", COST_DRIVER],
    ['How much can we save?', SAVINGS],
    ['Summarize the portfolio', SUMMARY],
    ['hello', HELP],
    ['help', HELP],
  ])('%s', async (q, expected) => {
    expect(await last([q])).toBe(expected);
  });

  it('keeps the public API: mode, provider tag, and empty history -> help', async () => {
    const c = new MockAIClient();
    expect(c.mode).toBe('mock');
    const p = c.chat([], CTX);
    await vi.advanceTimersByTimeAsync(300);
    expect((await p).message.content).toBe(HELP);
    const r = await chat([{ role: 'user', content: 'Which initiatives are at risk?' }]);
    expect(r.provider).toBe('mock');
    expect(r.referenced).toContain('wl-fraud');
  });

  it('legacy keyword variants still route to their intents', async () => {
    expect(await last(['what is at risk?'])).toBe(AT_RISK);
    expect(await last(['which one is the most expensive'])).toBe(COST_DRIVER);
    expect(await last(['give me an overview'])).toBe(SUMMARY);
  });
});

describe('screenshot failures', () => {
  it('"Who or which team is driving up the highest cost?" answers with a TEAM, not a workload', async () => {
    const t = await last(['Who or which team is driving up the highest cost?']);
    expect(t).toContain('**Highest-cost team: CX Engineering**');
    expect(t).not.toContain('The largest cost driver is');
  });

  it('the follow-up "What about its workload activities and ROI?" drills into that team, not the help text', async () => {
    const t = await last([
      'Who or which team is driving up the highest cost?',
      'What about its workload activities and ROI?',
    ]);
    expect(t).not.toBe(HELP);
    expect(t).not.toContain("I'm Frank Coster");
    expect(t).not.toContain(UNSUPPORTED);
    expect(t).toContain('**Workloads — CX Engineering (team)**');
    expect(t).toContain('Customer Support Agent');
    expect(t).toContain('Support Triage Router');
    expect(t).toMatch(/13\.8×/);
    expect(t).toMatch(/10\.5×/);
  });

  it('the same follow-up with NO prior turn asks which one, instead of the help text', async () => {
    const t = await last(['What about its workload activities and ROI?']);
    expect(t).toContain('Which one do you mean?');
    expect(t).not.toBe(HELP);
  });
});

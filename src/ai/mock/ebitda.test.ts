// EBITDA impact after spend goes down. The seed holds NO revenue / EBITDA /
// margin baseline, so the mock may only (a) state the accounting identity under
// a labelled assumption and (b) compute percentages from a baseline the USER
// typed. Expected numbers are hand-derived in comments and via the oracle.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { impliedMonthlyChange, team, usd } from './__testkit__/oracle';
import { last, restoreClock, useFastClock } from './__testkit__/ask';

beforeAll(useFastClock);
afterAll(restoreClock);

const Q = 'What is the EBITDA impact for the Platform Eng group if spend went down $2,000 a month';

describe('EBITDA impact', () => {
  it('without a baseline: identity only, labelled assumption, names the missing input', async () => {
    const t = await last([`${Q}?`]);
    // $2,000/mo x 12 = $24,000/yr, one-for-one, pre-tax.
    expect(t).toContain('**EBITDA impact — Platform Eng**');
    expect(t).toContain('$2,000/mo');
    expect(t).toContain(`${usd(24000)}/yr`);
    expect(t).toContain('EBITDA improves by');
    expect(t).toContain('pre-tax');
    expect(t).toContain('one-for-one');
    expect(t).toContain('(assumption)');
    expect(t).toMatch(/operating expense/);
    expect(t).toMatch(/No (EBITDA|revenue)[^.]*baseline[^.]*seeded data/i);
    expect(t).toMatch(/group EBITDA|revenue/);
    // never fabricate a baseline-derived figure
    expect(t).not.toMatch(/New EBITDA/);
    expect(t).not.toMatch(/\bpp\b/);
    expect(t).not.toMatch(/NaN|Infinity/);
    expect(t).toContain('(value evidence: assumed)');
  });

  it('with a user EBITDA baseline: computes the % uplift (hand: 24,000 / 4,200,000 = 0.571%)', async () => {
    const t = await last([`${Q}, with a group EBITDA of $4.2M?`]);
    expect(t).toContain('Baseline: group EBITDA $4,200,000 (stated by you');
    expect(t).toContain('annual');
    expect(t).toContain('New EBITDA $4,224,000');
    expect(t).toContain('+0.6%');
    expect(t).not.toContain('No EBITDA baseline');
  });

  it('with revenue only: margin points (hand: 24,000 / 20,000,000 = 0.12 pp)', async () => {
    const t = await last([`${Q} and revenue of $20M?`]);
    expect(t).toContain('Revenue $20,000,000 (stated by you');
    expect(t).toContain('+0.12 pp');
    expect(t).not.toMatch(/New EBITDA \$/);
  });

  it('with EBITDA and revenue: before/after margin (hand: 4.2M/20M = 21.00% -> 4.224M/20M = 21.12%)', async () => {
    const t = await last([`${Q}. Group EBITDA of $4,200,000 on revenue $20M`]);
    expect(t).toContain('21.00%');
    expect(t).toContain('21.12%');
    expect(t).toContain('+0.12 pp');
  });

  it('percent reductions are taken against current seeded spend (hand: 20% x 4,270 = 854/mo = 10,248/yr)', async () => {
    const t = await last(['What is the EBITDA impact for the Legal team if spend went down 20%?']);
    expect(t).toContain('20% of the group’s current seeded monthly spend');
    expect(t).toContain(`${usd(854)}/mo`);
    expect(t).toContain(`${usd(10248)}/yr`);
    expect(t).toContain('(assumption)');
  });

  it('no stated amount, spend really fell (Platform Eng MoM trend): uses the seeded trend and labels it', async () => {
    const team_ = team('Platform Eng').members;
    const fall = -impliedMonthlyChange(team_); // hand: 2400-2400/0.968 + 640-640/1.055 = -45.97
    expect(fall).toBeGreaterThan(45);
    const t = await last(['What is the EBITDA effect on Platform Eng now that spending went down?']);
    expect(t).toContain(`${usd(fall)}/mo`);
    expect(t).toContain(`${usd(fall * 12)}/yr`);
    expect(t).toMatch(/seeded MoM trend/);
    expect(t).toMatch(/not a ledger measurement/);
  });

  it('no stated amount, spend rose but savings exist (Marketing): projected scenario, not "went down"', async () => {
    const t = await last(['EBITDA impact for Marketing after spending went down']);
    expect(t).toContain(`${usd(1568)}/mo`);
    expect(t).toContain(`${usd(1568 * 12)}/yr`);
    expect(t).toMatch(/projected/);
    expect(t).toMatch(/seeded trend shows (a rise|spend up)|spend rose/i);
  });

  it('no reduction anywhere (Legal): says so and asks for the amount instead of inventing one', async () => {
    const t = await last(['EBITDA impact for Legal after spending went down']);
    expect(t).toMatch(/no spend reduction/i);
    expect(t).toMatch(/spend went down \$|20%|amount/);
    expect(t).not.toMatch(/EBITDA improves by \$[1-9]/);
  });

  it('portfolio scope works and pairs the cost with its ratio', async () => {
    const t = await last(['What is the EBITDA impact if portfolio spend dropped $5,000 a month?']);
    expect(t).toContain('**EBITDA impact — Portfolio**');
    expect(t).toContain(`${usd(60000)}/yr`);
    expect(t).toMatch(/\d+\.\d× return/);
  });

  it('zero baseline: no division by zero', async () => {
    const t = await last([`${Q}, group EBITDA of $0`]);
    expect(t).not.toMatch(/NaN|Infinity/);
    expect(t).toMatch(/percentage[^.]*not (meaningful|defined)/i);
  });

  it('negative baseline: absolute improvement only', async () => {
    const t = await last([`${Q}, group EBITDA of -$1M`]);
    expect(t).not.toMatch(/NaN|Infinity/);
    expect(t).toMatch(/percentage[^.]*not (meaningful|defined)/i);
    expect(t).toContain('New EBITDA -$976,000');
  });

  it('absurd numbers are rejected, not computed (1e999)', async () => {
    const t = await last([`${Q}, group EBITDA of $1e999`]);
    expect(t).not.toMatch(/NaN|Infinity/);
    expect(t).toMatch(/could not use|ignored/i);
    expect(t).not.toMatch(/New EBITDA/);
  });

  it('baseline in millions with words', async () => {
    const t = await last([`${Q}, our group EBITDA is $4.2 million`]);
    expect(t).toContain('New EBITDA $4,224,000');
  });

  it('an explicit monthly baseline is annualized by the stated unit', async () => {
    const t = await last([`${Q}; monthly EBITDA of $350,000`]);
    // 350,000 x 12 = 4,200,000 annual
    expect(t).toContain('$4,200,000');
    expect(t).toContain('+0.6%');
  });
});

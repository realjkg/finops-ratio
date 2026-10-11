// Public API -> private open model migration. The open model's cost comes from
// EXPLICIT illustrative assumptions (never data), echoed in every answer and
// overridable from the question. Arithmetic is checked by hand in comments and
// against the oracle; "realized savings" stay $0 without measured evidence.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS, migrate, team, usd, wl } from './__testkit__/oracle';
import { last, restoreClock, useFastClock } from './__testkit__/ask';

beforeAll(useFastClock);
afterAll(restoreClock);

const SUPPORT = 'wl-support';
const Q = 'What if we move the Customer Support Agent from a public API model to a private open model?';
const m = (n: number): string => `${Math.round(n / 1e6).toLocaleString('en-US')}M`;

describe('migration economics (defaults)', () => {
  /*
   * Customer Support Agent, claude-sonnet-4 list prices $3.00 in / $15.00 out / $0.30 cached.
   * Tokens/day: in 40,000 x 1,200 = 48.0M; out 40,000 x 340 = 13.6M; cached 9.5M. x30 days.
   *   API = 48.0M*30/1M*3.00 + 13.6M*30/1M*15.00 + 9.5M*30/1M*0.30 = 4,320 + 6,120 + 85.50 = 10,525.50
   *   tokens = (48.0 + 13.6 + 9.5)M x 30 = 2,133M; per GPU = 1000 x 0.5 x 3600 x 730 = 1,314M -> 2 GPUs
   *   self-host = 2 x 2.50 x 730 = 3,650; +25% ops = 4,562.50
   *   saving = 10,525.50 - 4,562.50 = 5,963.00 ; payback = 25,000 / 5,963 = 4.19 -> 4.2 months
   *   break-even volume = 4,562.50 x 2,133M / 10,525.50 = 924.6M tokens/month
   */
  it('hand-checked numbers equal the oracle', () => {
    const o = migrate([wl(SUPPORT)]);
    expect(o.api).toBeCloseTo(10525.5, 6);
    expect(o.selfHost).toBeCloseTo(4562.5, 6);
    expect(o.saving).toBeCloseTo(5963, 6);
    expect(o.payback).toBeCloseTo(4.1925, 3);
    expect(o.gpus).toBe(2);
  });

  it('prints current vs projected monthly cost, saving, break-even, payback', async () => {
    const o = migrate([wl(SUPPORT)]);
    const t = await last([Q]);
    expect(t).toContain('**Private-model migration — Customer Support Agent**');
    expect(t).toContain(`${usd(o.api)}/mo`); // $10,526 current at list prices
    expect(t).toContain(`${usd(o.selfHost)}/mo`); // $4,563 projected
    expect(t).toContain(`${usd(o.saving)}/mo`); // $5,963 saving
    expect(t).toContain('Projected recurring saving');
    expect(t).toContain('Payback: 4.2 months');
    expect(t).toContain(`Break-even volume: ${m(o.breakEvenTokens!)} tokens/month`);
    expect(t).toContain('2 GPUs');
    expect(t).toContain('$3.00'); // registry input price per 1M
    expect(t).toContain('$15.00');
  });

  it('cost to realized savings: one-time cost vs projected vs realized $0', async () => {
    const t = await last([Q]);
    expect(t).toContain('One-time cost: $25,000 (assumption)');
    expect(t).toContain('Realized savings: $0');
    expect(t).toMatch(/no measured outcome evidence/);
    expect(t).toMatch(/projected/);
    expect(t).toMatch(/Cost to realized savings/);
  });

  it('carries the quality/latency caveat and says the seed has no quality evidence', async () => {
    const t = await last([Q]);
    expect(t).toMatch(/quality/i);
    expect(t).toMatch(/latency/i);
    expect(t).toMatch(/seed holds no quality evidence for the open model/);
  });

  it('echoes every assumption with its value and says they are illustrative', async () => {
    const t = await last([Q]);
    expect(t).toContain('Assumptions (illustrative, not data');
    expect(t).toContain(`$${DEFAULTS.gpuHourlyUsd.toFixed(2)} per GPU-hour`);
    expect(t).toContain('50% utilisation');
    expect(t).toContain('1,000 tokens/s per GPU');
    expect(t).toContain('730 hours/month');
    expect(t).toContain('25% ops overhead');
    expect(t).toContain('$25,000 one-time');
    expect(t).toMatch(/override[^.]*question/i);
  });

  it('pairs the cost with the value ratio and evidence status (R4)', async () => {
    const t = await last([Q]);
    expect(t).toMatch(/13\.8×/);
    expect(t).toContain('(value evidence: assumed)');
  });

  it('a workload that is already cheaper on API shows NO saving, honestly (Marketing Content Gen)', async () => {
    const o = migrate([wl('wl-marketing')]);
    expect(o.saving).toBeLessThan(0);
    const t = await last(['What if Marketing Content Gen moved to a private open model?']);
    expect(t).toContain(`${usd(o.api)}/mo`);
    expect(t).toContain(`${usd(o.selfHost)}/mo`);
    expect(t).toMatch(/no recurring saving/i);
    expect(t).toMatch(/Payback: never/);
    expect(t).toContain(`Break-even volume: ${m(o.breakEvenTokens!)} tokens/month`);
    expect(t).not.toMatch(/NaN|Infinity/);
  });
});

describe('migration overrides parsed from the question', () => {
  it('8 GPUs at $2.50 per GPU hour, migration costs $40k (hand: 8x2.50x730=14,600 +25% = 18,250; saving = -7,724.50)', async () => {
    const o = migrate([wl(SUPPORT)], { gpuCount: 8, gpuHourlyUsd: 2.5, migrationOneTimeUsd: 40000 });
    const t = await last([`${Q} Assume 8 GPUs at $2.50 per GPU hour and migration costs $40k.`]);
    expect(t).toContain(`${usd(o.selfHost)}/mo`); // $18,250
    expect(t).toContain('8 GPUs');
    expect(t).toContain('One-time cost: $40,000');
    expect(t).toMatch(/no recurring saving/i);
    expect(t).toContain('Payback: never');
    expect(t).toContain('(your override)');
  });

  it('$1.50 per GPU hour, 3 GPUs, $10k (hand: 3x1.50x730=3,285 +25% = 4,106.25; saving 6,419.25; payback 10,000/6,419.25=1.6)', async () => {
    const o = migrate([wl(SUPPORT)], { gpuCount: 3, gpuHourlyUsd: 1.5, migrationOneTimeUsd: 10000 });
    expect(o.payback).toBeCloseTo(1.5578, 3);
    const t = await last([`${Q} Use $1.50/GPU-hour, 3 GPUs, migration cost of $10,000.`]);
    expect(t).toContain(`${usd(o.selfHost)}/mo`); // $4,106
    expect(t).toContain(`${usd(o.saving)}/mo`); // $6,419
    expect(t).toContain('Payback: 1.6 months');
    expect(t).toContain('$1.50 per GPU-hour (your override)');
  });

  it('an override changes the answer (defaults vs override differ)', async () => {
    const a = await last([Q]);
    const b = await last([`${Q} at $4.00 per GPU hour`]);
    expect(a).not.toEqual(b);
    expect(b).toContain('$4.00 per GPU-hour (your override)');
  });

  it('too few GPUs: flags capacity shortfall instead of a fake saving (1 GPU covers 1,314M of 2,133M)', async () => {
    const t = await last([`${Q} with 1 GPU`]);
    expect(t).toMatch(/covers (6[0-9]|61)% of the volume/);
    expect(t).toMatch(/not a valid comparison|needs 2 GPUs/);
  });

  it('team scope pools volume into one cluster with one migration cost (CX Engineering)', async () => {
    const ws = team('CX Engineering').members;
    const o = migrate(ws);
    const t = await last(['What would moving the CX Engineering team to a private open model save?']);
    expect(t).toContain('**Private-model migration — CX Engineering**');
    expect(t).toContain(`${usd(o.api)}/mo`);
    expect(t).toContain(`${usd(o.selfHost)}/mo`);
    expect(t).toContain(`${o.gpus} GPUs`);
    expect(t).toContain('One-time cost: $25,000');
  });

  it('invalid overrides are ignored and said so: zero, negative, 1e999, NaN-ish', async () => {
    for (const bad of ['0 GPUs', '-4 GPUs', '1e999 GPUs', 'at $-3 per GPU hour', 'at $1e999 per GPU hour', '150% utilisation', 'migration costs $-5k']) {
      const t = await last([`${Q} Assume ${bad}.`]);
      expect(t, bad).not.toMatch(/NaN|Infinity|undefined/);
      expect(t, bad).toMatch(/ignored/i);
      expect(t, bad).toContain('Payback');
      // defaults stay in force
      expect(t, bad).toContain('One-time cost: $25,000');
    }
  });

  it('the assumption constant is one exported object documented as illustrative, not data', () => {
    const src = readFileSync('src/ai/mock/assumptions.ts', 'utf8');
    const at = src.indexOf('export const SELF_HOST_ASSUMPTIONS');
    expect(at).toBeGreaterThan(0);
    const doc = src.slice(Math.max(0, at - 900), at);
    expect(doc).toMatch(/illustrative assumptions, not data/);
    expect(src.match(/export const SELF_HOST_ASSUMPTIONS/g)).toHaveLength(1);
  });
});

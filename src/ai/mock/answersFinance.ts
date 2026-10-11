// EBITDA impact and public-API -> private-model migration. Both are built from
// accounting identities plus labelled assumptions: nothing here is a seeded
// fact about revenue, EBITDA, hosting or open-model quality, because the seed
// holds none of those.

import { REALIZED_LINE, T, capRows, contextLine } from './answerKit';
import { ebitdaEffect, impliedMonthlyChange, membersOf, migration, rollup, scopeLabel, type Migration } from './calc';
import { SELF_HOST_ASSUMPTIONS, resolveAssumptions, type Overrides, type ResolvedAssumptions } from './assumptions';
import { int, months, price, signedPct1, usd, usd2 } from './format';
import { findModel } from '@/data/models';
import type { Baselines, Reduction } from './parse';
import type { Answer, Scope, World, WorkloadFacts } from './types';

const ids = (ws: WorkloadFacts[]): string[] => ws.map((w) => w.id);
const ASSUMPTIONS_TITLE =
  'Assumptions (illustrative, not data; override any of them in the question, e.g. "8 GPUs", "at $2.50 per GPU hour", "migration costs $40k")';
const pct2 = (n: number): string => `${n.toFixed(2)}%`;

interface Source {
  monthly: number;
  line: string;
  assumption?: string;
}

/** Where the "spend went down" amount comes from, in priority order. */
function reductionSource(world: World, scope: Scope, red: Reduction): { source: Source | null; notes: string[] } {
  const members = membersOf(world, scope);
  const r = rollup(members);
  const label = scopeLabel(world, scope);
  const notes: string[] = [];
  if (red.ignored) {
    notes.push(red.ignored);
    notes.push(`There is no usable spend reduction for ${label}: tell me a positive amount, for example "spend went down $2,000 a month" or "spend went down 20%".`);
    return { source: null, notes };
  }
  if (red.monthlyUsd !== undefined) {
    return {
      source: {
        monthly: red.monthlyUsd,
        line: `Spend reduction: ${usd(red.monthlyUsd)}/mo (stated by you) = ${usd(red.monthlyUsd * 12)}/yr.`,
        assumption: red.periodStated ? undefined : 'No period was stated, so the amount is taken as per month.',
      },
      notes,
    };
  }
  if (red.percent !== undefined) {
    const m = (red.percent / 100) * r.spend;
    return {
      source: {
        monthly: m,
        line: `Spend reduction: ${usd(m)}/mo = ${usd(m * 12)}/yr — ${red.percent}% of the group’s current seeded monthly spend ${usd(r.spend)} (assumption).`,
        assumption: `The ${red.percent}% is taken against current seeded spend, not prior spend.`,
      },
      notes,
    };
  }
  const trend = impliedMonthlyChange(members);
  if (trend && trend.change < 0) {
    const fall = -trend.change;
    return {
      source: {
        monthly: fall,
        line: `Spend reduction: ${usd(fall)}/mo = ${usd(fall * 12)}/yr — implied by the seeded MoM trend (${signedPct1((trend.change / trend.prior) * 100)} vs prior month); this is the seed’s trend, not a ledger measurement.`,
      },
      notes,
    };
  }
  const savings = members.reduce((s, w) => s + w.savings, 0);
  if (savings > 0) {
    notes.push(
      trend
        ? `The seeded MoM trend shows ${label} spend rose ${signedPct1((trend.change / trend.prior) * 100)}, so spend has not gone down in the data.`
        : `No spend trend is present for ${label}.`,
    );
    return {
      source: {
        monthly: savings,
        line: `Closest scenario in the data: the identified savings opportunity of ${usd(savings)}/mo = ${usd(savings * 12)}/yr (projected, not realized).`,
      },
      notes,
    };
  }
  notes.push(
    `There is no spend reduction for ${label} in the seeded data: ${trend ? `the MoM trend is ${signedPct1((trend.change / trend.prior) * 100)}` : 'no trend is present'} and no savings opportunity is identified.`,
  );
  return { source: null, notes };
}

export function ebitdaAnswer(world: World, scope: Scope, red: Reduction, base: Baselines): Answer {
  const members = membersOf(world, scope);
  const label = scopeLabel(world, scope);
  const { source, notes } = reductionSource(world, scope, red);
  const body: string[] = [];
  const assumptions: string[] = [];
  const ctxFirst = scope.kind === 'portfolio' ? 'the portfolio' : scope.kind === 'team' ? T(scope.team) : label;

  body.push(...notes.filter((n) => !/^There is no (usable )?spend reduction/.test(n)));
  body.push(...base.ignored);
  if (!source) {
    const why = notes.find((n) => /^There is no (usable )?spend reduction/.test(n)) ?? '';
    body.push(why);
    if (!/tell me a positive amount/.test(why)) body.push('Tell me the amount, for example "spend went down $2,000 a month" or "spend went down 20%", and I will compute the EBITDA effect.');
    body.push(contextLine(world, scope));
    return {
      header: `**EBITDA impact — ${label}**`,
      body: body.filter(Boolean),
      assumptions: ['A recurring operating-cost reduction raises EBITDA one-for-one, pre-tax (assumption: the spend is operating expense).'],
      next: [`What is the EBITDA impact for ${ctxFirst} if spend went down $2,000 a month?`, `How much can we save in ${ctxFirst}?`, `What is the ROI of ${ctxFirst}?`],
      referenced: ids(members),
    };
  }

  const eff = ebitdaEffect(source.monthly, base);
  body.push(source.line);
  const scopeSpend = rollup(members).spend;
  if (scopeSpend > 0 && source.monthly > scopeSpend && red.percent === undefined) {
    body.push(`Warning: the stated reduction (${usd(source.monthly)}/mo) exceeds ${label}'s entire current seeded spend (${usd(scopeSpend)}/mo). That is not possible from this data, so check the amount; I have not capped it.`);
  }
  body.push(
    `EBITDA improves by ${usd(eff.annualImprovement)}/yr, pre-tax, one-for-one (assumption: the reduced spend is operating expense, so ΔEBITDA = −Δopex; capitalized spend would not move EBITDA).`,
  );
  assumptions.push('The spend is operating expense, not capitalized (assumption).');
  assumptions.push('The reduction is recurring and the value delivered is unchanged (assumption).');
  if (source.assumption) assumptions.push(source.assumption);

  if (eff.ebitdaBefore !== undefined) {
    const stated = base.ebitda !== undefined;
    body.push(
      stated
        ? `Baseline: group EBITDA ${usd(eff.ebitdaBefore)} (${base.ebitdaNote}).`
        : `Baseline: group EBITDA ${usd(eff.ebitdaBefore)}, derived from your revenue and margin (stated by you).`,
    );
    body.push(
      `New EBITDA ${usd(eff.ebitdaAfter as number)}` +
        (eff.ebitdaPct === null || eff.ebitdaPct === undefined
          ? '. A percentage change is not defined for a zero or negative baseline; the absolute improvement above is the result.'
          : `, ${signedPct1(eff.ebitdaPct)} (before tax).`),
    );
    assumptions.push('Your baseline is used as typed; it is not in the seeded data.');
  }
  if (eff.revenue !== undefined) {
    body.push(`Revenue ${usd(eff.revenue)} (${base.revenueNote}).`);
    if (eff.marginBefore !== undefined && eff.marginAfter !== undefined) {
      body.push(`EBITDA margin: ${pct2(eff.marginBefore)} → ${pct2(eff.marginAfter)} (+${(eff.marginPoints as number).toFixed(2)} pp).`);
    } else {
      body.push(`EBITDA margin improves by +${(eff.marginPoints as number).toFixed(2)} pp (${usd(eff.annualImprovement)} ÷ ${usd(eff.revenue)}); the starting margin needs an EBITDA figure.`);
    }
  }
  if (eff.ebitdaBefore === undefined && eff.revenue === undefined) {
    body.push(
      'No EBITDA or revenue baseline exists in the seeded data, so I cannot give a % change or a margin. Tell me, for example, "group EBITDA of $4.2M" or "revenue $20M", and I will compute it.',
    );
  }
  body.push(contextLine(world, scope));
  body.push('A cut that also removes capability removes value: check the ratio above before banking the saving.');
  body.push(REALIZED_LINE);
  return {
    header: `**EBITDA impact — ${label}**`,
    body,
    assumptions,
    next: [
      `What if we moved ${ctxFirst} to a private open model?`,
      scope.kind === 'workload' ? `Is there outcome evidence for ${label}?` : `Show the workloads in ${ctxFirst} and their ROI`,
      `What is the ROI of ${ctxFirst}?`,
    ],
    referenced: ids(members),
  };
}

// ---------------------------------------------------------------- migration

function assumptionLines(a: ResolvedAssumptions, o: Overrides, m: Migration | null): string[] {
  const d = SELF_HOST_ASSUMPTIONS;
  const tag = (changed: boolean): string => (changed ? '(your override)' : '(default assumption)');
  const gpus = m ? m.gpus : a.gpuCount;
  return [
    `GPU price: ${price(a.gpuHourlyUsd)} per GPU-hour ${tag(o.gpuHourlyUsd !== undefined && o.gpuHourlyUsd !== d.gpuHourlyUsd)}`,
    `GPUs: ${o.gpuCount !== undefined ? int(o.gpuCount) : gpus === null ? `sized to the volume, minimum ${a.minGpus}` : `${int(gpus)}, auto-sized to the volume (minimum ${a.minGpus})`} ${tag(o.gpuCount !== undefined)}`,
    `Throughput: ${int(a.tokensPerSecondPerGpu)} tokens/s per GPU at 100% utilisation, blended input and output ${tag(o.tokensPerSecondPerGpu !== undefined)}`,
    `Utilisation: ${Math.round(a.utilisation * 100)}% utilisation ${tag(o.utilisation !== undefined)}`,
    `Hours: ${int(a.hoursPerMonth)} hours/month, always on (default assumption)`,
    `Ops: ${Math.round(a.opsOverheadPct * 100)}% ops overhead on GPU cost ${tag(o.opsOverheadPct !== undefined)}`,
    `Migration: ${usd(a.migrationOneTimeUsd)} one-time ${tag(o.migrationOneTimeUsd !== undefined)}`,
    'Volume: today’s seeded tokens × 30 days; list prices from the model registry; no discounts, commitments or batch rates.',
  ];
}

export function migrationAnswer(world: World, scope: Scope, o: Overrides, ignored: string[]): Answer {
  const members = membersOf(world, scope);
  const label = scopeLabel(world, scope);
  const r = rollup(members);
  const res = migration(members, o);
  const header = `**Private-model migration — ${label}**`;
  const body: string[] = [`Scenario: replace the public-API model(s) behind ${label} with one self-hosted open-weight model (none is in the seed; its cost below is an assumption, not data).`];
  body.push(...ignored);

  if (res.kind === 'no-volume') {
    body.push('I cannot price this: the seeded token volume or a registry price is missing for the workload(s) in scope.');
    body.push(contextLine(world, scope));
    return {
      header, body,
      assumptionsTitle: ASSUMPTIONS_TITLE,
      assumptions: assumptionLines(resolveAssumptions(o), o, null),
      next: ['What is the ROI of the portfolio?', 'Which team is driving the highest cost?'],
      referenced: ids(members),
    };
  }
  const ok = res;
  const a = ok.a;
  body.push('Current (public API, registry list prices):');
  const partLines = ok.parts.map((p) => {
    const mdl = p.member.model ? findModel(p.member.model) : undefined;
    return `• ${p.member.name} — ${p.member.model}${p.member.provider ? ` (${p.member.provider})` : ''}: ${mdl ? `${price(mdl.pricing.input_per_1m)} in / ${price(mdl.pricing.output_per_1m)} out per 1M` : 'price n/a'} → ${usd(p.api)}/mo for ${int(p.tokens / 1e6)}M tokens`;
  });
  body.push(...capRows(partLines, 10));
  if (ok.unpriced.length > 0) body.push(`Not priced (model or volume missing): ${ok.unpriced.slice(0, 10).map((w) => w.name).join(', ')}.`);
  body.push(`Current API cost at list prices: ${usd(ok.api)}/mo (${usd2((ok.api / ok.tokens) * 1e6)} per 1M tokens blended). Seeded run-rate spend is ${usd(r.spend)}/mo, a different basis, so the comparison uses list prices on both sides.`);
  body.push(
    `Projected private model: ${ok.gpus} GPU${ok.gpus === 1 ? '' : 's'} × ${price(a.gpuHourlyUsd)} × ${int(a.hoursPerMonth)} h = ${usd(ok.gpuCost)}/mo, plus ${Math.round(a.opsOverheadPct * 100)}% ops = ${usd(ok.selfHost)}/mo (${usd2((ok.selfHost / ok.tokens) * 1e6)} per 1M tokens at this volume).`,
  );
  if (ok.coverage < 1) {
    body.push(`Capacity warning: this cluster (${ok.gpus} GPU${ok.gpus === 1 ? '' : 's'}) covers ${Math.round(ok.coverage * 100)}% of the volume (each handles ${int(ok.perGpuTokens / 1e6)}M tokens/month); this needs ${ok.neededGpus} GPU${ok.neededGpus === 1 ? '' : 's'}, so this is not a valid comparison.`);
  }
  const valid = ok.coverage >= 1;
  const runRate = r.spend;
  if (!valid) {
    body.push('Projected recurring saving: not shown \u2014 the cluster is too small for the volume, so any saving here would not be valid.');
  } else if (ok.saving > 0) {
    const share = runRate > 0 ? `${Math.round((ok.saving / runRate) * 100)}% of the seeded run-rate ${usd(runRate)}/mo; ` : '';
    body.push(`Projected recurring saving: ${usd(ok.saving)}/mo = ${usd(ok.saving * 12)}/yr (${share}projected, rests on the assumptions below).`);
    if (runRate > 0 && ok.saving > runRate) {
      body.push(`Warning: the projected saving exceeds the seeded run-rate spend (${usd(runRate)}/mo) because the list-price volume cost (${usd(ok.api)}/mo) is above what the seed says is spent. Treat it as an upper bound, not a forecast; I have not capped it.`);
    }
  } else {
    body.push(`Projected recurring saving: none \u2014 self-hosting would cost ${usd(-ok.saving)}/mo more than the API at these assumptions (no recurring saving).`);
  }
  body.push(`Break-even volume: ${int(ok.breakEvenTokens === null ? 0 : ok.breakEvenTokens / 1e6)}M tokens/month${ok.breakEvenTokens !== null ? ` (${Math.round((ok.breakEvenTokens / ok.tokens) * 100)}% of today’s ${int(ok.tokens / 1e6)}M); below it the API is cheaper at this cluster size` : ''}.`);
  body.push(
    !valid
      ? 'Payback: not shown (the comparison is not valid at this cluster size).'
      : ok.payback !== null
      ? `Payback: ${a.migrationOneTimeUsd === 0 ? '0.0 months (no one-time cost)' : months(ok.payback)} (one-time cost ÷ projected monthly saving).`
      : 'Payback: never (no recurring saving to repay the one-time cost).',
  );
  body.push('Cost to realized savings:');
  body.push(`• One-time cost: ${usd(ok.oneTime)} ${o.migrationOneTimeUsd !== undefined ? '(your override)' : '(assumption)'}`);
  body.push(`• Projected recurring saving: ${!valid ? 'not shown (invalid cluster size)' : ok.saving > 0 ? `${usd(ok.saving)}/mo (projected)` : 'none at these assumptions'}`);
  body.push(`• ${REALIZED_LINE} Until outcome evidence exists the saving stays projected, and the one-time cost is real spend.`);
  body.push(contextLine(world, scope));
  body.push(
    'Risk: quality and latency can change when the model changes, and the value ratio depends on quality. The seed holds no quality evidence for the open model; run an evaluation on real traffic before trusting any figure above.',
  );
  return {
    header,
    body,
    assumptionsTitle: ASSUMPTIONS_TITLE,
    assumptions: assumptionLines(a, o, ok),
    next: [
      `What is the ROI of ${scope.kind === 'team' ? T(scope.team) : label}?`,
      scope.kind === 'portfolio' ? 'Which team is driving the highest cost?' : `Show token and unit cost detail for ${label}`,
      `What is the EBITDA impact for ${scope.kind === 'team' ? T(scope.team) : scope.kind === 'portfolio' ? 'the portfolio' : label} if spend went down $2,000 a month?`,
    ],
    referenced: ids(members),
  };
}

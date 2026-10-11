// ROI, team ranking, scoped cost drivers and scoped savings.

import { MODEL_QUALITY_NOTE } from '@/data/models';
import { findModel } from '@/data/models';
import { REALIZED_LINE, T, capRows, contextLine, ladder, short, workloadRow } from './answerKit';
import {
  bySpendDesc, byValueDesc, extremes, membersOf, rankTeams, rollup, scopeLabel, scopeTitle, teamRows,
  type RankMetric,
} from './calc';
import { evid, pct1, price, returnText, roiLine, signedPct1, usd, x } from './format';
import type { Answer, Scope, World, WorkloadFacts } from './types';

const ids = (ws: WorkloadFacts[]): string[] => ws.map((w) => w.id);

function headline(world: World, scope: Scope): string {
  const r = rollup(membersOf(world, scope));
  return `Cost ${usd(r.spend)}/mo · value ${usd(r.value)}/mo · ${returnText(r.ratio)}${evid(r.evidence)}`;
}

/** ROI for any scope: value, cost, ratio, evidence, ranked contributors, weakest and strongest. */
export function roiAnswer(world: World, scope: Scope): Answer {
  const members = membersOf(world, scope);
  const r = rollup(members);
  const body: string[] = [headline(world, scope), roiLine(r.value, r.spend)];

  if (members.length === 0) {
    body.push(`No workloads are in this scope in the data I was given.`);
  } else if (scope.kind === 'portfolio' && world.teams.length > 0) {
    body.push('Teams, ranked by value:');
    [...teamRows(world)]
      .sort((a, b) => b.roll.value - a.roll.value)
      .forEach((t, i) =>
        body.push(`${i + 1}. ${t.team} — cost ${usd(t.roll.spend)}/mo · value ${usd(t.roll.value)}/mo · ${x(t.roll.ratio)} ${short(t.roll.evidence)}`),
      );
  } else {
    body.push(scope.kind === 'portfolio' ? 'Workloads, ranked by value:' : 'Contributors, ranked by value:');
    body.push(...capRows([...members].sort(byValueDesc).map((w, i) => workloadRow(i, w))));
  }

  if (scope.kind === 'workload' && members[0]) {
    const w = members[0];
    body.push(
      `Team: ${w.team ?? 'not in this context'} · model: ${w.model ?? 'unknown'}${w.provider ? ` (${w.provider})` : ''}` +
        (w.status ? ` · status: ${w.status}` : '') +
        (w.budgetConsumedPct !== null ? ` · budget consumed: ${w.budgetConsumedPct}%` : ''),
    );
  }
  if (scope.kind === 'model' && members.length > 0) {
    const m = findModel(scope.model);
    if (m) {
      body.push(`Registry list price: ${price(m.pricing.input_per_1m)} in / ${price(m.pricing.output_per_1m)} out per 1M tokens.`);
      const note = MODEL_QUALITY_NOTE[scope.model];
      if (note) body.push(`Seeded quality hint: ${note}.`);
    }
  }

  const ex = scope.kind === 'workload' ? null : extremes(members);
  if (ex) {
    body.push(
      `Strongest: ${ex.strongest.name} (${x(ex.strongest.ratio)} ${short(ex.strongest.evidence)}) · Weakest: ${ex.weakest.name} (${x(ex.weakest.ratio)} ${short(ex.weakest.evidence)}${(ex.weakest.ratio ?? 1) <= 0 ? ', no positive return' : ''})`,
    );
  } else if (members.length === 1 && scope.kind !== 'workload') {
    body.push(`Only one workload here, so the ${scope.kind} figure is that workload's figure.`);
  }
  if ((r.ratio ?? 1) <= 0) {
    body.push('Counted value is not positive after the quality floor and harm from misses: this is a value review, not a cost-side fix.');
  }
  return {
    header: `**ROI — ${scopeTitle(world, scope)}**`,
    body,
    next: ladder(world, scope, 'roi'),
    referenced: ids(members),
  };
}

/** Ranking of teams by cost, ROI or savings. */
export function teamRankAnswer(world: World, metric: RankMetric, ascending: boolean): Answer {
  const rows = rankTeams(world, metric, ascending);
  const total = rollup(world.workloads);
  const lead = rows[0];
  const top = lead ? [...lead.roll.members].sort(bySpendDesc)[0] : undefined;
  const title =
    metric === 'cost'
      ? `${ascending ? 'Lowest' : 'Highest'}-cost team`
      : metric === 'roi'
        ? ascending ? 'Weakest-ROI team' : 'Best-ROI team'
        : 'Largest savings opportunity by team';
  const body: string[] = [];
  if (lead) {
    body.push(
      metric === 'savings'
        ? `${usd(lead.savings)}/mo identified (projected, not realized) at ${returnText(lead.roll.ratio)}${evid(lead.roll.evidence)} — ${lead.roll.members.length} workload(s).`
        : `${usd(lead.roll.spend)}/mo (${total.spend > 0 ? pct1((lead.roll.spend / total.spend) * 100) : 'n/a'} of ${usd(total.spend)} portfolio spend) at ${returnText(lead.roll.ratio)}${evid(lead.roll.evidence)} — ${lead.roll.members.length} workload(s)${top ? `; top workload ${top.name} at ${usd(top.monthlySpend)}/mo` : ''}.`,
    );
    body.push(`Teams ranked by ${metric === 'cost' ? 'monthly cost' : metric === 'roi' ? 'value ratio' : 'identified savings'}${ascending ? ' (lowest first)' : ''}:`);
    const lines = rows.map((t, i) => {
      const share = total.spend > 0 ? ` (${pct1((t.roll.spend / total.spend) * 100)})` : '';
      return metric === 'savings'
        ? `${i + 1}. ${t.team} — ${usd(t.savings)}/mo identified · cost ${usd(t.roll.spend)}/mo · ${x(t.roll.ratio)} ${short(t.roll.evidence)}`
        : `${i + 1}. ${t.team} — ${usd(t.roll.spend)}/mo${share} · ${returnText(t.roll.ratio)} ${short(t.roll.evidence)} · ${t.roll.members.length} workload(s)`;
    });
    body.push(...capRows(lines));
  } else {
    body.push('No teams are present in the data I was given.');
  }
  const first = lead ? T(lead.team) : 'the portfolio';
  const next =
    metric === 'cost'
      ? [`Show the workloads in ${first} and their ROI`, 'Which team has the weakest ROI?', `What is the EBITDA impact for ${first} if spend went down $2,000 a month?`]
      : metric === 'roi'
        ? [`Show the workloads in ${first} and their ROI`, 'Which team is driving the highest cost?', `How much can we save in ${first}?`]
        : [`How much can we save in ${first}?`, `What if we moved ${first} to a private open model?`, 'Which team is driving the highest cost?'];
  return {
    header: lead ? `**${title}: ${lead.team}**` : `**${title}**`,
    body,
    next: lead ? next : ['What is the ROI of the portfolio?', 'What can you answer, and how deep can you go?'],
    referenced: lead ? ids(lead.roll.members) : [],
  };
}

/** Cost drivers inside one scope, each with its ratio and evidence (R4). */
export function costDriverAnswer(world: World, scope: Scope): Answer {
  const members = [...membersOf(world, scope)].sort(bySpendDesc);
  const body: string[] = [];
  const top = members[0];
  if (top) {
    body.push(
      `Largest: ${top.name} at ${usd(top.monthlySpend)}/mo (${returnText(top.ratio)}${evid(top.evidence)})` +
        (top.budgetConsumedPct !== null ? `; ${top.budgetConsumedPct}% of budget consumed` : '') +
        (top.costTrendPct !== null ? `; MoM trend ${signedPct1(top.costTrendPct)}` : '') +
        '.',
    );
    body.push('Workloads, ranked by monthly cost:');
    body.push(...capRows(members.map((w, i) => workloadRow(i, w))));
  } else {
    body.push('No workloads are in this scope in the data I was given.');
  }
  return {
    header: `**Cost drivers — ${scopeLabel(world, scope)}**`,
    body,
    next: ladder(world, scope, 'cost'),
    referenced: ids(members),
  };
}

/** Savings for a scope: identified opportunities are projected; realized is $0. */
export function savingsAnswer(world: World, scope: Scope): Answer {
  const members = membersOf(world, scope);
  const withSavings = members.filter((w) => w.savings > 0).sort((a, b) => b.savings - a.savings);
  const total = withSavings.reduce((s, w) => s + w.savings, 0);
  const label = scopeLabel(world, scope);
  const body: string[] = [];
  if (total > 0) {
    body.push(`Identified savings opportunity: ${usd(total)}/mo (projected — cost-source finding estimates, not realized).`);
    withSavings.forEach((w, i) => body.push(`${i + 1}. ${w.name} — ${usd(w.savings)}/mo · cost ${usd(w.monthlySpend)}/mo at ${returnText(w.ratio)}${evid(w.evidence)}`));
  } else {
    body.push(`There are no savings opportunities identified for ${label} in the seeded findings (${usd(0)}/mo).`);
    body.push('A model-migration scenario is a separate, assumption-based estimate; ask for it below.');
  }
  body.push(REALIZED_LINE);
  body.push(contextLine(world, scope));
  const first = scope.kind === 'portfolio' ? 'the portfolio' : scope.kind === 'team' ? T(scope.team) : label;
  return {
    header: `**Savings — ${label}**`,
    body,
    next: [`What if we moved ${first} to a private open model?`, ...ladder(world, scope, 'savings')].slice(0, 3),
    referenced: ids(withSavings),
  };
}

// Drill-down ladder below ROI: workload activity, tokens and unit cost,
// alerts, and outcome evidence. Everything is read from the seeded facts.

import { MODEL_QUALITY_NOTE, findModel } from '@/data/models';
import { contextLine, ladder, short, workloadRow } from './answerKit';
import { bySpendDesc, membersOf, rollup, scopeLabel, scopeTitle } from './calc';
import { evid, int, pct1, price, returnText, signedPct1, usd, usd2, x } from './format';
import { teamRankAnswer } from './answersRoi';
import type { Answer, Scope, World, WorkloadFacts } from './types';

const ids = (ws: WorkloadFacts[]): string[] => ws.map((w) => w.id);
const modelPrices = (name: string | null): string => {
  const m = name ? findModel(name) : undefined;
  if (!m) return 'registry price unavailable';
  const c = m.pricing.cached_input_per_1m ?? m.pricing.input_per_1m * 0.25;
  return `${price(m.pricing.input_per_1m)} in / ${price(m.pricing.output_per_1m)} out / ${price(c)} cached per 1M tokens`;
};

function activityRow(i: number, w: WorkloadFacts): string {
  return (
    `${workloadRow(i, w)}` +
    (w.model ? ` · ${w.model}` : '') +
    (w.budgetConsumedPct !== null ? ` · budget ${w.budgetConsumedPct}% consumed` : '') +
    (w.costTrendPct !== null ? ` · MoM ${signedPct1(w.costTrendPct)}` : '') +
    (w.status ? ` · ${w.status}` : '')
  );
}

/** One workload in full: where it sits, what it costs, what it does. */
function workloadDetail(world: World, w: WorkloadFacts): Answer {
  const body = [
    `Cost ${usd(w.monthlySpend)}/mo · value ${usd(w.monthlyValue)}/mo · ${returnText(w.ratio)}${evid(w.evidence)}`,
    `Team: ${w.team ?? 'not present in this context'} · model: ${w.model ?? 'unknown'}${w.provider ? ` (${w.provider})` : ''}`,
    `Status: ${w.status ?? 'n/a'}` +
      (w.budgetConsumedPct !== null ? ` · budget consumed ${w.budgetConsumedPct}%` : '') +
      (w.monthlyBudget !== null ? ` of ${usd(w.monthlyBudget)}/mo` : '') +
      (w.costTrendPct !== null ? ` · MoM trend ${signedPct1(w.costTrendPct)}` : ''),
    `Activity: ${w.calls !== null ? `${int(w.calls)} calls/day (seeded)` : 'call volume not in this context'}` +
      (w.demandShape ? ` · demand shape ${w.demandShape}` : '') +
      (w.gatesPassed !== null ? ` · governance gates ${w.gatesPassed}/4` : ''),
    ...(w.cacheHitRate !== null ? [`Cache hit rate: ${pct1(w.cacheHitRate * 100)} of input tokens billed at the cached rate.`] : []),
    `Alerts: ${w.alerts === null ? 'not in this context' : w.alerts.length === 0 ? 'none seeded' : `${w.alerts.length} seeded (${w.alerts.filter((a) => !a.acknowledged).length} unacknowledged)`}.`,
  ];
  return {
    header: `**Detail — ${w.name} (workload)**`,
    body,
    next: ladder(world, { kind: 'workload', id: w.id }, 'workloads'),
    referenced: [w.id],
  };
}

/** Workloads (activity + ROI) for a scope. */
export function workloadsAnswer(world: World, scope: Scope): Answer {
  if (scope.kind === 'workload') {
    const w = membersOf(world, scope)[0];
    if (w) return workloadDetail(world, w);
  }
  if (scope.kind === 'portfolio') {
    if (world.teams.length === 0) return listAnswer(world, scope, 'Workloads');
    const a = teamRankAnswer(world, 'cost', false);
    return { ...a, header: '**Teams — Portfolio**' };
  }
  return listAnswer(world, scope, 'Workloads');
}

function listAnswer(world: World, scope: Scope, word: string): Answer {
  const members = [...membersOf(world, scope)].sort(bySpendDesc);
  const label = scopeLabel(world, scope);
  const head = scope.kind === 'model' ? `**${word} on ${label} (model)**` : `**${word} — ${scopeTitle(world, scope)}**`;
  const r = rollup(members);
  const body = [`${scope.kind === 'portfolio' ? 'Portfolio' : label} costs ${usd(r.spend)}/mo at ${returnText(r.ratio)}${evid(r.evidence)}.`];
  if (members.length === 0) body.push('No workloads are in this scope in the data I was given.');
  else {
    body.push('Workloads, ranked by monthly cost:');
    members.forEach((w, i) => body.push(activityRow(i, w)));
  }
  if (scope.kind === 'model') body.push(`List price: ${modelPrices(scope.model)}.`);
  return { header: head, body, next: ladder(world, scope, 'workloads'), referenced: ids(members) };
}

function tokenRow(i: number, w: WorkloadFacts): string {
  const per1k = unitPer1k(w);
  return (
    `${i + 1}. ${w.name} — ${w.model ?? 'model unknown'}` +
    (w.cacheHitRate !== null ? ` · cache hit ${pct1(w.cacheHitRate * 100)}` : '') +
    (per1k !== null ? ` · ${usd2(per1k)} per 1,000 calls at list price` : '') +
    ` · ${x(w.ratio)} ${short(w.evidence)}`
  );
}

/** List-price cost of 1,000 calls (uncached input + output), from the seeded daily volume. */
function unitPer1k(w: WorkloadFacts): number | null {
  const m = w.model ? findModel(w.model) : undefined;
  if (!m || !w.calls || w.calls <= 0 || w.tokIn === null || w.tokOut === null) return null;
  const perCall = ((w.tokIn / w.calls) * m.pricing.input_per_1m + (w.tokOut / w.calls) * m.pricing.output_per_1m) / 1e6;
  return perCall * 1000;
}

/** Tokens, cache and unit cost. */
export function tokensAnswer(world: World, scope: Scope): Answer {
  const members = membersOf(world, scope);
  const label = scopeLabel(world, scope);
  const r = rollup(members);
  const body: string[] = [`${label} costs ${usd(r.spend)}/mo at ${returnText(r.ratio)}${evid(r.evidence)}.`];
  if (scope.kind === 'workload' && members[0]) {
    const w = members[0];
    body.push(`Model: ${w.model ?? 'unknown'}${w.provider ? ` (${w.provider})` : ''} · list price ${modelPrices(w.model)}.`);
    if (w.tokIn !== null && w.tokOut !== null && w.tokCached !== null) {
      body.push(`Tokens today (seeded daily volume): input ${int(w.tokIn)} · output ${int(w.tokOut)} · cached ${int(w.tokCached)}.`);
    } else body.push('Token volumes are not present in this context.');
    if (w.calls && w.tokIn !== null && w.tokOut !== null) {
      body.push(`Average per call: ${int(w.tokIn / w.calls)} input / ${int(w.tokOut / w.calls)} output tokens (${int(w.calls)} calls/day).`);
    }
    body.push(w.cacheHitRate !== null ? `Cache hit rate: ${pct1(w.cacheHitRate * 100)} of input tokens are billed at the cached rate.` : 'Cache hit rate: no input tokens today, so no rate is shown.');
    const per1k = unitPer1k(w);
    if (per1k !== null) body.push(`List-price unit cost: ${usd2(per1k)} per 1,000 calls (uncached input + output).`);
  } else if (scope.kind === 'model') {
    body.push(`List price: ${modelPrices(scope.model)}.`);
    const note = MODEL_QUALITY_NOTE[scope.model];
    if (note) body.push(`Seeded quality hint: ${note}.`);
    if (members.length === 0) body.push('No workload in the data runs on this model.');
    else body.push('Workloads on it:', ...[...members].sort(bySpendDesc).map((w, i) => tokenRow(i, w)));
  } else {
    body.push('Workloads, ranked by monthly cost:', ...[...members].sort(bySpendDesc).map((w, i) => tokenRow(i, w)));
    const used = [...new Set(members.map((w) => w.model).filter((m): m is string => Boolean(m)))];
    if (scope.kind === 'portfolio' && used.length > 0) {
      body.push('Registry list prices for the models in use:');
      used.forEach((m) => body.push(`• ${m}: ${modelPrices(m)}`));
    }
  }
  return {
    header: `**Tokens and unit cost — ${label}**`,
    body,
    next: ladder(world, scope, 'tokens'),
    referenced: ids(members),
  };
}

/** Alerts for a scope. */
export function alertsAnswer(world: World, scope: Scope): Answer {
  const members = membersOf(world, scope);
  const label = scopeLabel(world, scope);
  const body: string[] = [contextLine(world, scope)];
  const rows = members.flatMap((w) => (w.alerts ?? []).map((a) => ({ w, a })));
  if (members.some((w) => w.alerts === null)) body.push('Alert data is not present for some workloads in this context.');
  if (rows.length === 0) body.push(`No alerts are seeded for ${label}.`);
  else {
    const rank = (s: string): number => (s === 'critical' ? 0 : s === 'warning' ? 1 : 2);
    rows.sort((p, q) => rank(p.a.severity) - rank(q.a.severity));
    body.push(`${rows.length} seeded alert(s), most severe first:`);
    for (const { w, a } of rows) {
      body.push(`• [${a.severity}] ${a.type}${scope.kind === 'workload' ? '' : ` · ${w.name}`} — ${a.message} (${a.acknowledged ? 'acknowledged' : 'unacknowledged'})`);
    }
  }
  return { header: `**Alerts — ${label}**`, body, next: ladder(world, scope, 'alerts'), referenced: ids(members) };
}

/** Outcome evidence: the seed holds none that is measured. */
export function outcomesAnswer(world: World, scope: Scope): Answer {
  const members = membersOf(world, scope);
  const label = scopeLabel(world, scope);
  const r = rollup(members);
  const body = [
    `There is no measured outcome evidence for ${label} in the seeded data. Its value ratio is ${returnText(r.ratio)}${evid(r.evidence)}.`,
    'The demo’s outcome records are simulated fixtures: every value measure is marked assumed, so realized value and realized savings are not established (Realized savings: $0).',
    'Recording a ledger-referenced value measure with a verifier in the Outcomes panel is what upgrades a claim beyond assumed; until then Frank keeps calling it assumed or projected.',
    ...(members.length > 1 ? [`Weakest-link rule: a group shows the weakest status of its members (${members.length} here).`] : []),
  ];
  return { header: `**Outcome evidence — ${label}**`, body, next: ladder(world, scope, 'outcomes'), referenced: ids(members) };
}

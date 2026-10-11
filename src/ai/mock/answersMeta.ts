// Capability ladder, unsupported and clarify answers.

import { rollup } from './calc';
import { basisLine, usd } from './format';
import type { Answer, World } from './types';

export const UNSUPPORTED_HEADER = "**I can't answer that from the seeded data**";
export const CLARIFY_HEADER = '**Which one do you mean?**';

function sampleNames(world: World): { team: string; workload: string; model: string } {
  const top = [...world.workloads].sort((a, b) => b.monthlySpend - a.monthlySpend)[0];
  return {
    team: top?.team ?? world.teams[0] ?? '',
    workload: top?.name ?? '',
    model: top?.model ?? '',
  };
}

/** Questions Frank can always answer, built from the data in hand. */
export function starterQuestions(world: World): string[] {
  const s = sampleNames(world);
  const qs = ['What is the ROI of the portfolio?'];
  if (world.teams.length > 0) qs.push('Which team is driving the highest cost?', `What is the ROI of the ${s.team} team?`);
  if (s.workload) qs.push(`What if we moved ${s.workload} to a private open model?`);
  return qs;
}

export function capabilityAnswer(world: World): Answer {
  const s = sampleNames(world);
  const r = rollup(world.workloads);
  const body = [
    'I am a deterministic mock: no LLM, no network, and nothing live. Every answer is computed from the seeded demo data and says so, with its assumptions and the evidence status of every value ratio.',
    `Data in hand: ${world.workloads.length} workloads${world.teams.length > 0 ? ` across ${world.teams.length} teams` : ''}, ${r.spend > 0 ? `${usd(r.spend)}/mo of spend` : 'spend'}, model list prices, alerts, savings findings. Not in the data: revenue or EBITDA baselines, hosting costs, open-model quality, measured outcomes.`,
    'Question types:',
    '• ROI (value, cost, ratio, evidence status, ranked contributors, weakest and strongest) for the portfolio, a team, a workload or a model',
    '• Team ranking by cost, ROI or savings, and team to workload drill-down',
    '• Tokens, cache hit rate and unit cost; alerts; outcome evidence',
    '• Savings by team or workload; cost drivers inside a team',
    '• EBITDA impact after spend goes down (the identity is stated; percentages need a baseline you type)',
    '• Public API to private open model: monthly cost, saving, break-even, payback and cost to realized savings, from labelled illustrative assumptions you can override',
    'Drill-down ladder: portfolio → team → workload → model, token, cache and unit cost → alerts and outcome evidence. I remember the last subject for follow-ups such as "what about its workloads?" (the last 12 messages only).',
  ];
  return {
    header: '**What I can answer**',
    body,
    next: [
      'Which team is driving the highest cost?',
      s.team ? `Show the workloads in the ${s.team} team and their ROI` : 'What is the ROI of the portfolio?',
      s.workload ? `What if we moved ${s.workload} to a private open model?` : 'How much can we save?',
    ],
    referenced: [],
  };
}

/** Plain rendering: unsupported answers carry no analytics, so no assumptions block. */
export function unsupportedText(world: World, why?: string): string {
  return [
    UNSUPPORTED_HEADER,
    why ?? 'That is outside what the seeded demo data holds: I do not have it, and I will not make a number up.',
    'Not in the data: revenue or EBITDA baselines, hosting costs, open-model quality, measured outcomes, forecasts, anything per customer or per user.',
    basisLine(world.asOf),
    'Closest questions I can answer:',
    ...starterQuestions(world).slice(0, 4).map((q) => `• "${q}"`),
  ].join('\n');
}

export function clarifyText(world: World, wanted: 'team' | 'workload' | 'model' | 'any'): string {
  const what = wanted === 'any' ? 'team, workload or model' : wanted;
  return [
    CLARIFY_HEADER,
    `I can't tell what that refers to: there is no ${what} earlier in this conversation (I only look back at the last 12 messages), and I won't guess.`,
    'Name it and I will answer, for example:',
    ...starterQuestions(world).slice(0, 3).map((q) => `• "${q}"`),
    basisLine(world.asOf),
  ].join('\n');
}

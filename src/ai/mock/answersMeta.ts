// Capability ladder, unsupported and clarify answers.

import { rollup } from './calc';
import { basisLine, evid, returnText, usd } from './format';
import type { Answer, World } from './types';

const UNSUPPORTED_HEADER = "**I can't answer that from this data**";
const CLARIFY_HEADER = '**Which one do you mean?**';

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

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What is in view, with spend always paired with its Value / cost and weakest evidence status (R4). */
export function dataLine(world: World): string {
  if (world.workloads.length === 0) return 'No workloads are in this view yet.';
  const r = rollup(world.workloads);
  const teams = world.teams.length > 0 ? ` across ${plural(world.teams.length, 'team')}` : '';
  const spend = r.spend > 0 ? `, ${usd(r.spend)}/mo of spend at ${returnText(r.ratio)}${evid(r.evidence)}` : '';
  return `In this view: ${plural(world.workloads.length, 'workload')}${teams}${spend}.`;
}

/** One line on what Frank is, shared by the identity and capability answers. */
export const WHO_I_AM =
  "Frank Coster, Ratio's FinOps accountability partner. I'm a deterministic assistant, not a generative AI model: fixed rules compute every answer from the data in this view, so the same question in the same conversation always gets the same answer.";

/** What Frank does, in executive terms. */
export const WHAT_I_DO = [
  'Show cost, value and Value / cost for the portfolio, a team, a workload or a model, with the evidence status of every figure',
  'Rank teams, explain what drives cost and find savings',
  'Estimate EBITDA impact and the cost of moving a workload to a private open model, with every assumption stated',
];

/** What Frank does not have or do. */
export const CANNOT_DO = [
  'Use data that is not in this view: revenue or EBITDA baselines, hosting costs, open-model quality, measured outcomes, forecasts, or anything per customer or per user',
  "Act for you: I don't change budgets, approve spend or look anything up live. Approvals stay with the accountable owner",
  'Guess: when a question is outside the data, I say so instead of making up a number',
];

export function capabilityAnswer(world: World): Answer {
  const s = sampleNames(world);
  const body = [
    'Who I am:',
    WHO_I_AM,
    'What I can answer:',
    '• ROI for the portfolio, a team, a workload or a model: value, cost, Value / cost, evidence status, and the strongest and weakest contributors',
    '• Which teams cost the most, return the most or can save the most, and their workloads',
    '• Tokens, cache hit rate and unit cost; alerts; outcome evidence',
    '• Savings and cost drivers by team or workload',
    '• EBITDA impact when spend goes down (percentages need a baseline you type)',
    '• Moving a workload from a public API to a private open model: monthly cost, saving, break-even and payback, from illustrative assumptions you can override',
    "What I can't do:",
    ...CANNOT_DO.map((c) => `• ${c}`),
    'Follow-ups:',
    'Go from portfolio to team to workload to model, tokens, alerts and outcome evidence. I remember the last subject for follow-ups such as "what about its workloads?" (the last 12 messages only).',
    dataLine(world),
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
    why ?? 'That is outside what the demo dataset holds: I do not have it, and I will not make a number up.',
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

/** Disclosure for workloads excluded because their wire figures were out of range; null when none. */
export function rejectedNote(world: World): string | null {
  const n = world.rejected.length;
  if (n === 0) return null;
  const names = world.rejected.slice(0, 3).map((r) => r.slice(0, 70)).join(', ');
  return `Note: figures for ${names}${n > 3 ? `, and ${n - 3} more` : ''} were out of range and ignored; they are excluded from every number here.`;
}

/** The user named something that is not in the data: say so, never fall back silently. */
export function unknownNameText(world: World, u: { name: string; team: boolean }): string {
  const head = u.team
    ? `**I don't have a team called ${u.name}**`
    : `**I don't have a team, workload or model called "${u.name}"**`;
  const teams = world.teams.length > 0 ? `Teams are: ${world.teams.slice(0, 20).join(', ')}.` : 'No team data is present in this context.';
  return [
    head,
    teams,
    'I did not substitute anything else for it; name one of these and I will answer.',
    ...(rejectedNote(world) ? [rejectedNote(world) as string] : []),
    basisLine(world.asOf),
    'Closest questions I can answer:',
    ...starterQuestions(world).slice(0, 3).map((q) => `\u2022 "${q}"`),
  ].join('\n');
}

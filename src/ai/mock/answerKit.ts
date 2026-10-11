// Small shared pieces for answer builders: list rows, the R4 context line, the
// scope-aware "next questions" ladder, and the standing realized-savings line.

import type { EvidenceStatus } from '@/types';
import { evid, returnText, usd, x } from './format';
import { membersOf, rollup, scopeLabel } from './calc';
import type { Scope, World, WorkloadFacts } from './types';

export const REALIZED_LINE =
  'Realized savings: $0 — no measured outcome evidence exists in the seeded data (everything here is projected or assumed).';

export const short = (s: EvidenceStatus | undefined): string => `(${s ?? 'unmarked'})`;

/** "the Legal team" — always qualified so the question parses back to the team. */
export const T = (team: string): string => `the ${team} team`;

/** R4 line: cost is never shown without its value ratio and evidence status. */
export function contextLine(world: World, scope: Scope): string {
  const members = membersOf(world, scope);
  const r = rollup(members);
  return `Context: ${scopeLabel(world, scope)} costs ${usd(r.spend)}/mo at ${returnText(r.ratio)}${evid(r.evidence)}.`;
}

/** Numbered workload row: cost, value, ratio, evidence. */
export function workloadRow(i: number, w: WorkloadFacts): string {
  return `${i + 1}. ${w.name} — cost ${usd(w.monthlySpend)}/mo · value ${usd(w.monthlyValue)}/mo · ${x(w.ratio)} ${short(w.evidence)}`;
}

/** Next-question ladder for a scope: drill one level down, sideways, or into finance. */
export function ladder(world: World, scope: Scope, from: 'roi' | 'workloads' | 'tokens' | 'alerts' | 'outcomes' | 'savings' | 'cost'): string[] {
  const members = membersOf(world, scope);
  const sorted = [...members].sort((a, b) => b.monthlySpend - a.monthlySpend);
  const top = sorted[0];
  const rated = members.filter((w) => w.ratio !== null).sort((a, b) => (a.ratio as number) - (b.ratio as number));
  const weak = rated[0] ?? top;
  const label = scopeLabel(world, scope);
  const pick = (...qs: (string | null)[]): string[] => qs.filter((q): q is string => Boolean(q)).slice(0, 3);

  if (scope.kind === 'portfolio') {
    const teams = world.teams.length > 0;
    return pick(
      teams ? 'Which team is driving the highest cost?' : null,
      teams ? 'Which team has the weakest ROI?' : null,
      weak ? `What is the ROI of ${weak.name}?` : null,
      'What can you answer, and how deep can you go?',
    );
  }
  if (scope.kind === 'team') {
    const t = T(scope.team);
    switch (from) {
      case 'workloads':
        return pick(
          weak ? `What is the ROI of ${weak.name}?` : null,
          top ? `Show token and unit cost detail for ${top.name}` : null,
          `Any alerts for ${t}?`,
        );
      case 'alerts':
      case 'outcomes':
        return pick(`Show the workloads in ${t} and their ROI`, `How much can we save in ${t}?`, `What if we moved ${t} to a private open model?`);
      default:
        return pick(
          `Show the workloads in ${t} and their ROI`,
          `What is the EBITDA impact for ${t} if spend went down $2,000 a month?`,
          `What if we moved ${t} to a private open model?`,
        );
    }
  }
  if (scope.kind === 'workload') {
    const n = label;
    const team = members[0]?.team;
    switch (from) {
      case 'tokens':
        return pick(`Any alerts for ${n}?`, `What if we moved ${n} to a private open model?`, `What is the ROI of ${n}?`);
      case 'alerts':
        return pick(`Is there outcome evidence for ${n}?`, `Show token and unit cost detail for ${n}`, `What is the ROI of ${n}?`);
      case 'outcomes':
        return pick(`What is the ROI of ${n}?`, `What if we moved ${n} to a private open model?`, `Any alerts for ${n}?`);
      case 'workloads':
        return pick(`Is there outcome evidence for ${n}?`, team ? `What is the ROI of ${T(team)}?` : `Any alerts for ${n}?`, `What if we moved ${n} to a private open model?`);
      default:
        return pick(`Show token and unit cost detail for ${n}`, `Any alerts for ${n}?`, `What if we moved ${n} to a private open model?`);
    }
  }
  // model
  const m = scope.model;
  return pick(
    from === 'workloads' ? `Show token and unit cost detail for ${m}` : `Which workloads run on ${m}?`,
    from === 'tokens' ? `What is the ROI of ${m}?` : `Show token and unit cost detail for ${m}`,
    `What if we moved the ${m} workloads to a private open model?`,
  );
}

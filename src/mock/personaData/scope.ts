// Card A3: the local scope type and the one place a scope filters lines.
//
// Structurally the same as the A1 scope (`teams` is a list or '*', `envs` is a
// list); card B8 asserts assignability. An empty list means "nothing", never
// "everything": an empty `teams` or `envs` selects no line.

import type { LineItem } from './dataset';

export interface Scope {
  teams: string[] | '*';
  envs: string[];
}

export function isEmptyScope(scope: Scope): boolean {
  return scope.envs.length === 0 || (scope.teams !== '*' && scope.teams.length === 0);
}

export function inScope(line: Pick<LineItem, 'team' | 'env'>, scope: Scope): boolean {
  if (isEmptyScope(scope)) return false;
  const teamOk = scope.teams === '*' || scope.teams.includes(line.team);
  return teamOk && scope.envs.includes(line.env);
}

/** The scope filter. Every aggregate in projections.ts is computed after it. */
export function filterLines(lines: readonly LineItem[], scope: Scope): LineItem[] {
  return lines.filter((l) => inScope(l, scope));
}

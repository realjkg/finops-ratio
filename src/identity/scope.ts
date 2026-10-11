// The shared scope helper (PLAN 4.2 and 4.6): one rule for "may this principal
// see data owned by this team in this environment", used by authorize() and by
// every data seam that filters rows (cards B2, B5, B8).
//
// Rules (fail closed):
// - `teams: '*'` covers every real team; an array covers exactly its members
//   (case-sensitive, no trimming). '*' inside an array is a literal team name,
//   never a wildcard. An empty array covers nothing.
// - A team value of '*' or '' is never a real team and is covered by no one.
// - A row with no known team is visible only to an org-wide principal
//   (`teams: '*'`): ownership cannot be shown to anyone narrower.
// - A row's env must be a mapped `DeployEnv` listed in the principal's `envs`.
//   `null` means the source value did not map (envMap returned null) and is
//   visible to no one. An absent env (unknown) is visible only to a principal
//   that holds every DeployEnv.
import { DEPLOY_ENVS, isDeployEnv, type DeployEnv, type Principal } from './types';

export interface ScopeKey {
  team?: string;
  env?: DeployEnv | null;
}

type ScopeOf = Pick<Principal, 'teams' | 'envs'>;

function isRealTeam(team: unknown): team is string {
  return typeof team === 'string' && team !== '' && team !== '*';
}

/** Whether the principal's team claim covers a known, real team. */
export function teamCovered(teams: Principal['teams'], team: string): boolean {
  if (!isRealTeam(team)) return false;
  if (teams === '*') return true;
  return Array.isArray(teams) && teams.some((t) => t === team);
}

/** Whether the principal's env claim covers a mapped DeployEnv. */
export function envCovered(envs: Principal['envs'], env: unknown): boolean {
  return isDeployEnv(env) && Array.isArray(envs) && envs.some((e) => e === env);
}

/** Whether the principal holds every DeployEnv (needed for rows of unknown env). */
function holdsEveryEnv(envs: Principal['envs']): boolean {
  return DEPLOY_ENVS.every((e) => envCovered(envs, e));
}

/** True when a row with this team and environment is inside the principal's scope. */
export function inScope(principal: ScopeOf, key: ScopeKey): boolean {
  if (!principal || typeof principal !== 'object') return false;
  const { teams, envs } = principal;
  if (Array.isArray(teams) ? teams.length === 0 : teams !== '*') return false;
  if (!Array.isArray(envs) || envs.length === 0) return false;

  if (key.team === undefined) {
    if (teams !== '*') return false;
  } else if (!teamCovered(teams, key.team)) {
    return false;
  }

  if (key.env === undefined) return holdsEveryEnv(envs);
  return envCovered(envs, key.env);
}

/** The rows inside the principal's scope, in their original order. */
export function filterByScope<T>(principal: ScopeOf, rows: readonly T[], keyOf: (row: T) => ScopeKey): T[] {
  return rows.filter((row) => inScope(principal, keyOf(row)));
}

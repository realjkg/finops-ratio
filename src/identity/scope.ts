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

/** An array's own elements only: holes and inherited indexes are skipped (the
 * built-in iteration methods would read Array.prototype through a hole). The
 * result is a dense array built by push, so the array methods used on it
 * below (`some`) only ever see own elements. Every caller-supplied array in
 * this module goes through ownList or an own-index loop; DEPLOY_ENVS is a
 * frozen module constant. */
function ownList(a: unknown): unknown[] | null {
  if (!Array.isArray(a)) return null;
  const out: unknown[] = [];
  for (let i = 0; i < a.length; i += 1) if (Object.hasOwn(a, i)) out.push(a[i]);
  return out;
}

/** An object's own field, never one inherited through the prototype chain. */
function ownField(o: unknown, key: string): unknown {
  return o !== null && typeof o === 'object' && Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined;
}

/** Whether the principal's team claim covers a known, real team. */
export function teamCovered(teams: Principal['teams'], team: string): boolean {
  if (!isRealTeam(team)) return false;
  if (teams === '*') return true;
  return ownList(teams)?.some((t) => t === team) ?? false;
}

/** Whether the principal's env claim covers a mapped DeployEnv. */
export function envCovered(envs: Principal['envs'], env: unknown): boolean {
  return isDeployEnv(env) && (ownList(envs)?.some((e) => e === env) ?? false);
}

/** Whether a teams claim covers at least one real team ("*", or a list with a real team name). */
export function hasRealTeam(teams: unknown): boolean {
  return teams === '*' || (ownList(teams)?.some(isRealTeam) ?? false);
}

/** Whether the principal holds every DeployEnv (needed for rows of unknown env). */
function holdsEveryEnv(envs: Principal['envs']): boolean {
  return DEPLOY_ENVS.every((e) => envCovered(envs, e));
}

/**
 * True when a row with this team and environment is inside the principal's
 * scope. Only OWN principal claims and OWN row keys count: an inherited claim
 * is no claim, and an inherited row key is treated as unknown (fail closed).
 * Any exception (for example a revoked Proxy) means out of scope.
 */
export function inScope(principal: ScopeOf, key: ScopeKey): boolean {
  try {
    const teams = ownField(principal, 'teams') as Principal['teams'];
    const envs = ownField(principal, 'envs') as Principal['envs'];
    if (!hasRealTeam(teams)) return false;
    if (!(ownList(envs)?.some((e) => isDeployEnv(e)) ?? false)) return false;

    const team = ownField(key, 'team');
    const env = ownField(key, 'env');
    if (team === undefined) {
      if (teams !== '*') return false;
    } else if (typeof team !== 'string' || !teamCovered(teams, team)) {
      return false;
    }

    if (env === undefined) return holdsEveryEnv(envs);
    return envCovered(envs, env);
  } catch {
    return false;
  }
}

/**
 * The rows inside the principal's scope, in their original order. Only the
 * array's own indexes are visited (Array.prototype.filter would also visit an
 * inherited index through a hole), and a row whose keyOf throws is excluded.
 */
export function filterByScope<T>(principal: ScopeOf, rows: readonly T[], keyOf: (row: T) => ScopeKey): T[] {
  const out: T[] = [];
  if (!Array.isArray(rows)) return out;
  for (let i = 0; i < rows.length; i += 1) {
    if (!Object.hasOwn(rows, i)) continue;
    const row = rows[i];
    let key: ScopeKey;
    try {
      key = keyOf(row);
    } catch {
      continue; // fail closed: a row whose scope cannot be read is not shown
    }
    if (inScope(principal, key)) out.push(row);
  }
  return out;
}

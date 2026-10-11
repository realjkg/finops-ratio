// The shared scope rule (PLAN 4.6) for authorize() and the data seams, fail closed:
// teams '*' covers every real team, a list exactly its members and needs one real
// team ('*' and '' are not teams); a row with no team is for '*' only, an
// unmapped env (null) for no one, no env for holders of every env. Only OWN
// fields and indexes count; arrays over a cap are invalid before any scan.
import { DEPLOY_ENVS, isOneOf, type DeployEnv, type Principal } from './types';

/** Upper bound for a teams or envs claim. */
export const MAX_CLAIM = 256;
/** Upper bound for the rows passed to filterByScope. */
export const MAX_ROWS = 100_000;

/** The own elements of an array no longer than `max`; null for anything else, including a throwing Proxy. */
export function ownArray(a: unknown, max = MAX_CLAIM): unknown[] | null {
  try {
    if (!Array.isArray(a) || a.length > max) return null;
    const out: unknown[] = [];
    for (let i = 0; i < a.length; i += 1) if (Object.hasOwn(a, i)) out.push(a[i]);
    return out;
  } catch {
    return null;
  }
}

/** A null-prototype copy of the listed own fields (arrays via ownArray) of a non-array object; else undefined. */
export function ownRecord<K extends string>(o: unknown, keys: readonly K[]): Partial<Record<K, unknown>> | undefined {
  try {
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return undefined;
    const copy = Object.create(null) as Partial<Record<K, unknown>>;
    for (const k of keys) {
      if (!Object.hasOwn(o, k)) continue;
      const v = (o as Record<K, unknown>)[k];
      copy[k] = Array.isArray(v) ? ownArray(v) : v;
    }
    return copy;
  } catch {
    return undefined; // a throwing Proxy or getter is no record
  }
}

const isRealTeam = (t: unknown): t is string => typeof t === 'string' && t !== '' && t !== '*';
// Own, capped elements only (never throws: ownArray fails closed).
export const hasRealTeam = (teams: unknown): boolean => teams === '*' || !!ownArray(teams)?.some(isRealTeam);
export const teamCovered = (teams: unknown, team: unknown): boolean => isRealTeam(team) && (teams === '*' || !!ownArray(teams)?.includes(team));
export const envCovered = (envs: unknown, env: unknown): boolean => isOneOf(DEPLOY_ENVS, env) && !!ownArray(envs)?.includes(env);

export interface ScopeKey {
  team?: string;
  env?: DeployEnv | null;
}

/** True when a row with this team and env is inside the principal's scope. */
export function inScope(principal: Pick<Principal, 'teams' | 'envs'>, key: ScopeKey): boolean {
  const p = ownRecord(principal, ['teams', 'envs'] as const);
  const k = ownRecord(key, ['team', 'env'] as const);
  if (!p || !k || !hasRealTeam(p.teams) || !DEPLOY_ENVS.some((e) => envCovered(p.envs, e))) return false;
  if (k.team === undefined ? p.teams !== '*' : !teamCovered(p.teams, k.team)) return false;
  return k.env === undefined ? DEPLOY_ENVS.every((e) => envCovered(p.envs, e)) : envCovered(p.envs, k.env);
}

/** The rows inside the principal's scope, in order; [] for more than MAX_ROWS rows or if a keyOf throws. */
export function filterByScope<T>(principal: Pick<Principal, 'teams' | 'envs'>, rows: readonly T[], keyOf: (row: T) => ScopeKey): T[] {
  try {
    return ((ownArray(rows, MAX_ROWS) ?? []) as T[]).filter((row) => inScope(principal, keyOf(row)));
  } catch {
    return [];
  }
}

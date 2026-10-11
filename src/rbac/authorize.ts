// The one decision function (PLAN 3.3, 4.2): pure, table-driven, deny by
// default. Every route check (card B1's `requires` and `decide()`) and the MCP
// client (card B5) call it; the permission data is in ./matrix.ts.
//
// Verdicts: 401 when there is no verified principal; 403 for a role, team,
// environment or resource the grant does not cover; 409 only for a state
// conflict on a change (apply in prod while the change or its bound ticket is
// not approved). Reasons are fixed text and never echo the input.
//
// authorize() trusts nothing about its arguments' shape: inputs may come from
// decoded JSON, so every field is checked at runtime, lookups never consult
// the prototype chain, and extra fields are ignored.
import {
  isAction,
  isAuthMethod,
  isChangeImpact,
  isDeployEnv,
  isResourceKind,
  isRole,
  isTicketState,
  type Action,
  type Principal,
  type Resource,
  type Role,
  type Verdict,
} from '@/identity/types';
import { envCovered, teamCovered } from '@/identity/scope';
import {
  ACTION_MATRIX,
  ACTION_ROUTE_GROUPS,
  READABLE_CODES,
  VIEW_GROUPS,
  cellFor,
  findRoute,
  type ActionRow,
  type MatrixAction,
} from './matrix';

export const DENY_REASONS = Object.freeze({
  noPrincipal: 'Authentication required',
  unknownRole: 'Role not permitted',
  roleMethodMismatch: 'Role not permitted for this credential',
  unknownAction: 'Action not permitted',
  noScope: 'Principal has no scope',
  badResource: 'Resource not permitted',
  envNotPermitted: 'Environment not permitted',
  teamNotPermitted: 'Team not permitted',
  roleNotPermitted: 'Role not permitted for this action',
  viewNotPermitted: 'View not permitted',
  actionNotEnabled: 'Action not enabled',
  impactNotPermitted: 'Change impact not permitted for this role',
  separationOfDuties: 'Requester and approver must differ',
  requesterMismatch: 'Requester must be the caller',
  noBoundTicket: 'A bound ticket is required',
  changeNotApproved: 'Change is not approved',
  ticketNotApproved: 'Ticket is not approved',
});

type Reason = (typeof DENY_REASONS)[keyof typeof DENY_REASONS];

const ALLOW: Verdict = Object.freeze({ allow: true });

function deny(status: 401 | 403 | 409, reason: Reason): Verdict {
  return { allow: false, status, reason };
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const PRINCIPAL_KEYS = ['sub', 'role', 'teams', 'envs', 'tenant', 'tokenId', 'expiresAt', 'authMethod'] as const;
const RESOURCE_KEYS = ['kind', 'id', 'team', 'env', 'requesterSub', 'approverSub', 'ticketState', 'impact'] as const;

/** An array's own elements only (holes and inherited indexes are skipped). */
function ownElements(a: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < a.length; i += 1) if (Object.hasOwn(a, i)) out.push(a[i]);
  return out;
}

/**
 * A null-prototype copy holding only the listed OWN properties of `o`, so a
 * field inherited through the prototype chain (for example a JSON "__proto__"
 * key merged with Object.assign, or an Object.create principal) never takes
 * part in a decision. Array-valued fields (teams, envs) are copied element
 * by element the same way. Non-objects pass through unchanged and fail the
 * shape checks. An array (including a Proxy over one, which Array.isArray
 * sees through) is never a principal or a resource: it becomes undefined, so
 * the caller gets 401 or 403. A Proxy over a plain object cannot be detected
 * without a server-only module; each listed field is read once into the copy,
 * so it can only state values its creator could have written directly.
 */
function ownCopy<K extends string>(o: unknown, keys: readonly K[]): unknown {
  if (!o || typeof o !== 'object') return o;
  if (Array.isArray(o)) return undefined;
  const copy = Object.create(null) as Record<K, unknown>;
  for (const k of keys) {
    if (!Object.hasOwn(o, k)) continue;
    const v = (o as Record<K, unknown>)[k];
    copy[k] = Array.isArray(v) ? ownElements(v) : v;
  }
  return copy;
}

/** A verified principal's shape; anything else is treated as no principal (401). */
function isPrincipalShape(p: unknown): p is Principal {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  const o = p as Record<string, unknown>;
  const teamsOk = o.teams === '*' || (Array.isArray(o.teams) && o.teams.every((t) => typeof t === 'string'));
  return (
    isNonEmptyString(o.sub) &&
    typeof o.role === 'string' &&
    teamsOk &&
    Array.isArray(o.envs) &&
    typeof o.tenant === 'string' &&
    typeof o.tokenId === 'string' &&
    typeof o.expiresAt === 'number' &&
    Number.isFinite(o.expiresAt) &&
    isAuthMethod(o.authMethod)
  );
}

/** legacy_service exists only for the shared token, and the shared token yields only legacy_service. */
function roleMatchesAuthMethod(role: Role, method: Principal['authMethod']): boolean {
  return (role === 'legacy_service') === (method === 'legacy-shared-token');
}

function hasAnyScope(p: Principal): boolean {
  const teamsOk = p.teams === '*' || p.teams.length > 0;
  return teamsOk && p.envs.some((e) => isDeployEnv(e));
}

function actionRow(action: Action): ActionRow | undefined {
  return action !== 'view.read' && Object.hasOwn(ACTION_MATRIX, action) ? ACTION_MATRIX[action as MatrixAction] : undefined;
}

/** May the role read this view or route (PLAN 4.4)? Scope is applied by the data seam. */
function readView(role: Role, kind: Resource['kind'], id: string): Verdict {
  if (kind !== 'view' && kind !== 'route') return deny(403, DENY_REASONS.badResource);
  const row = findRoute(id);
  if (!row) return deny(403, DENY_REASONS.viewNotPermitted);
  if ((kind === 'route') !== (row.kind === 'api')) return deny(403, DENY_REASONS.viewNotPermitted);
  if (row.status === 'public') return ALLOW;
  if (row.status === 'sim_only' || row.status === 'signed') return deny(403, DENY_REASONS.viewNotPermitted);
  const code = role === 'legacy_service' ? row.legacyService : VIEW_GROUPS[row.group].codes[role];
  return READABLE_CODES.includes(code) ? ALLOW : deny(403, DENY_REASONS.viewNotPermitted);
}

export function authorize(
  principalInput: Principal | null | undefined,
  action: Action,
  resourceInput: Resource,
): Verdict {
  // 0. Decide on own properties only (see ownCopy).
  const principal = ownCopy(principalInput, PRINCIPAL_KEYS);
  const resource = ownCopy(resourceInput, RESOURCE_KEYS) as Resource;

  // 1. Authentication: no verified principal, no access.
  if (!isPrincipalShape(principal)) return deny(401, DENY_REASONS.noPrincipal);
  const p = principal;

  // 2. Vocabulary: unknown roles, actions and resources are denied.
  if (!isRole(p.role)) return deny(403, DENY_REASONS.unknownRole);
  if (!roleMatchesAuthMethod(p.role, p.authMethod)) return deny(403, DENY_REASONS.roleMethodMismatch);
  if (!isAction(action)) return deny(403, DENY_REASONS.unknownAction);
  if (!resource || typeof resource !== 'object' || !isResourceKind(resource.kind) || typeof resource.id !== 'string') {
    return deny(403, DENY_REASONS.badResource);
  }
  if (!hasAnyScope(p)) return deny(403, DENY_REASONS.noScope);

  // 3. Scope: a stated environment and team must be inside the claims.
  const { kind, id, team, env } = resource;
  if (env !== undefined && !envCovered(p.envs, env)) return deny(403, DENY_REASONS.envNotPermitted);
  if (team !== undefined && !teamCovered(p.teams, team)) return deny(403, DENY_REASONS.teamNotPermitted);

  // 4. Reading a view or route: PLAN 4.4.
  if (action === 'view.read') return readView(p.role, kind, id);

  // 5. Every other action: PLAN 4.5, per environment.
  const row = actionRow(action);
  if (!row) return deny(403, DENY_REASONS.unknownAction);
  if (row.deferred) return deny(403, DENY_REASONS.actionNotEnabled);
  if (!row.kinds.includes(kind)) return deny(403, DENY_REASONS.badResource);
  if (env === undefined) return deny(403, DENY_REASONS.envNotPermitted);

  const cell = cellFor(row, p.role, env);
  if (cell === 'n') return deny(403, DENY_REASONS.roleNotPermitted);

  if (kind === 'view' || kind === 'route') {
    const read = readView(p.role, kind, id);
    if (!read.allow) return read;
    const only = Object.hasOwn(ACTION_ROUTE_GROUPS, action) ? ACTION_ROUTE_GROUPS[action as MatrixAction] : undefined;
    if (only && !only.includes(id)) return deny(403, DENY_REASONS.badResource);
  }

  // A change or ticket must be shown to be the caller's: its owning team is
  // required unless the principal is org-wide, and always for a Y* cell.
  // On mcp_tool, audit and view or route resources a Y* cell (eng_lead
  // mcp.read, audit.read, view.export) is a role-level check here: team
  // scoping of the returned data is deferred to the seams that serve it
  // (B5 MCP client, C5 audit read, B8 data provider).
  if (kind === 'change' || kind === 'ticket') {
    if (team === undefined && (p.teams !== '*' || cell === 'Y*' || cell === 'A')) {
      return deny(403, DENY_REASONS.teamNotPermitted);
    }
  }

  const impactRule = row.requiresImpact && Object.hasOwn(row.requiresImpact, p.role) ? row.requiresImpact[p.role] : undefined;
  if (impactRule !== undefined && !(isChangeImpact(resource.impact) && resource.impact === impactRule)) {
    return deny(403, DENY_REASONS.impactNotPermitted);
  }

  if (action === 'change.request') {
    if (resource.requesterSub !== undefined && resource.requesterSub !== p.sub) {
      return deny(403, DENY_REASONS.requesterMismatch);
    }
  }

  if (action === 'change.approve') {
    if (!isNonEmptyString(resource.requesterSub) || resource.requesterSub === p.sub) {
      return deny(403, DENY_REASONS.separationOfDuties);
    }
  }

  if (cell === 'A') {
    const ticket = resource.ticketState;
    if (!isTicketState(ticket) || ticket === 'none') return deny(403, DENY_REASONS.noBoundTicket);
    if (!isNonEmptyString(resource.requesterSub)) return deny(403, DENY_REASONS.separationOfDuties);
    if (!isNonEmptyString(resource.approverSub)) return deny(409, DENY_REASONS.changeNotApproved);
    if (resource.approverSub === resource.requesterSub) return deny(403, DENY_REASONS.separationOfDuties);
    if (ticket !== 'approved') return deny(409, DENY_REASONS.ticketNotApproved);
  }

  return ALLOW;
}

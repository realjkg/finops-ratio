// The one pure decision (PLAN 4.2), deny by default: 401 no principal; 403 role,
// team, env or resource not covered; 409 only for a prod apply of an unapproved
// change or ticket. Only OWN fields are copied (ownRecord, which fails closed on a
// throwing Proxy); arrays are never inputs. eng_lead Y* on mcp.read, audit.read, view.export is a role check here;
// the serving seam (B5, C5, B8) scopes the data.
import { ACTIONS, DEPLOY_ENVS, ROLES, isOneOf, type Action, type Principal, type Resource, type Role, type Verdict } from '@/identity/types';
import { envCovered, hasRealTeam, ownRecord, teamCovered } from '@/identity/scope';
import { ACTION_MATRIX, READABLE_CODES, VIEW_GROUPS, findRoute, type MatrixAction } from './matrix';

export const DENY_REASONS = Object.freeze({
  noPrincipal: 'Authentication required',
  role: 'Role not permitted',
  action: 'Action not permitted',
  resource: 'Resource not permitted',
  scope: 'Scope not permitted',
  disabled: 'Action not enabled',
  impact: 'Change impact not permitted for this role',
  duties: 'Requester and approver must differ',
  requester: 'Requester must be the caller',
  noTicket: 'A bound ticket is required',
  changeNotApproved: 'Change is not approved',
  ticketNotApproved: 'Ticket is not approved',
});
type Reason = (typeof DENY_REASONS)[keyof typeof DENY_REASONS];

const ALLOW: Verdict = Object.freeze({ allow: true });
const deny = (status: 401 | 403 | 409, reason: Reason): Verdict => ({ allow: false, status, reason });
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

const PRINCIPAL_KEYS = ['sub', 'role', 'teams', 'envs', 'tenant', 'tokenId', 'expiresAt', 'authMethod'] as const;
const RESOURCE_KEYS = ['kind', 'id', 'team', 'env', 'requesterSub', 'approverSub', 'ticketState', 'impact'] as const;
const KINDS = ['view', 'route', 'change', 'ticket', 'mcp_tool', 'audit'] as const;
const AUTH_METHODS = ['mock-idp', 'oidc', 'legacy-shared-token'] as const;

function isPrincipal(o: Record<string, unknown> | undefined): o is Record<string, unknown> & Principal {
  return (
    !!o && nonEmpty(o.sub) && typeof o.role === 'string' && Array.isArray(o.envs) &&
    (o.teams === '*' || (Array.isArray(o.teams) && o.teams.every((t) => typeof t === 'string'))) &&
    typeof o.tenant === 'string' && typeof o.tokenId === 'string' && Number.isFinite(o.expiresAt) &&
    isOneOf(AUTH_METHODS, o.authMethod)
  );
}

/** PLAN 4.4: may the role read this page or API route? Rows are scoped by the data seam. */
function readView(role: Role, kind: string, id: string): Verdict {
  const row = findRoute(id);
  if ((kind !== 'view' && kind !== 'route') || !row || (kind === 'route') !== (row.kind === 'api')) return deny(403, DENY_REASONS.resource);
  if (row.status === 'public') return ALLOW;
  if (row.status === 'sim_only' || row.status === 'signed') return deny(403, DENY_REASONS.resource);
  const code = role === 'legacy_service' ? row.legacyService : VIEW_GROUPS[row.group].codes[role];
  return READABLE_CODES.includes(code) ? ALLOW : deny(403, DENY_REASONS.role);
}

export function authorize(principalInput: Principal | null | undefined, action: Action, resourceInput: Resource): Verdict {
  const p = ownRecord(principalInput, PRINCIPAL_KEYS);
  if (!isPrincipal(p)) return deny(401, DENY_REASONS.noPrincipal);
  // legacy_service exists only for the shared token, and the shared token yields only legacy_service.
  if (!isOneOf(ROLES, p.role) || (p.role === 'legacy_service') !== (p.authMethod === 'legacy-shared-token')) {
    return deny(403, DENY_REASONS.role);
  }
  if (!isOneOf(ACTIONS, action)) return deny(403, DENY_REASONS.action);
  const res = ownRecord(resourceInput, RESOURCE_KEYS) as Partial<Resource> | undefined;
  if (!res || !isOneOf(KINDS, res.kind) || typeof res.id !== 'string') return deny(403, DENY_REASONS.resource);
  const { kind, id, team, env } = res;
  if (!hasRealTeam(p.teams) || !p.envs.some((e) => isOneOf(DEPLOY_ENVS, e))) return deny(403, DENY_REASONS.scope);
  if (env !== undefined && !envCovered(p.envs, env)) return deny(403, DENY_REASONS.scope);
  if (team !== undefined && !teamCovered(p.teams, team)) return deny(403, DENY_REASONS.scope);

  if (action === 'view.read') return readView(p.role, kind, id);

  const row = ACTION_MATRIX[action as MatrixAction];
  if (row.deferred) return deny(403, DENY_REASONS.disabled);
  if (!row.kinds.includes(kind)) return deny(403, DENY_REASONS.resource);
  if (env === undefined) return deny(403, DENY_REASONS.scope); // every action but view.read needs a mapped env
  const cell = row.cells[p.role][DEPLOY_ENVS.indexOf(env)];
  if (cell === 'n') return deny(403, DENY_REASONS.role);

  if (kind === 'view' || kind === 'route') {
    const read = readView(p.role, kind, id);
    if (!read.allow) return read;
    if (row.routes && !row.routes.includes(id)) return deny(403, DENY_REASONS.resource);
  }
  // A change or ticket must be shown to be the caller's: its team is required
  // unless the principal is org-wide, and always for a Y* or A cell.
  if ((kind === 'change' || kind === 'ticket') && team === undefined && (p.teams !== '*' || cell !== 'Y')) {
    return deny(403, DENY_REASONS.scope);
  }
  const impact = row.requiresImpact?.[p.role];
  if (impact !== undefined && res.impact !== impact) return deny(403, DENY_REASONS.impact);
  if (action === 'change.request' && res.requesterSub !== undefined && res.requesterSub !== p.sub) {
    return deny(403, DENY_REASONS.requester);
  }
  if (action === 'change.approve' && (!nonEmpty(res.requesterSub) || res.requesterSub === p.sub)) {
    return deny(403, DENY_REASONS.duties);
  }
  if (cell === 'A') {
    const ticket = res.ticketState;
    if (ticket !== 'open' && ticket !== 'approved' && ticket !== 'rejected') return deny(403, DENY_REASONS.noTicket);
    if (!nonEmpty(res.requesterSub)) return deny(403, DENY_REASONS.duties);
    if (!nonEmpty(res.approverSub)) return deny(409, DENY_REASONS.changeNotApproved);
    if (res.approverSub === res.requesterSub) return deny(403, DENY_REASONS.duties);
    if (ticket !== 'approved') return deny(409, DENY_REASONS.ticketNotApproved);
  }
  return ALLOW;
}

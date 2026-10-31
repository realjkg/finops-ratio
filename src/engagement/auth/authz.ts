// R2: the one authorization service for engagement data. Every customer-data
// request (report page, report facts, XLSX/PDF/JSON exports, connector config
// and actions) asks authorize(): deny by default. It checks, in order: a
// principal (the server session's user) that exists and is active; the
// resource's tenant and engagement, which come from the server's engagement
// config and never from the request; an ACTIVE membership of the user in that
// tenant and engagement; then the permission, granted by the membership's role
// or by one of the user's teams. The directory is re-read per request, so a
// role, team or suspension change applies to the next decision. Fixed reasons,
// never input echoes. Framework-agnostic (no HTTP types): principal +
// permission + resource in, decision out, plus an optional audit hook, so any
// authenticator (the R2 session now; a later tool gateway or agent adapter)
// can call it unchanged. SERVER-ONLY.
import type { Directory } from './directory';

export const PERMISSIONS = ['reports:read', 'reports:export', 'connectors:read', 'connectors:manage', 'members:manage', 'identity:manage'] as const;
export type Permission = (typeof PERMISSIONS)[number];
/** Connector management never implies identity, membership or secret access. */
export const ROLE_PERMISSIONS = Object.freeze({
  viewer: ['reports:read'],
  analyst: ['reports:read', 'reports:export', 'connectors:read'],
  connector_manager: ['connectors:read', 'connectors:manage'],
  tenant_admin: ['reports:read', 'reports:export', 'connectors:read', 'members:manage', 'identity:manage'],
} as const satisfies Record<string, readonly Permission[]>);
export type Role = keyof typeof ROLE_PERMISSIONS;
/** What a team may grant. Admin permissions (connectors:manage, members:manage, identity:manage) are role-only. */
export const TEAM_GRANTABLE: readonly Permission[] = Object.freeze(['reports:read', 'reports:export', 'connectors:read']);

export const DENY = Object.freeze({
  authentication: 'Authentication required',
  principalKind: 'Principal kind not permitted',
  tenant: 'Resource not permitted',
  membership: 'No active membership for this engagement',
  permission: 'Permission not granted',
});
/**
 * Who is asking, as resolved by an authenticator (never from a request body).
 * 'user': a directory user; the R2 session yields one. 'agent': RESERVED for a
 * later tenant-bound, explicitly provisioned non-human principal with its own
 * role assignments and no interactive session; not implemented, always denied.
 * Never carries a role: the role is read from the directory per decision.
 */
export type Principal =
  | { kind: 'user'; id: string; tenantId: string; engagementId: string }
  | { kind: 'agent'; id: string; tenantId: string; engagementId: string };
export const RESOURCE_TYPES = ['report', 'connector', 'member', 'identity_connection', 'team'] as const;
/** A protected resource: stable type and id, the server-side tenant and engagement, and a version when the model has one (e.g. the config sha256). */
export interface Resource { type: (typeof RESOURCE_TYPES)[number]; id: string; tenantId: string; engagementId: string; version?: string }
export type Decision = { allow: true; principal: { kind: 'user'; id: string }; role: Role; teams: string[] } | { allow: false; status: 401 | 403; reason: string };
/** One record per decision: identities and outcome only, never report contents, credentials or directory data. */
export interface AuditEvent {
  principalKind: Principal['kind'] | 'none'; principalId: string | null; permission: string;
  resourceType: string; resourceId: string; resourceVersion?: string; tenantId: string; engagementId: string;
  outcome: 'allow' | 'deny'; status: 200 | 401 | 403; reason?: string;
}

function decide(dir: Directory, principal: Principal | null | undefined, permission: Permission, r: Resource): Decision {
  const deny = (status: 401 | 403, reason: string): Decision => ({ allow: false, status, reason });
  if (!principal) return deny(401, DENY.authentication);
  if (principal.kind !== 'user') return deny(403, DENY.principalKind);
  const user = dir.users.get(String(principal.id).toLowerCase());
  if (!user || user.id !== principal.id || user.status !== 'active') return deny(401, DENY.authentication);
  const valid = (RESOURCE_TYPES as readonly string[]).includes(r.type) && typeof r.id === 'string' && r.id !== '' && (r.version === undefined || typeof r.version === 'string');
  if (!valid || principal.tenantId !== r.tenantId || principal.engagementId !== r.engagementId) return deny(403, DENY.tenant);
  const m = dir.memberships.get(user.id);
  if (!m || m.status !== 'active' || m.tenantId !== r.tenantId || m.engagementId !== r.engagementId) return deny(403, DENY.membership);
  if (!(PERMISSIONS as readonly string[]).includes(permission)) return deny(403, DENY.permission);
  const teams = dir.teamsOf(user.id).filter((t) => t.tenantId === r.tenantId);
  const granted = (ROLE_PERMISSIONS[m.role] as readonly Permission[]).includes(permission) || (TEAM_GRANTABLE.includes(permission) && teams.some((t) => t.permissions.includes(permission)));
  return granted ? { allow: true, principal: { kind: 'user', id: user.id }, role: m.role, teams: teams.map((t) => t.id) } : deny(403, DENY.permission);
}

/** Called once per decision; may be async. Its failures are isolated (see emit). */
export type AuditHook = (e: AuditEvent) => void | Promise<void>;

export function authorize(dir: Directory, principal: Principal | null | undefined, permission: Permission, resource: Resource, audit?: AuditHook): Decision {
  const d = decide(dir, principal, permission, resource);
  if (audit) runAuditHook(audit, {
    principalKind: principal?.kind ?? 'none', principalId: principal ? String(principal.id) : null, permission: String(permission),
    resourceType: String(resource.type), resourceId: String(resource.id), ...(resource.version !== undefined ? { resourceVersion: String(resource.version) } : {}),
    tenantId: String(resource.tenantId), engagementId: String(resource.engagementId),
    ...(d.allow ? { outcome: 'allow', status: 200 } : { outcome: 'deny', status: d.status, reason: d.reason }),
  });
  return d;
}

const HOOK_FAILED = '{"event":"authz_audit_hook_failed"}';
/**
 * A failing hook, sync or async, never changes or loses the decision; its error
 * text is never propagated or logged, and a rejected promise is always handled.
 */
export function runAuditHook<E>(audit: (e: E) => void | Promise<void>, e: E): void {
  try {
    const r: unknown = audit(e);
    if (r && typeof (r as PromiseLike<void>).then === 'function') (r as PromiseLike<void>).then(undefined, () => console.error(HOOK_FAILED));
  } catch {
    console.error(HOOK_FAILED);
  }
}

// R2: the one authorization service for engagement data. Every customer-data
// request (report page, report facts, XLSX/PDF/JSON exports, connector config
// and actions) asks authorize(): deny by default. It checks, in order: a
// principal (the server session's user) that exists and is active; the
// resource's tenant and engagement, which come from the server's engagement
// config and never from the request; an ACTIVE membership of the user in that
// tenant and engagement; then the permission, granted by the membership's role
// or by one of the user's teams. The directory is re-read per request, so a
// role, team or suspension change applies to the next decision. Fixed reasons,
// never input echoes. SERVER-ONLY.
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

export const DENY = Object.freeze({
  authentication: 'Authentication required',
  tenant: 'Resource not permitted',
  membership: 'No active membership for this engagement',
  permission: 'Permission not granted',
});
/** What a session carries: who, and the tenant and engagement it was issued for. Never a role (read per request). */
export interface Principal { userId: string; tenantId: string; engagementId: string }
export interface Resource { tenantId: string; engagementId: string }
export type Decision = { allow: true; userId: string; role: Role; teams: string[] } | { allow: false; status: 401 | 403; reason: string };

const deny = (status: 401 | 403, reason: string): Decision => ({ allow: false, status, reason });

export function authorize(dir: Directory, principal: Principal | null | undefined, permission: Permission, resource: Resource): Decision {
  const user = principal ? dir.users.get(String(principal.userId).toLowerCase()) : undefined;
  if (!principal || !user || user.id !== principal.userId || user.status !== 'active') return deny(401, DENY.authentication);
  if (principal.tenantId !== resource.tenantId || principal.engagementId !== resource.engagementId) return deny(403, DENY.tenant);
  const m = dir.memberships.get(user.id);
  if (!m || m.status !== 'active' || m.tenantId !== resource.tenantId || m.engagementId !== resource.engagementId) return deny(403, DENY.membership);
  if (!(PERMISSIONS as readonly string[]).includes(permission)) return deny(403, DENY.permission);
  const teams = dir.teamsOf(user.id).filter((t) => t.tenantId === resource.tenantId);
  const granted = (ROLE_PERMISSIONS[m.role] as readonly Permission[]).includes(permission) || teams.some((t) => t.permissions.includes(permission));
  return granted ? { allow: true, userId: user.id, role: m.role, teams: teams.map((t) => t.id) } : deny(403, DENY.permission);
}

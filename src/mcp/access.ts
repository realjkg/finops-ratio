// Authorization for MCP tools (PLAN 4.5 and 5.2, DESIGN 3.8). Purpose: one function
// that decides whether a principal may see or call a tool, used by both tools/list and
// tools/call so the two cannot disagree. Trust boundary: the verdict needs BOTH the
// pure RBAC decision, authorize(principal, 'mcp.read', {kind:'mcp_tool', id, env, team?}),
// AND the role's tool class (summary, cost, commitment). Either alone is a deny.
// Anything that is not exactly a read tool is checked as 'mcp.write', which the matrix
// denies for every role in every environment until owner decision D6.
import { authorize } from '@/rbac/authorize';
import type { Action, DeployEnv, Principal, Resource, Role } from '@/identity/types';
import type { ToolClass, ToolDefinition } from './tools';

export type AccessDecision = { allow: true } | { allow: false; reason: 'unauthenticated' | 'not_authorized' };

/**
 * Which tool classes each role may use. From the PLAN 4.5 cell notes: the CTO gets summary
 * tools, finance cost tools, procurement commitment tools; the FinOps lead, engineering
 * lead (own teams only, enforced by authorize and the provider scope) and auditor get all.
 * legacy_service gets none. Proposed until the owner ratifies the matrix (D2).
 */
export const ROLE_TOOL_CLASSES: Readonly<Record<Role, readonly ToolClass[]>> = Object.freeze({
  cto: Object.freeze(['summary'] as const),
  finops_lead: Object.freeze(['summary', 'cost', 'commitment'] as const),
  finance: Object.freeze(['cost'] as const),
  eng_lead: Object.freeze(['summary', 'cost', 'commitment'] as const),
  procurement: Object.freeze(['commitment'] as const),
  auditor: Object.freeze(['summary', 'cost', 'commitment'] as const),
  legacy_service: Object.freeze([] as const),
});

/** Own-key lookup; an unknown or prototype-named role has no classes. */
export function classesForRole(role: unknown): readonly ToolClass[] {
  return typeof role === 'string' && Object.hasOwn(ROLE_TOOL_CLASSES, role) ? ROLE_TOOL_CLASSES[role as Role] : [];
}

export function roleSeesTool(role: unknown, tool: Pick<ToolDefinition, 'classes'>): boolean {
  const allowed = classesForRole(role);
  return tool.classes.some((c) => allowed.includes(c));
}

export function decideToolAccess(
  principal: Principal,
  tool: Pick<ToolDefinition, 'name' | 'access' | 'classes'>,
  env: DeployEnv,
  team?: string,
): AccessDecision {
  const action: Action = tool.access === 'read' ? 'mcp.read' : 'mcp.write';
  const resource: Resource = team === undefined ? { kind: 'mcp_tool', id: tool.name, env } : { kind: 'mcp_tool', id: tool.name, env, team };
  const verdict = authorize(principal, action, resource);
  if (!verdict.allow) return { allow: false, reason: verdict.status === 401 ? 'unauthenticated' : 'not_authorized' };
  if (action !== 'mcp.read' || !roleSeesTool(principal.role, tool)) return { allow: false, reason: 'not_authorized' };
  return { allow: true };
}

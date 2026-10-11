// The contract between cards (PLAN 4.2) plus the revision 8 amendment.

export type Role =
  | 'cto' | 'finops_lead' | 'finance' | 'eng_lead' | 'procurement' | 'auditor'
  | 'legacy_service'; // internal: the shared RATIO_API_TOKEN principal; not a persona
export type PersonaRole = Exclude<Role, 'legacy_service'>;
export type DeployEnv = 'dev' | 'test' | 'prod';

export interface Principal {
  sub: string; // stable subject id, never an email in logs
  role: Role;
  teams: string[] | '*'; // '*' = all teams; a list needs at least one real team
  envs: DeployEnv[]; // environments this token may act in
  tenant: string;
  tokenId: string; // the JWT jti
  expiresAt: number; // epoch seconds
  authMethod: 'mock-idp' | 'oidc' | 'legacy-shared-token';
}

export type Action =
  | 'view.read' | 'view.export'
  | 'change.request' | 'change.approve' | 'change.apply'
  | 'ticket.create' | 'ticket.attach' | 'ticket.status' | 'ticket.bind' | 'ticket.update' | 'ticket.get'
  | 'mcp.read' | 'mcp.write'
  | 'budget.edit' | 'connector.manage' | 'ingest.write' | 'audit.read';
export type TicketState = 'none' | 'open' | 'approved' | 'rejected';
export type ChangeImpact = 'cost' | 'commitment' | 'operational'; // set server-side, never from a request body

export interface Resource {
  kind: 'view' | 'route' | 'change' | 'ticket' | 'mcp_tool' | 'audit';
  id: string; // view or route id from the matrix, change id, or tool name
  team?: string;
  env?: DeployEnv; // already mapped (envMap.ts)
  requesterSub?: string; // change only
  approverSub?: string; // change only
  ticketState?: TicketState; // change only: live state of the bound ticket
  impact?: ChangeImpact; // change only
}

export type Verdict =
  | { allow: true }
  | { allow: false; status: 401 | 403 | 409; reason: string }; // fixed text, never echoes input

export interface TokenVerifier {
  verify(bearer: string, ctx: { now: number; deployEnv: DeployEnv }): Promise<Principal>; // throws on any failure
}

export const PERSONA_ROLES: readonly PersonaRole[] = Object.freeze(['cto', 'finops_lead', 'finance', 'eng_lead', 'procurement', 'auditor'] as const);
export const ROLES: readonly Role[] = Object.freeze([...PERSONA_ROLES, 'legacy_service'] as const);
/** Matrix cells are written `dev / test / prod`, in this order. */
export const DEPLOY_ENVS: readonly DeployEnv[] = Object.freeze(['dev', 'test', 'prod'] as const);
export const ACTIONS: readonly Action[] = Object.freeze([
  'view.read', 'view.export', 'change.request', 'change.approve', 'change.apply',
  'ticket.create', 'ticket.attach', 'ticket.status', 'ticket.bind', 'ticket.update', 'ticket.get',
  'mcp.read', 'mcp.write', 'budget.edit', 'connector.manage', 'ingest.write', 'audit.read',
] as const);

/** Membership in a constant list; a non-string or prototype key never matches. */
export const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

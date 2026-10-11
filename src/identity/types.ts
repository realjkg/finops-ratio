// The contract between cards (PLAN 4.2), implemented literally by card A1.
// Every other card builds against these types; change them only through a
// plan revision. Includes the pending amendment (Copilot revision 8): the
// ticket.update, ticket.bind and ticket.get actions, `Resource.impact`, and the
// fail-closed `legacy_service` grant (see src/rbac/matrix.ts).

export type Role =
  | 'cto' | 'finops_lead' | 'finance' | 'eng_lead' | 'procurement' | 'auditor'
  | 'legacy_service'; // internal: the shared RATIO_API_TOKEN principal; not a persona

/** The six persona roles (PLAN 4.1). `legacy_service` is not a persona. */
export type PersonaRole = Exclude<Role, 'legacy_service'>;

export type DeployEnv = 'dev' | 'test' | 'prod';

export interface Principal {
  sub: string; // stable subject id, never an email in logs
  role: Role;
  teams: string[] | '*'; // '*' = all teams; an empty array grants none
  envs: DeployEnv[]; // environments this token may act in
  tenant: string; // tenant id; replaces the djb2 token hash (F2)
  tokenId: string; // the JWT jti, used for replay and revocation
  expiresAt: number; // epoch seconds
  authMethod: 'mock-idp' | 'oidc' | 'legacy-shared-token';
}

export type Action =
  | 'view.read' | 'view.export'
  | 'change.request' | 'change.approve' | 'change.apply'
  | 'ticket.create' | 'ticket.attach' | 'ticket.status'
  | 'ticket.bind' | 'ticket.update' | 'ticket.get' // amendment: C3 lifecycle operations
  | 'mcp.read' | 'mcp.write'
  | 'budget.edit' | 'connector.manage' | 'ingest.write' | 'audit.read';

export type TicketState = 'none' | 'open' | 'approved' | 'rejected';

/**
 * What a change affects, set server-side from the stored change (never from a
 * request body). It qualifies who may approve (PLAN 4.5): Finance approves
 * cost impact only, Procurement commitment impact only.
 */
export type ChangeImpact = 'cost' | 'commitment' | 'operational';

export interface Resource {
  kind: 'view' | 'route' | 'change' | 'ticket' | 'mcp_tool' | 'audit';
  id: string; // view or route id from the matrix, change id, or tool name
  team?: string; // owning team of the data or change
  env?: DeployEnv; // already mapped (src/identity/envMap.ts)
  requesterSub?: string; // change only: who requested it
  approverSub?: string; // change only: who approved it, if anyone
  ticketState?: TicketState; // change only: the live state of the bound ticket
  impact?: ChangeImpact; // change only: set server-side (amendment)
}

export type Verdict =
  | { allow: true }
  | { allow: false; status: 401 | 403 | 409; reason: string }; // fixed text, never echoes input

export interface TokenVerifier {
  verify(bearer: string, ctx: { now: number; deployEnv: DeployEnv }): Promise<Principal>; // throws on any failure
}

// Runtime lists, so tests and route checks can enumerate the vocabulary.
export const PERSONA_ROLES: readonly PersonaRole[] = Object.freeze([
  'cto', 'finops_lead', 'finance', 'eng_lead', 'procurement', 'auditor',
] as const);

export const ROLES: readonly Role[] = Object.freeze([...PERSONA_ROLES, 'legacy_service'] as const);

/** Order matters: matrix cells are written `dev / test / prod`. */
export const DEPLOY_ENVS: readonly DeployEnv[] = Object.freeze(['dev', 'test', 'prod'] as const);

export const ACTIONS: readonly Action[] = Object.freeze([
  'view.read', 'view.export',
  'change.request', 'change.approve', 'change.apply',
  'ticket.create', 'ticket.attach', 'ticket.status',
  'ticket.bind', 'ticket.update', 'ticket.get',
  'mcp.read', 'mcp.write',
  'budget.edit', 'connector.manage', 'ingest.write', 'audit.read',
] as const);

export const TICKET_STATES: readonly TicketState[] = Object.freeze(['none', 'open', 'approved', 'rejected'] as const);

export const CHANGE_IMPACTS: readonly ChangeImpact[] = Object.freeze(['cost', 'commitment', 'operational'] as const);

export const AUTH_METHODS: readonly Principal['authMethod'][] = Object.freeze([
  'mock-idp', 'oidc', 'legacy-shared-token',
] as const);

export const RESOURCE_KINDS: readonly Resource['kind'][] = Object.freeze([
  'view', 'route', 'change', 'ticket', 'mcp_tool', 'audit',
] as const);

// Membership checks that never consult the prototype chain.
const has = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

export const isRole = (v: unknown): v is Role => has(ROLES, v);
export const isAction = (v: unknown): v is Action => has(ACTIONS, v);
export const isDeployEnv = (v: unknown): v is DeployEnv => has(DEPLOY_ENVS, v);
export const isTicketState = (v: unknown): v is TicketState => has(TICKET_STATES, v);
export const isChangeImpact = (v: unknown): v is ChangeImpact => has(CHANGE_IMPACTS, v);
export const isAuthMethod = (v: unknown): v is Principal['authMethod'] => has(AUTH_METHODS, v);
export const isResourceKind = (v: unknown): v is Resource['kind'] => has(RESOURCE_KINDS, v);

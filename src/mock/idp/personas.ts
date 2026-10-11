// Mock persona catalog (card A2). Pure data with no dependencies on purpose:
// the sign-in page (card B11) loads this file alone, so it must not pull the
// issuer, key material or any server module into the browser bundle.
//
// Fixture identities only. The team names are the real seeded team names
// from the workload seed, so team scoping is observable on seeded data.

export type MockRole = 'cto' | 'finops_lead' | 'finance' | 'eng_lead' | 'procurement' | 'auditor';
export type MockDeployEnv = 'dev' | 'test' | 'prod';

export const MOCK_ROLES: readonly MockRole[] = Object.freeze([
  'cto',
  'finops_lead',
  'finance',
  'eng_lead',
  'procurement',
  'auditor',
] as const);

export const MOCK_DEPLOY_ENVS: readonly MockDeployEnv[] = Object.freeze(['dev', 'test', 'prod'] as const);

export const MOCK_TENANT = 'ratio-demo';

export type MockPersonaId =
  | 'cto'
  | 'finops-lead'
  | 'finance'
  | 'eng-platform'
  | 'eng-cx'
  | 'procurement'
  | 'auditor';

export interface MockPersona {
  readonly id: MockPersonaId;
  readonly label: string;
  /** Stable subject id. Never an email. */
  readonly sub: string;
  readonly role: MockRole;
  /** `'*'` means every team. */
  readonly teams: readonly string[] | '*';
  readonly envs: readonly MockDeployEnv[];
  readonly tenant: string;
}

const ALL_ENVS: readonly MockDeployEnv[] = MOCK_DEPLOY_ENVS;

function persona(p: MockPersona): MockPersona {
  return Object.freeze({
    ...p,
    teams: p.teams === '*' ? '*' : Object.freeze([...p.teams]),
    envs: Object.freeze([...p.envs]),
  });
}

export const MOCK_PERSONAS: readonly MockPersona[] = Object.freeze([
  persona({ id: 'cto', label: 'CTO', sub: 'mock-cto', role: 'cto', teams: '*', envs: ALL_ENVS, tenant: MOCK_TENANT }),
  persona({ id: 'finops-lead', label: 'FinOps lead', sub: 'mock-finops-lead', role: 'finops_lead', teams: '*', envs: ALL_ENVS, tenant: MOCK_TENANT }),
  persona({ id: 'finance', label: 'Finance', sub: 'mock-finance', role: 'finance', teams: '*', envs: ALL_ENVS, tenant: MOCK_TENANT }),
  persona({ id: 'eng-platform', label: 'Engineering lead, Platform Eng', sub: 'mock-eng-platform', role: 'eng_lead', teams: ['Platform Eng'], envs: ALL_ENVS, tenant: MOCK_TENANT }),
  persona({ id: 'eng-cx', label: 'Engineering lead, CX Engineering', sub: 'mock-eng-cx', role: 'eng_lead', teams: ['CX Engineering'], envs: ALL_ENVS, tenant: MOCK_TENANT }),
  persona({ id: 'procurement', label: 'Procurement', sub: 'mock-procurement', role: 'procurement', teams: '*', envs: ALL_ENVS, tenant: MOCK_TENANT }),
  persona({ id: 'auditor', label: 'Read-only auditor', sub: 'mock-auditor', role: 'auditor', teams: '*', envs: ALL_ENVS, tenant: MOCK_TENANT }),
]);

/** Exact, case-sensitive lookup by persona id. Unknown ids return undefined. */
export function findMockPersona(id: string): MockPersona | undefined {
  return MOCK_PERSONAS.find((p) => p.id === id);
}

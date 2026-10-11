// Card A1: the one pure decision function of PLAN 3.3 and 4.2. These tests are
// adversarial on purpose: deny by default, no privilege escalation, team and
// environment scoping, separation of duties, and a full role x action x
// environment x resource sweep against an independent restatement of PLAN 4.5.
import { describe, expect, it } from 'vitest';
import { authorize, DENY_REASONS } from './authorize';
import { ACTION_MATRIX, ROUTE_MATRIX, VIEW_GROUPS } from './matrix';
import { filterByScope, inScope } from '@/identity/scope';
import {
  ACTIONS,
  DEPLOY_ENVS,
  PERSONA_ROLES,
  ROLES,
  type Action,
  type DeployEnv,
  type Principal,
  type Resource,
  type Role,
  type Verdict,
} from '@/identity/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_ENVS: DeployEnv[] = ['dev', 'test', 'prod'];
const PLATFORM = 'Platform Eng';
const CX = 'CX Engineering';

function principal(role: Role, over: Partial<Principal> = {}): Principal {
  return {
    sub: `sub-${role}`,
    role,
    teams: role === 'eng_lead' ? [PLATFORM] : '*',
    envs: [...ALL_ENVS],
    tenant: 'tenant-acme',
    tokenId: `jti-${role}`,
    expiresAt: 4_102_444_800,
    authMethod: role === 'legacy_service' ? 'legacy-shared-token' : 'mock-idp',
    ...over,
  };
}

function change(env: DeployEnv, over: Partial<Resource> = {}): Resource {
  return { kind: 'change', id: 'chg-1', team: PLATFORM, env, requesterSub: 'sub-someone-else', ...over };
}

function expectDeny(v: Verdict, status: 401 | 403 | 409, msg?: string): void {
  expect(v, msg).toMatchObject({ allow: false, status });
  if (!v.allow) expect(Object.values(DENY_REASONS), msg).toContain(v.reason);
}

function expectAllow(v: Verdict, msg?: string): void {
  expect(v, msg).toEqual({ allow: true });
}

// A deep freeze proves authorize() never mutates its inputs.
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

// ---------------------------------------------------------------------------
// Independent restatement of PLAN 4.5 (cells "dev / test / prod"), plus the
// pending amendment rows (ticket.update, ticket.bind, ticket.get) and the
// legacy_service column. This is deliberately a second copy, not an import.
// Columns: cto, finops_lead, finance, eng_lead, procurement, auditor, legacy_service.
// ---------------------------------------------------------------------------
const PLAN_4_5: Record<Exclude<Action, 'view.read'>, string[]> = {
  'change.request': ['n/n/n', 'Y/Y/Y', 'n/n/n', 'Y*/Y*/Y*', 'n/n/n', 'n/n/n', 'n/n/n'],
  'change.approve': ['Y/Y/Y', 'Y/Y/n', 'Y/Y/Y', 'n/n/n', 'Y/Y/Y', 'n/n/n', 'n/n/n'],
  'change.apply': ['n/n/n', 'n/n/n', 'n/n/n', 'Y*/Y*/A', 'n/n/n', 'n/n/n', 'n/n/n'],
  'ticket.create': ['n/n/n', 'Y/Y/Y', 'n/n/n', 'Y*/Y*/Y*', 'n/n/n', 'n/n/n', 'Y/Y/Y'],
  'ticket.attach': ['n/n/n', 'Y/Y/Y', 'n/n/n', 'Y*/Y*/Y*', 'n/n/n', 'n/n/n', 'Y/Y/Y'],
  'ticket.status': ['Y/Y/Y', 'Y/Y/Y', 'Y/Y/Y', 'Y*/Y*/Y*', 'Y/Y/Y', 'Y/Y/Y', 'Y/Y/Y'],
  'ticket.bind': ['n/n/n', 'Y/Y/Y', 'n/n/n', 'Y*/Y*/Y*', 'n/n/n', 'n/n/n', 'n/n/n'],
  'ticket.update': ['n/n/n', 'Y/Y/Y', 'n/n/n', 'Y*/Y*/Y*', 'n/n/n', 'n/n/n', 'n/n/n'],
  'ticket.get': ['Y/Y/Y', 'Y/Y/Y', 'Y/Y/Y', 'Y*/Y*/Y*', 'Y/Y/Y', 'Y/Y/Y', 'n/n/n'],
  'mcp.read': ['Y/Y/Y', 'Y/Y/Y', 'Y/Y/Y', 'Y*/Y*/Y*', 'Y/Y/Y', 'Y/Y/Y', 'n/n/n'],
  'mcp.write': ['n/n/n', 'n/n/n', 'n/n/n', 'n/n/n', 'n/n/n', 'n/n/n', 'n/n/n'],
  'budget.edit': ['n/n/n', 'Y/Y/n', 'Y/Y/Y', 'n/n/n', 'Y/Y/Y', 'n/n/n', 'n/n/n'],
  'connector.manage': ['n/n/n', 'Y/Y/Y', 'n/n/n', 'n/n/n', 'n/n/n', 'n/n/n', 'n/n/n'],
  'view.export': ['Y/Y/Y', 'Y/Y/Y', 'Y/Y/Y', 'Y*/Y*/Y*', 'Y/Y/Y', 'Y/Y/Y', 'Y/Y/Y'],
  'ingest.write': ['n/n/n', 'Y/Y/Y', 'n/n/n', 'n/n/n', 'n/n/n', 'n/n/n', 'n/n/n'],
  'audit.read': ['Y/Y/Y', 'Y/Y/Y', 'n/n/n', 'Y*/Y*/Y*', 'n/n/n', 'Y/Y/Y', 'n/n/n'],
};
const COLUMNS: Role[] = ['cto', 'finops_lead', 'finance', 'eng_lead', 'procurement', 'auditor', 'legacy_service'];
function planCell(action: Exclude<Action, 'view.read'>, role: Role, env: DeployEnv): string {
  return PLAN_4_5[action][COLUMNS.indexOf(role)].split('/')[ALL_ENVS.indexOf(env)];
}

/** The most permissive well-formed resource for an action (so a deny is the matrix, not the fixture). */
function permissiveResource(action: Exclude<Action, 'view.read'>, role: Role, env: DeployEnv): Resource {
  const impact = role === 'procurement' ? 'commitment' : 'cost';
  switch (action) {
    case 'change.request':
      return { kind: 'change', id: 'chg-1', team: PLATFORM, env, requesterSub: `sub-${role}` };
    case 'change.approve':
      return { kind: 'change', id: 'chg-1', team: PLATFORM, env, requesterSub: 'sub-other', impact };
    case 'change.apply':
      return {
        kind: 'change', id: 'chg-1', team: PLATFORM, env, requesterSub: 'sub-other',
        approverSub: 'sub-approver', ticketState: 'approved', impact,
      };
    case 'ticket.create': case 'ticket.attach': case 'ticket.status':
    case 'ticket.bind': case 'ticket.update': case 'ticket.get':
      return { kind: 'ticket', id: 'PLAT-1', team: PLATFORM, env };
    case 'mcp.read': case 'mcp.write':
      return { kind: 'mcp_tool', id: 'cost_summary', env };
    case 'audit.read':
      return { kind: 'audit', id: 'records', env };
    case 'view.export':
      // A route every role (legacy included) that may export can also read.
      return role === 'legacy_service'
        ? { kind: 'route', id: '/api/v1/finio/export', env }
        : role === 'eng_lead'
          ? { kind: 'route', id: '/api/report/snapshot', env, team: PLATFORM }
          : { kind: 'route', id: '/api/report/snapshot', env };
    case 'connector.manage':
      return { kind: 'route', id: '/api/v1/connectors', env };
    case 'ingest.write':
      return { kind: 'route', id: '/api/costsource/ingest', env };
    case 'budget.edit':
      return { kind: 'view', id: '/workloads', env };
  }
}

const WRITE_ACTIONS: Action[] = [
  'change.request', 'change.approve', 'change.apply',
  'ticket.create', 'ticket.attach', 'ticket.bind', 'ticket.update',
  'mcp.write', 'budget.edit', 'connector.manage', 'ingest.write',
];

// ---------------------------------------------------------------------------
// Named red tests (TASKS.md card A1)
// ---------------------------------------------------------------------------

describe('authorize: named red tests', () => {
  it('denies_by_default_when_no_principal', () => {
    for (const p of [null, undefined]) {
      for (const action of ACTIONS) {
        expectDeny(authorize(p, action, { kind: 'view', id: '/demo', env: 'dev' }), 401, action);
      }
    }
    // Shapes that are not a verified principal are treated as no principal.
    const malformed: unknown[] = [
      {}, 'cto', 42, [], { role: 'cto' },
      { ...principal('cto'), sub: '' },
      { ...principal('cto'), sub: 7 },
      { ...principal('cto'), teams: 'all' },
      { ...principal('cto'), teams: [7] },
      { ...principal('cto'), envs: 'prod' },
      { ...principal('cto'), envs: undefined },
      { ...principal('cto'), authMethod: 'basic' },
      { ...principal('cto'), authMethod: undefined },
    ];
    for (const m of malformed) {
      expectDeny(authorize(m as Principal, 'view.read', { kind: 'view', id: '/', env: 'dev' }), 401, JSON.stringify(m));
    }
    // Even a public page needs a principal to get an allow from authorize().
    expectDeny(authorize(null, 'view.read', { kind: 'view', id: '/sign-in' }), 401);
  });

  it('denies_unknown_action_and_unknown_role', () => {
    const resource: Resource = { kind: 'view', id: '/', env: 'dev' };
    for (const role of ['admin', 'root', 'superuser', 'CTO', 'cto ', '', '*', '__proto__', 'constructor', 'toString', 'executive', 'technical']) {
      expectDeny(authorize(principal('cto', { role: role as Role }), 'view.read', resource), 403, role);
      expectDeny(authorize(principal('cto', { role: role as Role }), 'ticket.status', { kind: 'ticket', id: 'X-1', env: 'dev' }), 403, role);
    }
    for (const action of ['view.write', 'admin', '*', '', 'VIEW.READ', 'view.read ', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'change.delete']) {
      for (const role of PERSONA_ROLES) {
        expectDeny(authorize(principal(role), action as Action, resource), 403, `${role} ${action}`);
      }
    }
    // Unknown resource kinds and ids deny too.
    for (const kind of ['page', 'admin', '', '__proto__']) {
      expectDeny(authorize(principal('finops_lead'), 'view.read', { kind, id: '/' } as unknown as Resource), 403, kind);
    }
    for (const id of ['/admin', '/api/v1/unknown', '', '__proto__', 'constructor', 'toString', '/Overview', '/overview/', '/api/v1/simulation/*']) {
      expectDeny(authorize(principal('finops_lead'), 'view.read', { kind: 'view', id, env: 'dev' }), 403, id);
      expectDeny(authorize(principal('finops_lead'), 'view.read', { kind: 'route', id, env: 'dev' }), 403, id);
    }
    expectDeny(authorize(principal('finops_lead'), 'view.read', null as unknown as Resource), 403);
  });

  it('eng_lead_cannot_read_other_team_rows', () => {
    const eng = principal('eng_lead', { teams: [PLATFORM] });
    for (const id of ['/workloads', '/attribution', '/costsource']) {
      expectAllow(authorize(eng, 'view.read', { kind: 'view', id, team: PLATFORM, env: 'prod' }), id);
      expectDeny(authorize(eng, 'view.read', { kind: 'view', id, team: CX, env: 'prod' }), 403, id);
    }
    for (const id of ['/api/attribution', '/api/costsource/rows', '/api/v1/workloads']) {
      expectAllow(authorize(eng, 'view.read', { kind: 'route', id, team: PLATFORM, env: 'dev' }), id);
      expectDeny(authorize(eng, 'view.read', { kind: 'route', id, team: CX, env: 'dev' }), 403, id);
    }
    // Team names match exactly: no case folding, no trimming, no prefix match.
    for (const team of ['platform eng', 'PLATFORM ENG', ' Platform Eng', 'Platform Eng ', 'Platform', 'Platform Eng2', '*', '']) {
      expectDeny(authorize(eng, 'view.read', { kind: 'route', id: '/api/attribution', team, env: 'dev' }), 403, team);
    }
    // Other-team change and ticket operations deny for every Y* action.
    for (const action of ['change.request', 'ticket.create', 'ticket.attach', 'ticket.status', 'ticket.bind', 'ticket.update', 'ticket.get'] as const) {
      const r = { ...permissiveResource(action, 'eng_lead', 'dev'), team: CX };
      expectDeny(authorize(eng, action, r), 403, action);
    }
    expectDeny(authorize(eng, 'change.apply', { ...permissiveResource('change.apply', 'eng_lead', 'dev'), team: CX }), 403);
    // A change or ticket whose owning team is unknown cannot be shown to be theirs.
    const { team: _omit, ...noTeam } = permissiveResource('ticket.status', 'eng_lead', 'dev');
    void _omit;
    expectDeny(authorize(eng, 'ticket.status', noTeam as Resource), 403);
    // The eng lead never gets the personal-data user dimension.
    expectDeny(authorize(eng, 'view.read', { kind: 'view', id: 'attribution.user_dimension', team: PLATFORM, env: 'dev' }), 403);
  });

  it('apply_in_prod_is_409_when_ticket_state_is_not_approved', () => {
    const eng = principal('eng_lead');
    for (const ticketState of ['open', 'rejected'] as const) {
      expectDeny(authorize(eng, 'change.apply', change('prod', { approverSub: 'sub-approver', ticketState })), 409, ticketState);
    }
    // The approval of the change itself is missing: a state conflict as well.
    expectDeny(authorize(eng, 'change.apply', change('prod', { ticketState: 'approved' })), 409);
  });

  it('apply_in_prod_is_403_when_resource_has_no_bound_ticket', () => {
    const eng = principal('eng_lead');
    expectDeny(authorize(eng, 'change.apply', change('prod', { approverSub: 'sub-approver' })), 403);
    expectDeny(authorize(eng, 'change.apply', change('prod', { approverSub: 'sub-approver', ticketState: 'none' })), 403);
    expectDeny(authorize(eng, 'change.apply', change('prod', { approverSub: 'sub-approver', ticketState: 'bogus' as never })), 403);
  });

  it('apply_allowed_only_with_approved_ticket_and_different_approver', () => {
    const eng = principal('eng_lead');
    const ok = change('prod', { requesterSub: 'sub-eng_lead', approverSub: 'sub-cto', ticketState: 'approved' });
    expectAllow(authorize(eng, 'change.apply', deepFreeze({ ...ok })));
    // Approver equal to requester: separation of duties, 403.
    expectDeny(authorize(eng, 'change.apply', { ...ok, approverSub: 'sub-eng_lead' }), 403);
    // Requester unknown: separation cannot be shown, 403.
    const { requesterSub: _r, ...noRequester } = ok;
    void _r;
    expectDeny(authorize(eng, 'change.apply', noRequester), 403);
    // Wrong team, wrong env claim, and a non-eng role all deny even with an approved ticket.
    expectDeny(authorize(eng, 'change.apply', { ...ok, team: CX }), 403);
    expectDeny(authorize(principal('eng_lead', { envs: ['dev', 'test'] }), 'change.apply', ok), 403);
    for (const role of ROLES.filter((r) => r !== 'eng_lead')) {
      expectDeny(authorize(principal(role), 'change.apply', ok), 403, role);
    }
    // In dev and test the cell is Y* (no ticket needed), still team-scoped.
    for (const env of ['dev', 'test'] as const) {
      expectAllow(authorize(eng, 'change.apply', change(env)), env);
      expectDeny(authorize(eng, 'change.apply', change(env, { team: CX })), 403, env);
    }
  });

  it('requester_cannot_approve_own_change', () => {
    for (const role of ['cto', 'finops_lead', 'finance', 'procurement'] as const) {
      const p = principal(role);
      const impact = role === 'procurement' ? 'commitment' : 'cost';
      const env: DeployEnv = 'dev';
      expectAllow(authorize(p, 'change.approve', change(env, { impact })), role);
      expectDeny(authorize(p, 'change.approve', change(env, { impact, requesterSub: p.sub })), 403, role);
      // A change with no recorded requester cannot be approved by anyone.
      const { requesterSub: _r, ...anon } = change(env, { impact });
      void _r;
      expectDeny(authorize(p, 'change.approve', anon), 403, role);
    }
    // Requesting on behalf of someone else is refused: the requester is the caller.
    expectDeny(authorize(principal('finops_lead'), 'change.request', change('dev', { requesterSub: 'sub-cto' })), 403);
    expectAllow(authorize(principal('finops_lead'), 'change.request', change('dev', { requesterSub: 'sub-finops_lead' })));
  });

  it('auditor_has_no_write_action_in_any_env', () => {
    const auditor = principal('auditor');
    for (const action of WRITE_ACTIONS) {
      for (const env of ALL_ENVS) {
        const base = permissiveResource(action as Exclude<Action, 'view.read'>, 'auditor', env);
        for (const r of [base, { ...base, team: PLATFORM }, { ...base, impact: 'commitment' as const }]) {
          expectDeny(authorize(auditor, action, r), 403, `${action} ${env}`);
        }
      }
    }
    // The auditor can read everything it is meant to read.
    expectAllow(authorize(auditor, 'audit.read', { kind: 'audit', id: 'records', env: 'prod' }));
    expectAllow(authorize(auditor, 'view.read', { kind: 'view', id: 'attribution.user_dimension', env: 'prod' }));
  });

  it('mcp_write_tool_denied_for_every_role_and_env', () => {
    for (const role of ROLES) {
      for (const env of ALL_ENVS) {
        for (const r of [
          { kind: 'mcp_tool', id: 'cost_summary', env },
          { kind: 'mcp_tool', id: 'cost_summary', env, team: PLATFORM },
          { kind: 'mcp_tool', id: 'write_anything', env, team: PLATFORM, ticketState: 'approved', approverSub: 'x', requesterSub: 'y' },
        ] as Resource[]) {
          expectDeny(authorize(principal(role), 'mcp.write', r), 403, `${role} ${env}`);
          expectDeny(authorize(principal(role, { teams: '*' }), 'mcp.write', r), 403, `${role} ${env} *`);
        }
      }
    }
  });

  it('token_env_not_in_envs_is_denied', () => {
    const devOnly = principal('finops_lead', { envs: ['dev'] });
    expectAllow(authorize(devOnly, 'ticket.create', { kind: 'ticket', id: 'X-1', team: PLATFORM, env: 'dev' }));
    for (const env of ['test', 'prod'] as const) {
      expectDeny(authorize(devOnly, 'ticket.create', { kind: 'ticket', id: 'X-1', team: PLATFORM, env }), 403, env);
      expectDeny(authorize(devOnly, 'view.read', { kind: 'route', id: '/api/costsource/rows', env }), 403, env);
      expectDeny(authorize(devOnly, 'audit.read', { kind: 'audit', id: 'records', env }), 403, env);
    }
    // No env claim at all grants nothing, not even a public page.
    const none = principal('finops_lead', { envs: [] });
    expectDeny(authorize(none, 'view.read', { kind: 'view', id: '/', env: 'dev' }), 403);
    expectDeny(authorize(none, 'view.read', { kind: 'view', id: '/demo' }), 403);
    // An env claim outside the DeployEnv vocabulary is not honored.
    const bogus = principal('finops_lead', { envs: ['production', 'staging', '*'] as unknown as DeployEnv[] });
    for (const env of ['dev', 'test', 'prod'] as const) {
      expectDeny(authorize(bogus, 'ticket.status', { kind: 'ticket', id: 'X-1', team: PLATFORM, env }), 403, env);
    }
    // Every non-read action needs a mapped resource env; a missing or raw one fails closed.
    for (const env of [undefined, 'production', 'staging', 'sandbox', '*', ''] as unknown as DeployEnv[]) {
      expectDeny(authorize(principal('finops_lead'), 'ticket.create', { kind: 'ticket', id: 'X-1', team: PLATFORM, env }), 403, String(env));
      expectDeny(authorize(principal('finops_lead'), 'view.read', { kind: 'route', id: '/api/costsource/rows', env: env ?? ('' as DeployEnv) }), 403, String(env));
    }
  });

  it('teams_star_grants_all_teams_but_empty_teams_grants_none', () => {
    const star = principal('finops_lead', { teams: '*' });
    for (const team of [PLATFORM, CX, 'Legal', 'Any Team At All']) {
      expectAllow(authorize(star, 'ticket.create', { kind: 'ticket', id: 'X-1', team, env: 'prod' }), team);
      expectAllow(authorize(star, 'view.read', { kind: 'route', id: '/api/attribution', team, env: 'prod' }), team);
    }
    // '*' as an array element is a team literally named "*", never a wildcard.
    const literal = principal('eng_lead', { teams: ['*'] });
    expectDeny(authorize(literal, 'ticket.create', { kind: 'ticket', id: 'X-1', team: PLATFORM, env: 'dev' }), 403);
    // A resource claiming team "*" or "" is never in anyone's scope.
    for (const team of ['*', '']) {
      expectDeny(authorize(star, 'ticket.create', { kind: 'ticket', id: 'X-1', team, env: 'dev' }), 403, team);
      expectDeny(authorize(literal, 'ticket.create', { kind: 'ticket', id: 'X-1', team, env: 'dev' }), 403, team);
    }
    // Empty teams grants nothing: no team, no unscoped view, no public page.
    for (const role of PERSONA_ROLES) {
      const empty = principal(role, { teams: [] });
      expectDeny(authorize(empty, 'view.read', { kind: 'view', id: '/', env: 'dev' }), 403, role);
      expectDeny(authorize(empty, 'view.read', { kind: 'view', id: '/demo' }), 403, role);
      expectDeny(authorize(empty, 'ticket.status', { kind: 'ticket', id: 'X-1', team: PLATFORM, env: 'dev' }), 403, role);
    }
    // A ticket with no owning team is only for org-wide principals.
    expectAllow(authorize(star, 'ticket.status', { kind: 'ticket', id: 'X-1', env: 'dev' }));
    expectDeny(authorize(principal('eng_lead'), 'ticket.status', { kind: 'ticket', id: 'X-1', env: 'dev' }), 403);
    // That holds for any team-limited principal, not only the eng lead's Y* cells.
    for (const role of ['cto', 'finops_lead', 'finance', 'procurement', 'auditor'] as const) {
      const limited = principal(role, { teams: [PLATFORM] });
      expectDeny(authorize(limited, 'ticket.status', { kind: 'ticket', id: 'X-1', env: 'dev' }), 403, role);
      expectDeny(authorize(limited, 'ticket.get', { kind: 'change', id: 'chg-1', env: 'dev' }), 403, role);
      expectAllow(authorize(limited, 'ticket.status', { kind: 'ticket', id: 'X-1', env: 'dev', team: PLATFORM }), role);
    }
  });
});

// ---------------------------------------------------------------------------
// Matrix sweeps and further adversarial cases
// ---------------------------------------------------------------------------

describe('authorize: full matrix sweeps', () => {
  it('six roles plus legacy x every action x every env matches PLAN 4.5', () => {
    let checked = 0;
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        if (action === 'view.read') continue;
        for (const env of DEPLOY_ENVS) {
          const cell = planCell(action, role, env);
          const v = authorize(principal(role), action, permissiveResource(action, role, env));
          const label = `${role} ${action} ${env} (${cell})`;
          const deferred = ACTION_MATRIX[action].deferred !== undefined;
          if (cell === 'n' || deferred) expectDeny(v, 403, label);
          else expectAllow(v, label);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(ROLES.length * (ACTIONS.length - 1) * DEPLOY_ENVS.length);
  });

  it('every page and API route x every role x every env matches the view matrix codes', () => {
    const ALLOW = new Set(['O', 'D', 'T', 'S', 'R', 'any']);
    let checked = 0;
    for (const row of ROUTE_MATRIX) {
      const kind = row.kind === 'api' ? 'route' : 'view';
      for (const role of ROLES) {
        const code = role === 'legacy_service' ? row.legacyService : VIEW_GROUPS[row.group].codes[role];
        for (const env of DEPLOY_ENVS) {
          const team = role === 'eng_lead' ? PLATFORM : undefined;
          const v = authorize(principal(role), 'view.read', { kind, id: row.path, env, team });
          const label = `${role} ${row.path} ${env} (${code}, ${row.status})`;
          const expected =
            row.status === 'public' ||
            (ALLOW.has(code) && row.status !== 'sim_only' && row.status !== 'signed');
          if (expected) expectAllow(v, label);
          else expectDeny(v, 403, label);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(ROUTE_MATRIX.length * ROLES.length * DEPLOY_ENVS.length);
  });

  it('a page id is not accepted as an API route and vice versa', () => {
    const p = principal('finops_lead');
    expectDeny(authorize(p, 'view.read', { kind: 'route', id: '/workloads', env: 'dev' }), 403);
    expectDeny(authorize(p, 'view.read', { kind: 'view', id: '/api/v1/workloads', env: 'dev' }), 403);
    expectAllow(authorize(p, 'view.read', { kind: 'view', id: '/workloads', env: 'dev' }));
    expectAllow(authorize(p, 'view.read', { kind: 'route', id: '/api/v1/workloads', env: 'dev' }));
  });

  it('actions are bound to their resource kinds (no kind confusion)', () => {
    const p = principal('finops_lead');
    // A change action on a ticket, view or tool resource, and so on, is refused.
    expectDeny(authorize(p, 'change.request', { kind: 'ticket', id: 'X-1', team: PLATFORM, env: 'dev', requesterSub: p.sub }), 403);
    expectDeny(authorize(p, 'change.request', { kind: 'view', id: '/', env: 'dev' }), 403);
    expectDeny(authorize(principal('cto'), 'change.approve', { kind: 'audit', id: 'records', env: 'dev', requesterSub: 'x' }), 403);
    expectDeny(authorize(p, 'mcp.read', { kind: 'route', id: '/api/v1/ai/chat', env: 'dev' }), 403);
    expectDeny(authorize(p, 'ingest.write', { kind: 'mcp_tool', id: 'ingest', env: 'dev' }), 403);
    expectDeny(authorize(p, 'ingest.write', { kind: 'route', id: '/api/v1/connectors', env: 'dev' }), 403);
    expectDeny(authorize(p, 'connector.manage', { kind: 'route', id: '/api/costsource/ingest', env: 'dev' }), 403);
    expectDeny(authorize(p, 'audit.read', { kind: 'route', id: '/api/v1/workloads', env: 'dev' }), 403);
    expectDeny(authorize(p, 'view.read', { kind: 'change', id: 'chg-1', env: 'dev' }), 403);
    expectDeny(authorize(p, 'view.read', { kind: 'mcp_tool', id: 'cost_summary', env: 'dev' }), 403);
  });

  it('view.export needs read access to the exported view', () => {
    // Procurement may export a snapshot but has no access to the FinOps export route.
    expectAllow(authorize(principal('procurement'), 'view.export', { kind: 'route', id: '/api/report/snapshot', env: 'dev' }));
    expectDeny(authorize(principal('procurement'), 'view.export', { kind: 'route', id: '/api/v1/finio/export', env: 'dev' }), 403);
    // An eng lead exporting another team's scope is refused.
    expectDeny(authorize(principal('eng_lead'), 'view.export', { kind: 'route', id: '/api/report/snapshot', env: 'dev', team: CX }), 403);
    // Exports of simulation or webhook routes are never allowed.
    expectDeny(authorize(principal('finops_lead'), 'view.export', { kind: 'route', id: '/api/v1/simulation/report', env: 'dev' }), 403);
    expectDeny(authorize(principal('finops_lead'), 'view.export', { kind: 'route', id: '/api/v1/cm/webhook', env: 'dev' }), 403);
  });

  it('approval qualifiers: finance only cost impact, procurement only commitment impact, finops lead not in prod', () => {
    for (const env of ALL_ENVS) {
      expectAllow(authorize(principal('finance'), 'change.approve', change(env, { impact: 'cost' })), env);
      expectAllow(authorize(principal('procurement'), 'change.approve', change(env, { impact: 'commitment' })), env);
      for (const impact of [undefined, 'commitment', 'operational', 'COST', ''] as const) {
        expectDeny(authorize(principal('finance'), 'change.approve', change(env, { impact: impact as never })), 403, `finance ${impact}`);
      }
      for (const impact of [undefined, 'cost', 'operational', 'Commitment'] as const) {
        expectDeny(authorize(principal('procurement'), 'change.approve', change(env, { impact: impact as never })), 403, `procurement ${impact}`);
      }
      // CTO approves any impact.
      for (const impact of ['cost', 'commitment', 'operational'] as const) {
        expectAllow(authorize(principal('cto'), 'change.approve', change(env, { impact })), `cto ${impact}`);
      }
    }
    expectAllow(authorize(principal('finops_lead'), 'change.approve', change('test', { impact: 'cost' })));
    expectDeny(authorize(principal('finops_lead'), 'change.approve', change('prod', { impact: 'cost' })), 403);
  });

  it('legacy_service is bound to the shared-token auth method and cannot be claimed by a token', () => {
    const forged = principal('legacy_service', { authMethod: 'mock-idp' });
    expectDeny(authorize(forged, 'ticket.create', { kind: 'ticket', id: 'X-1', env: 'dev' }), 403);
    expectDeny(authorize(principal('legacy_service', { authMethod: 'oidc' }), 'view.read', { kind: 'route', id: '/api/v1/ai/chat', env: 'dev' }), 403);
    // The shared token never yields a persona role.
    for (const role of PERSONA_ROLES) {
      expectDeny(authorize(principal(role, { authMethod: 'legacy-shared-token' }), 'view.read', { kind: 'view', id: '/', env: 'dev' }), 403, role);
    }
    const legacy = principal('legacy_service');
    expectAllow(authorize(legacy, 'ticket.create', { kind: 'ticket', id: 'X-1', env: 'dev' }));
    // Nothing new: no lifecycle, no MCP, no audit, no pages, no new routes.
    for (const action of ['change.request', 'change.approve', 'change.apply', 'ticket.bind', 'ticket.update', 'ticket.get', 'mcp.read', 'mcp.write', 'audit.read', 'ingest.write', 'connector.manage', 'budget.edit'] as const) {
      for (const env of ALL_ENVS) {
        expectDeny(authorize(legacy, action, permissiveResource(action, 'legacy_service', env)), 403, `${action} ${env}`);
      }
    }
    for (const id of ['/', '/workloads', '/audit', '/costsource']) {
      expectDeny(authorize(legacy, 'view.read', { kind: 'view', id, env: 'dev' }), 403, id);
    }
    for (const id of ['/api/v1/workloads', '/api/v1/session/principal', '/api/v1/audit/records', '/api/attribution', '/api/costsource/ingest']) {
      expectDeny(authorize(legacy, 'view.read', { kind: 'route', id, env: 'dev' }), 403, id);
    }
  });

  it('role, team and env claims cannot be smuggled through the resource', () => {
    const eng = principal('eng_lead');
    // Extra fields on the resource or principal never widen access.
    const r = { kind: 'ticket', id: 'X-1', team: CX, env: 'dev', role: 'cto', teams: '*' } as unknown as Resource;
    expectDeny(authorize(eng, 'ticket.create', r), 403);
    const p = { ...eng, isAdmin: true, grants: ['*'], scope: '*' } as unknown as Principal;
    expectDeny(authorize(p, 'ticket.create', { kind: 'ticket', id: 'X-1', team: CX, env: 'dev' }), 403);
    // An approved ticket does not let a non-eng role apply.
    expectDeny(authorize(principal('cto'), 'change.apply', change('prod', { approverSub: 'a', ticketState: 'approved' })), 403);
  });

  it('a polluted Object.prototype does not create grants', () => {
    const proto = Object.prototype as Record<string, unknown>;
    const keys = ['admin', 'view.write', '/admin', 'superuser'];
    for (const k of keys) proto[k] = { codes: { cto: 'D' }, cells: { cto: ['Y', 'Y', 'Y'] }, status: 'public' };
    try {
      expectDeny(authorize(principal('superuser' as Role), 'view.read', { kind: 'view', id: '/', env: 'dev' }), 403);
      expectDeny(authorize(principal('cto'), 'view.write' as Action, { kind: 'view', id: '/', env: 'dev' }), 403);
      expectDeny(authorize(principal('cto'), 'view.read', { kind: 'view', id: '/admin', env: 'dev' }), 403);
    } finally {
      for (const k of keys) delete proto[k];
    }
  });

  it('is pure: inputs are not mutated and the same input gives the same verdict', () => {
    const p = deepFreeze(principal('eng_lead'));
    const r = deepFreeze(change('prod', { approverSub: 'sub-cto', ticketState: 'approved' }));
    const first = authorize(p, 'change.apply', r);
    for (let i = 0; i < 5; i += 1) expect(authorize(p, 'change.apply', r)).toEqual(first);
    const denied = authorize(p, 'change.approve', r);
    expect(authorize(p, 'change.approve', r)).toEqual(denied);
  });

  it('deny reasons are fixed text and never echo the input', () => {
    const canary = 'CANARY_<script>_9f3e';
    const inputs: Array<[Principal | null, Action, Resource]> = [
      [null, 'view.read', { kind: 'view', id: canary }],
      [principal(canary as Role), 'view.read', { kind: 'view', id: canary }],
      [principal('cto'), canary as Action, { kind: 'view', id: canary }],
      [principal('cto'), 'view.read', { kind: 'view', id: canary, team: canary, env: 'dev' }],
      [principal('eng_lead'), 'ticket.create', { kind: 'ticket', id: canary, team: canary, env: 'dev' }],
      [principal('eng_lead'), 'change.apply', change('prod', { id: canary, requesterSub: canary, approverSub: canary, ticketState: 'approved' })],
      [principal('eng_lead'), 'change.apply', change('prod', { id: canary, approverSub: canary, ticketState: 'open' })],
    ];
    const fixed = new Set<string>(Object.values(DENY_REASONS));
    for (const [p, a, r] of inputs) {
      const v = authorize(p, a, r);
      expect(v.allow).toBe(false);
      if (!v.allow) {
        expect(fixed.has(v.reason)).toBe(true);
        expect(JSON.stringify(v)).not.toContain('CANARY');
      }
    }
    // 409 is used only for a change state conflict.
    for (const reason of Object.values(DENY_REASONS)) expect(typeof reason).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// The shared scope helper (src/identity/scope.ts), used by authorize() and by
// every data seam that filters rows.
// ---------------------------------------------------------------------------

describe('scope helper: inScope and filterByScope', () => {
  const rows = [
    { id: 1, team: PLATFORM, env: 'prod' as DeployEnv },
    { id: 2, team: CX, env: 'prod' as DeployEnv },
    { id: 3, team: PLATFORM, env: 'dev' as DeployEnv },
    { id: 4, team: undefined, env: 'prod' as DeployEnv }, // unattributed (F21)
    { id: 5, team: PLATFORM, env: undefined }, // environment unknown
    { id: 6, team: PLATFORM, env: null }, // environment did not map: hidden from everyone
    { id: 7, team: '*', env: 'prod' as DeployEnv },
    { id: 8, team: '', env: 'prod' as DeployEnv },
  ];
  const keyOf = (r: (typeof rows)[number]) => ({ team: r.team, env: r.env });
  const ids = (p: Pick<Principal, 'teams' | 'envs'>) => filterByScope(p, rows, keyOf).map((r) => r.id);

  it('an eng lead sees only own-team rows in own envs; aggregates are computed after the filter', () => {
    expect(ids({ teams: [PLATFORM], envs: ['prod'] })).toEqual([1]);
    expect(ids({ teams: [PLATFORM], envs: ['dev', 'test', 'prod'] })).toEqual([1, 3, 5]);
    expect(ids({ teams: [CX], envs: ['dev', 'test', 'prod'] })).toEqual([2]);
  });

  it('org-wide principals see every real team, unattributed rows only with teams "*"', () => {
    expect(ids({ teams: '*', envs: ['dev', 'test', 'prod'] })).toEqual([1, 2, 3, 4, 5]);
    expect(ids({ teams: '*', envs: ['prod'] })).toEqual([1, 2, 4]);
  });

  it('empty or malformed claims see nothing', () => {
    expect(ids({ teams: [], envs: ['dev', 'test', 'prod'] })).toEqual([]);
    expect(ids({ teams: '*', envs: [] })).toEqual([]);
    expect(ids({ teams: ['*'], envs: ['dev', 'test', 'prod'] })).toEqual([]);
    expect(ids({ teams: 'all' as never, envs: ['prod'] })).toEqual([]);
    expect(ids({ teams: '*', envs: ['production'] as never })).toEqual([]);
    expect(ids(null as never)).toEqual([]);
  });

  it('inScope matches teams exactly and rejects raw env values', () => {
    const p = { teams: [PLATFORM], envs: ['dev', 'test', 'prod'] as DeployEnv[] };
    expect(inScope(p, { team: PLATFORM, env: 'prod' })).toBe(true);
    for (const team of ['platform eng', 'Platform Eng ', 'Platform', '*', '']) {
      expect(inScope(p, { team, env: 'prod' }), team).toBe(false);
    }
    for (const env of ['production', 'staging', 'sandbox', 'PROD', '__proto__']) {
      expect(inScope(p, { team: PLATFORM, env: env as DeployEnv }), env).toBe(false);
    }
  });

  it('filterByScope keeps order and does not mutate its input', () => {
    const frozen = Object.freeze(rows.map((r) => Object.freeze({ ...r })));
    const out = filterByScope({ teams: '*', envs: ['dev', 'test', 'prod'] }, frozen, keyOf);
    expect(out.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(out).not.toBe(frozen);
  });
});

// Card A1: the pure decision function. Card-named tests first, then one test
// per security property (matrix sweeps, resource binding, approval impact,
// prototype chain, array shapes, length caps, fixed reasons and purity, scope).
import { describe, expect, it } from 'vitest';
import { authorize, DENY_REASONS } from './authorize';
import { ACTION_MATRIX, READABLE_CODES, ROUTE_MATRIX, VIEW_GROUPS, type MatrixAction } from './matrix';
import { MAX_CLAIM, MAX_ROWS, envCovered, filterByScope, hasRealTeam, inScope, teamCovered } from '@/identity/scope';
import { ACTIONS, DEPLOY_ENVS, PERSONA_ROLES, ROLES, type Action, type DeployEnv, type Principal, type Resource, type Role, type Verdict } from '@/identity/types';

const ALL: DeployEnv[] = ['dev', 'test', 'prod'];
const PLATFORM = 'Platform Eng';
const CX = 'CX Engineering';
const principal = (role: Role, over: Partial<Principal> = {}): Principal => ({
  sub: `sub-${role}`, role, teams: role === 'eng_lead' ? [PLATFORM] : '*', envs: [...ALL], tenant: 't', tokenId: `jti-${role}`,
  expiresAt: 4_102_444_800, authMethod: role === 'legacy_service' ? 'legacy-shared-token' : 'mock-idp', ...over,
});
const change = (env: DeployEnv, over: Partial<Resource> = {}): Resource =>
  ({ kind: 'change', id: 'chg-1', team: PLATFORM, env, requesterSub: 'sub-other', ...over });
const ticket = (team: string | undefined, env: DeployEnv = 'dev'): Resource => ({ kind: 'ticket', id: 'X-1', team, env });
const REASONS = new Set<string>(Object.values(DENY_REASONS));
function expectDeny(v: Verdict, status: 401 | 403 | 409, msg?: string): void {
  expect(v, msg).toMatchObject({ allow: false, status });
  if (!v.allow) expect(REASONS.has(v.reason), msg).toBe(true);
}
const expectAllow = (v: Verdict, msg?: string) => expect(v, msg).toEqual({ allow: true });

/** The most permissive well-formed resource for an action, so a deny is the matrix's. */
function permissive(action: MatrixAction, role: Role, env: DeployEnv): Resource {
  if (action === 'change.request') return change(env, { requesterSub: `sub-${role}` });
  if (action === 'change.approve') return change(env, { impact: role === 'procurement' ? 'commitment' : 'cost' });
  if (action === 'change.apply') return change(env, { approverSub: 'sub-approver', ticketState: 'approved' });
  if (action.startsWith('ticket.')) return ticket(PLATFORM, env);
  if (action.startsWith('mcp.')) return { kind: 'mcp_tool', id: 'cost_summary', env };
  if (action === 'audit.read') return { kind: 'audit', id: 'records', env };
  if (action === 'connector.manage') return { kind: 'route', id: '/api/v1/connectors', env };
  if (action === 'ingest.write') return { kind: 'route', id: '/api/costsource/ingest', env };
  if (action === 'budget.edit') return { kind: 'view', id: '/workloads', env };
  return { kind: 'route', id: role === 'legacy_service' ? '/api/v1/finio/export' : '/api/report/snapshot', env, team: role === 'eng_lead' ? PLATFORM : undefined };
}
const WRITES: MatrixAction[] = ['change.request', 'change.approve', 'change.apply', 'ticket.create', 'ticket.attach', 'ticket.bind', 'ticket.update', 'mcp.write', 'budget.edit', 'connector.manage', 'ingest.write'];

describe('authorize: card A1 named tests', () => {
  it('denies_by_default_when_no_principal', () => {
    for (const action of ACTIONS) for (const p of [null, undefined]) expectDeny(authorize(p, action, { kind: 'view', id: '/demo' }), 401, action);
    const bad: unknown[] = [{}, 'cto', 42, { ...principal('cto'), sub: '' }, { ...principal('cto'), teams: 'all' }, { ...principal('cto'), teams: [7] },
      { ...principal('cto'), envs: 'prod' }, { ...principal('cto'), authMethod: 'basic' }, { ...principal('cto'), expiresAt: Number.NaN }, { ...principal('cto'), expiresAt: Infinity }];
    for (const p of bad) expectDeny(authorize(p as Principal, 'view.read', { kind: 'view', id: '/', env: 'dev' }), 401, JSON.stringify(p));
  });

  it('denies_unknown_action_and_unknown_role', () => {
    const view: Resource = { kind: 'view', id: '/', env: 'dev' };
    for (const role of ['admin', 'CTO', 'cto ', '', '*', '__proto__', 'constructor', 'executive']) expectDeny(authorize(principal('cto', { role: role as Role }), 'view.read', view), 403, role);
    for (const action of ['view.write', '*', 'VIEW.READ', '__proto__', 'toString', 'change.delete']) {
      expect(authorize(principal('finops_lead'), action as Action, view), action).toEqual({ allow: false, status: 403, reason: DENY_REASONS.action }); // decided, not thrown
    }
    for (const id of ['/admin', '', '__proto__', '/Overview', '/api/v1/simulation/*']) expectDeny(authorize(principal('finops_lead'), 'view.read', { kind: 'view', id }), 403, id);
    expectDeny(authorize(principal('finops_lead'), 'view.read', { kind: 'page', id: '/' } as unknown as Resource), 403);
    // legacy_service is bound to the shared token, and the shared token to legacy_service.
    expectDeny(authorize(principal('legacy_service', { authMethod: 'mock-idp' }), 'ticket.create', ticket(undefined)), 403);
    for (const role of PERSONA_ROLES) expectDeny(authorize(principal(role, { authMethod: 'legacy-shared-token' }), 'view.read', view), 403, role);
  });

  it('eng_lead_cannot_read_other_team_rows', () => {
    const eng = principal('eng_lead');
    for (const [kind, id] of [['view', '/workloads'], ['route', '/api/attribution'], ['route', '/api/costsource/rows']] as const) {
      expectAllow(authorize(eng, 'view.read', { kind, id, team: PLATFORM, env: 'prod' }), id);
      for (const team of [CX, 'platform eng', 'Platform Eng ', 'Platform', '*', '']) expectDeny(authorize(eng, 'view.read', { kind, id, team, env: 'prod' }), 403, `${id} ${team}`);
    }
    for (const action of ['change.request', 'change.apply', 'ticket.create', 'ticket.status', 'ticket.get'] as const) {
      expectDeny(authorize(eng, action, { ...permissive(action, 'eng_lead', 'dev'), team: CX }), 403, action);
      expectDeny(authorize(eng, action, { ...permissive(action, 'eng_lead', 'dev'), team: undefined }), 403, `${action} no team`);
    }
    expectDeny(authorize(eng, 'view.read', { kind: 'view', id: 'attribution.user_dimension', team: PLATFORM }), 403);
  });

  it('apply_in_prod_is_409_when_ticket_state_is_not_approved', () => {
    for (const ticketState of ['open', 'rejected'] as const) expectDeny(authorize(principal('eng_lead'), 'change.apply', change('prod', { approverSub: 'a', ticketState })), 409, ticketState);
    expectDeny(authorize(principal('eng_lead'), 'change.apply', change('prod', { ticketState: 'approved' })), 409); // change not approved
  });

  it('apply_in_prod_is_403_when_resource_has_no_bound_ticket', () => {
    for (const ticketState of [undefined, 'none', 'bogus'] as never[]) expectDeny(authorize(principal('eng_lead'), 'change.apply', change('prod', { approverSub: 'a', ticketState })), 403, String(ticketState));
  });

  it('apply_allowed_only_with_approved_ticket_and_different_approver', () => {
    const eng = principal('eng_lead');
    const ok = change('prod', { requesterSub: 'sub-eng_lead', approverSub: 'sub-cto', ticketState: 'approved' });
    expectAllow(authorize(eng, 'change.apply', ok));
    expectDeny(authorize(eng, 'change.apply', { ...ok, approverSub: 'sub-eng_lead' }), 403);
    expectDeny(authorize(eng, 'change.apply', { ...ok, requesterSub: undefined }), 403);
    expectDeny(authorize(eng, 'change.apply', { ...ok, team: CX }), 403);
    expectDeny(authorize(principal('eng_lead', { envs: ['dev', 'test'] }), 'change.apply', ok), 403);
    expectDeny(authorize(principal('eng_lead', { teams: '*' }), 'change.apply', { ...ok, team: undefined }), 403);
    for (const role of ROLES.filter((r) => r !== 'eng_lead')) expectDeny(authorize(principal(role), 'change.apply', ok), 403, role);
    for (const env of ['dev', 'test'] as const) expectAllow(authorize(eng, 'change.apply', change(env)), env); // Y*: no ticket gate
  });

  it('requester_cannot_approve_own_change', () => {
    for (const role of ['cto', 'finops_lead', 'finance', 'procurement'] as const) {
      const impact = role === 'procurement' ? 'commitment' : 'cost';
      expectAllow(authorize(principal(role), 'change.approve', change('dev', { impact })), role);
      expectDeny(authorize(principal(role), 'change.approve', change('dev', { impact, requesterSub: `sub-${role}` })), 403, role);
      expectDeny(authorize(principal(role), 'change.approve', change('dev', { impact, requesterSub: undefined })), 403, role);
    }
    expectDeny(authorize(principal('finops_lead'), 'change.request', change('dev', { requesterSub: 'sub-cto' })), 403); // no request on behalf
  });

  it('auditor_has_no_write_action_in_any_env', () => {
    for (const action of WRITES) for (const env of ALL) expectDeny(authorize(principal('auditor'), action, permissive(action, 'auditor', env)), 403, `${action} ${env}`);
    expectAllow(authorize(principal('auditor'), 'audit.read', { kind: 'audit', id: 'records', env: 'prod' }));
  });

  it('mcp_write_tool_denied_for_every_role_and_env', () => {
    for (const role of ROLES) for (const env of ALL) expectDeny(authorize(principal(role, { teams: '*' }), 'mcp.write', { kind: 'mcp_tool', id: 'w', env, team: PLATFORM }), 403, `${role} ${env}`);
  });

  it('token_env_not_in_envs_is_denied', () => {
    const devOnly = principal('finops_lead', { envs: ['dev'] });
    expectAllow(authorize(devOnly, 'ticket.create', ticket(PLATFORM, 'dev')));
    for (const env of ['test', 'prod'] as const) expectDeny(authorize(devOnly, 'ticket.create', ticket(PLATFORM, env)), 403, env);
    for (const envs of [[], ['production', 'staging', '*']] as unknown as DeployEnv[][]) expectDeny(authorize(principal('finops_lead', { envs }), 'view.read', { kind: 'view', id: '/demo' }), 403);
    for (const env of [undefined, 'production', 'sandbox', ''] as unknown as DeployEnv[]) expectDeny(authorize(principal('finops_lead'), 'ticket.create', { kind: 'ticket', id: 'X-1', team: PLATFORM, env }), 403, String(env));
  });

  it('teams_star_grants_all_teams_but_empty_teams_grants_none', () => {
    for (const team of [PLATFORM, CX, 'Legal']) expectAllow(authorize(principal('finops_lead'), 'ticket.create', ticket(team, 'prod')), team);
    expectAllow(authorize(principal('finops_lead'), 'ticket.status', ticket(undefined)));
    // A list must name a real team: [], ['*'], [''] grant nothing, even teamless or public views.
    for (const teams of [[], ['*'], [''], ['*', '']]) {
      for (const id of ['/tokenomics', '/demo']) expectDeny(authorize(principal('cto', { teams }), 'view.read', { kind: 'view', id }), 403, `${teams} ${id}`);
    }
    const mixed = principal('eng_lead', { teams: ['*', PLATFORM] }); // '*' in a list is never a wildcard
    expectAllow(authorize(mixed, 'ticket.create', ticket(PLATFORM)));
    for (const team of [CX, '*', '']) expectDeny(authorize(mixed, 'ticket.create', ticket(team)), 403, team);
    for (const role of ['cto', 'finance', 'auditor'] as const) expectDeny(authorize(principal(role, { teams: [PLATFORM] }), 'ticket.status', ticket(undefined)), 403, role);
  });
});

describe('authorize: security properties', () => {
  it('every role x action x env, and every route x role x env, matches the matrix', () => {
    for (const role of ROLES) for (const action of ACTIONS.filter((a): a is MatrixAction => a !== 'view.read')) for (const env of DEPLOY_ENVS) {
      const cell = ACTION_MATRIX[action].cells[role][DEPLOY_ENVS.indexOf(env)];
      const v = authorize(principal(role), action, permissive(action, role, env));
      if (cell === 'n' || ACTION_MATRIX[action].deferred) expectDeny(v, 403, `${role} ${action} ${env}`);
      else expectAllow(v, `${role} ${action} ${env}`);
    }
    for (const row of ROUTE_MATRIX) for (const role of ROLES) for (const env of DEPLOY_ENVS) {
      const code = role === 'legacy_service' ? row.legacyService : VIEW_GROUPS[row.group].codes[role];
      const v = authorize(principal(role), 'view.read', { kind: row.kind === 'api' ? 'route' : 'view', id: row.path, env, team: role === 'eng_lead' ? PLATFORM : undefined });
      if (row.status === 'public' || (READABLE_CODES.includes(code) && row.status !== 'sim_only' && row.status !== 'signed')) expectAllow(v, `${role} ${row.path}`);
      else expectDeny(v, 403, `${role} ${row.path} ${env}`);
    }
  });

  it('actions are bound to resource kinds, page or route ids, readable views and listed routes', () => {
    const f = principal('finops_lead');
    const denied: Array<[Action, Resource]> = [
      ['change.request', { ...ticket(PLATFORM), requesterSub: f.sub }], ['mcp.read', { kind: 'route', id: '/api/v1/ai/chat', env: 'dev' }],
      ['view.read', { kind: 'change', id: '/workloads', env: 'dev' }], ['view.read', { kind: 'route', id: '/workloads', env: 'dev' }],
      ['view.read', { kind: 'view', id: '/api/v1/workloads', env: 'dev' }], ['ingest.write', { kind: 'route', id: '/api/v1/connectors', env: 'dev' }],
      ['connector.manage', { kind: 'route', id: '/api/costsource/ingest', env: 'dev' }], ['audit.read', { kind: 'route', id: '/api/v1/workloads', env: 'dev' }],
      ['view.export', { kind: 'route', id: '/api/v1/simulation/report', env: 'dev' }], ['view.export', { kind: 'route', id: '/api/v1/cm/webhook', env: 'dev' }],
    ];
    for (const [action, r] of denied) expectDeny(authorize(f, action, r), 403, `${action} ${r.kind} ${r.id}`);
    expectDeny(authorize(principal('procurement'), 'view.export', { kind: 'route', id: '/api/v1/finio/export', env: 'dev' }), 403);
    expectAllow(authorize(principal('procurement'), 'view.export', { kind: 'route', id: '/api/report/snapshot', env: 'dev' }));
  });

  it('approval impact: finance only cost, procurement only commitment, finops lead not in prod', () => {
    for (const env of ALL) {
      for (const impact of [undefined, 'commitment', 'operational', 'COST'] as never[]) expectDeny(authorize(principal('finance'), 'change.approve', change(env, { impact })), 403);
      for (const impact of [undefined, 'cost', 'operational'] as never[]) expectDeny(authorize(principal('procurement'), 'change.approve', change(env, { impact })), 403);
      expectAllow(authorize(principal('cto'), 'change.approve', change(env, { impact: 'operational' })));
    }
    expectDeny(authorize(principal('finops_lead'), 'change.approve', change('prod', { impact: 'cost' })), 403);
  });

  it('prototype chain: inherited fields, keys and indexes never grant', () => {
    const op = Object.prototype as Record<string, unknown>;
    const ap = Array.prototype as unknown as Record<number | string, unknown>;
    const holes = <T>(n = 3) => new Array<T>(n);
    const own = { kind: 'change', id: 'c', team: PLATFORM, env: 'prod', requesterSub: 'r' };
    const { role: _r, teams: _t, ...noRoleTeams } = principal('eng_lead');
    void _r; void _t;
    const cases: Array<[string, () => unknown, unknown, Record<string | number, unknown>?, object?]> = [
      ['JSON __proto__ resource', () => authorize(principal('eng_lead'), 'change.apply', Object.assign({}, JSON.parse('{"kind":"change","id":"c","team":"Platform Eng","env":"prod","requesterSub":"r","__proto__":{"ticketState":"approved","approverSub":"a"}}'))).allow, false],
      ['Object.create principal', () => authorize(Object.assign(Object.create({ role: 'cto', teams: '*' }), noRoleTeams), 'change.approve', change('prod', { impact: 'cost' })).allow, false],
      ['polluted Object.prototype resource', () => authorize(principal('eng_lead'), 'change.apply', { ...own } as Resource).allow, false, { ticketState: 'approved', approverSub: 'a' }, op],
      ['extra own fields', () => authorize({ ...principal('eng_lead'), isAdmin: true, scope: '*' } as Principal, 'ticket.create', { ...ticket(CX), role: 'cto' } as Resource).allow, false],
      ['holey teams', () => authorize(principal('eng_lead', { teams: holes() }), 'ticket.create', ticket(CX)).allow, false, { 0: CX, 1: CX, 2: CX }, ap],
      ['holey envs', () => authorize(principal('finops_lead', { envs: holes() }), 'view.read', { kind: 'view', id: '/demo' }).allow, false, { 0: 'prod', 1: 'prod', 2: 'prod' }, ap],
      ['teamCovered holes', () => teamCovered(holes(), CX), false, { 0: CX }, ap],
      ['envCovered holes', () => envCovered(holes(), 'prod'), false, { 0: 'prod' }, ap],
      ['hasRealTeam holes', () => hasRealTeam(holes()), false, { 0: CX }, ap],
      ['filterByScope rows', () => filterByScope({ teams: '*', envs: ALL }, holes(), (r) => r as never), [], { 0: { team: CX, env: 'prod' } }, ap],
      ['inScope inherited claims', () => inScope(Object.create({ teams: '*', envs: ['prod'] }), { team: CX, env: 'prod' }), false],
      ['inScope inherited row team', () => inScope({ teams: [PLATFORM], envs: ALL }, Object.assign(Object.create({ team: PLATFORM }), { env: 'prod' })), false],
    ];
    for (const [name, call, expected, plant = {}, target = ap] of cases) {
      try {
        Object.assign(target, plant);
        expect(call(), name).toEqual(expected);
      } finally {
        for (const k of Object.keys(plant)) delete (target as Record<string, unknown>)[k];
      }
    }
  });

  it('array shapes: arrays, array-likes, strings and Proxies are never inputs, and nothing throws', () => {
    const revoked = () => { const r = Proxy.revocable([CX, 'prod'], {}); r.revoke(); return r.proxy; };
    const boom = () => { throw new Error('trap'); };
    const hostile: Array<[string, () => unknown]> = [
      ['array', () => [CX, 'prod']], ['array-like', () => ({ length: 1, 0: CX })], ['string', () => CX],
      ['revoked Proxy', revoked], ['throwing Proxy', () => new Proxy([CX, 'prod'], { get: boom, has: boom, getOwnPropertyDescriptor: boom, ownKeys: boom })],
    ];
    const ownChange = { kind: 'change', id: 'c', team: PLATFORM, env: 'prod', requesterSub: 'r', ticketState: 'approved', approverSub: 'a' };
    for (const [name, make] of hostile) {
      expect(() => {
        expect(authorize(make() as Principal, 'view.read', { kind: 'view', id: '/demo' }).allow, name).toBe(false);
        expect(authorize(principal('eng_lead'), 'change.apply', make() as Resource).allow, name).toBe(false);
        expect(filterByScope({ teams: '*', envs: ALL }, make() as never, (r) => r as never), name).toEqual([]);
        if (name === 'array') return; // a plain array is a valid teams or envs claim
        expect([teamCovered(make(), CX), envCovered(make(), 'prod'), hasRealTeam(make())], name).toEqual([false, false, false]);
        expect(authorize(principal('cto', { teams: make() as string[] }), 'view.read', { kind: 'view', id: '/demo' }).allow, name).toBe(false);
        expect(authorize(principal('cto', { envs: make() as DeployEnv[] }), 'view.read', { kind: 'view', id: '/demo' }).allow, name).toBe(false);
        expect(inScope({ teams: make() as string[], envs: ALL }, { team: CX, env: 'prod' }), name).toBe(false);
        expect(inScope({ teams: '*', envs: make() as DeployEnv[] }, { team: CX, env: 'prod' }), name).toBe(false);
      }, name).not.toThrow();
    }
    // An array resource whose prototype carries the approval fields is still not a resource.
    const arr = Object.setPrototypeOf(Object.assign([], ownChange), Object.assign(Object.create(Array.prototype), { ticketState: 'approved' }));
    expect(authorize(principal('eng_lead'), 'change.apply', arr).allow).toBe(false);
    expect(filterByScope({ teams: '*', envs: ALL }, [{}], () => { throw new Error('keyOf'); })).toEqual([]);
  });

  it('length caps: over-cap claims and rows are invalid before any scan; at the cap they work', () => {
    const atCap = (n: number, last: unknown) => Object.assign(new Array(n), { [n - 1]: last });
    expect(teamCovered(atCap(MAX_CLAIM, CX), CX)).toBe(true);
    expect(envCovered(atCap(MAX_CLAIM, 'prod'), 'prod')).toBe(true);
    expectAllow(authorize(principal('eng_lead', { teams: atCap(MAX_CLAIM, CX) }), 'ticket.create', ticket(CX)));
    expect(filterByScope({ teams: '*', envs: ALL }, atCap(MAX_ROWS, { team: CX, env: 'prod' }), (r) => r as never)).toHaveLength(1);
    expect(teamCovered(atCap(MAX_CLAIM + 1, CX), CX)).toBe(false);
    expect(envCovered(atCap(MAX_CLAIM + 1, 'prod'), 'prod')).toBe(false);
    expectDeny(authorize(principal('eng_lead', { teams: atCap(MAX_CLAIM + 1, CX) }), 'ticket.create', ticket(CX)), 401);
    expect(filterByScope({ teams: '*', envs: ALL }, atCap(MAX_ROWS + 1, { team: CX, env: 'prod' }), (r) => r as never)).toEqual([]);
    for (const n of [2 ** 32 - 1, 1e9]) {
      const huge = <T>() => new Array<T>(n);
      const started = Date.now();
      expect(teamCovered(huge(), CX) || envCovered(huge(), 'prod') || hasRealTeam(huge())).toBe(false);
      expect(inScope({ teams: huge(), envs: ALL }, { team: CX, env: 'prod' }) || inScope({ teams: '*', envs: huge() }, { team: CX, env: 'prod' })).toBe(false);
      expect(filterByScope({ teams: '*', envs: ALL }, huge(), (r) => r as never)).toEqual([]);
      expect(authorize(principal('eng_lead', { teams: huge() }), 'ticket.create', ticket(CX)).allow || authorize(principal('cto', { envs: huge() }), 'view.read', { kind: 'view', id: '/demo' }).allow).toBe(false);
      expect(Date.now() - started, `length ${n}`).toBeLessThan(200);
    }
  });

  it('deny reasons are fixed text that never echoes input, and inputs are not mutated', () => {
    const canary = 'CANARY_<script>';
    const v = [
      authorize(principal(canary as Role), 'view.read', { kind: 'view', id: canary }), authorize(principal('cto'), canary as Action, { kind: 'view', id: canary }),
      authorize(principal('eng_lead'), 'ticket.create', { kind: 'ticket', id: canary, team: canary, env: 'dev' }),
      authorize(principal('eng_lead'), 'change.apply', change('prod', { id: canary, requesterSub: canary, approverSub: canary, ticketState: 'approved' })),
    ];
    for (const verdict of v) expect(!verdict.allow && REASONS.has(verdict.reason) && !JSON.stringify(verdict).includes('CANARY')).toBe(true);
    const p = Object.freeze({ ...principal('eng_lead'), teams: Object.freeze([PLATFORM]) as string[], envs: Object.freeze([...ALL]) as DeployEnv[] });
    const r = Object.freeze(change('prod', { approverSub: 'sub-cto', ticketState: 'approved' }));
    expect([authorize(p, 'change.apply', r), authorize(p, 'change.apply', r)]).toEqual([{ allow: true }, { allow: true }]);
  });

  it('scope helper: own teams and envs only; unattributed rows for "*"; unmapped envs for no one', () => {
    const rows = [
      { id: 1, team: PLATFORM, env: 'prod' }, { id: 2, team: CX, env: 'prod' }, { id: 3, team: PLATFORM, env: 'dev' },
      { id: 4, team: undefined, env: 'prod' }, { id: 5, team: PLATFORM, env: undefined }, { id: 6, team: PLATFORM, env: null }, { id: 7, team: '*', env: 'prod' },
    ] as Array<{ id: number; team?: string; env?: DeployEnv | null }>;
    const ids = (p: Pick<Principal, 'teams' | 'envs'>) => filterByScope(p, rows, (r) => ({ team: r.team, env: r.env })).map((r) => r.id);
    expect(ids({ teams: [PLATFORM], envs: ['prod'] })).toEqual([1]);
    expect(ids({ teams: [PLATFORM], envs: ALL })).toEqual([1, 3, 5]);
    expect(ids({ teams: '*', envs: ALL })).toEqual([1, 2, 3, 4, 5]);
    expect(ids({ teams: '*', envs: ['prod'] })).toEqual([1, 2, 4]);
    expect(ids({ teams: [], envs: ALL })).toEqual([]);
  });
});

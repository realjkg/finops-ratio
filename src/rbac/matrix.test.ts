// The expected values are an independent literal copy of PLAN 4.4 and 4.5.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ACTION_MATRIX, READABLE_CODES, ROUTE_MATRIX, ROUTE_STATUSES, VIEW_GROUPS, findRoute, type MatrixAction } from './matrix';
import { authorize } from './authorize';
import { ACTIONS, PERSONA_ROLES, ROLES, type Principal, type Role } from '@/identity/types';

const ROOT = path.resolve(__dirname, '..', '..');
const CARD = /^(?:A[1-8]|B(?:[1-9]|1[01])|C[1-8])$/;
const MATRIX_ACTIONS = ACTIONS.filter((a): a is MatrixAction => a !== 'view.read');

/** Every route file under pages/ as [route, repo-relative file]. */
function walkPages(dir = path.join(ROOT, 'pages'), acc: Array<[string, string]> = []): Array<[string, string]> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (e.isDirectory()) walkPages(abs, acc);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !/^pages\/_(app|document|error)\./.test(rel)) {
      acc.push([rel.replace(/^pages/, '').replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '') || '/', rel]);
    }
  }
  return acc;
}

describe('permission matrix', () => {
  it('matrix_covers_every_page_and_api_route', () => {
    const files = walkPages();
    expect(files.length).toBeGreaterThan(40);
    expect(files.filter(([route]) => !findRoute(route)).map(([r]) => r), 'routes without a row').toEqual([]);
    const existing = new Set(files.map(([r]) => r));
    for (const row of ROUTE_MATRIX) {
      expect(ROUTE_STATUSES as readonly string[], row.path).toContain(row.status.replace(/\((A|B|C)\d+\)$/, ''));
      if (row.kind === 'facet') expect(existing.has(row.facetOf!), row.path).toBe(true);
      else if (!existing.has(row.path)) expect(row.plannedBy, `${row.path} has no file and no plannedBy`).toMatch(CARD);
    }
    expect(new Set(ROUTE_MATRIX.map((r) => r.path)).size).toBe(ROUTE_MATRIX.length);
    expect(ROUTE_MATRIX.filter((r) => r.status === 'public').map((r) => r.path).sort()).toEqual(['/api/hello', '/demo', '/finio/demo', '/hello', '/sign-in']);
    for (const [route] of files.filter(([r]) => /^\/(api\/v1\/simulation\/|simulation$|workspace$)/.test(r))) expect(findRoute(route)?.status, route).toBe('sim_only');
    expect(['deferred(C3)', 'enforced']).toContain(findRoute('/api/v1/cm/change')?.status);
    for (const p of ['__proto__', 'constructor', '/Overview', '/overview/', '']) expect(findRoute(p), p).toBeUndefined();
  });

  it('legacy_service_column_grants_exactly_todays_gateway_access', () => {
    // Derived from source: an API file (or the file it re-exports or builds its handler from) that calls the gateway.
    // createReaderRoute is the read-API island's shared factory (withGateway + evaluateLiveDataAuth, publishedCostsRoute.ts).
    const GATE = /\b(withGateway|gateSourceAccess|evaluateLiveDataAuth|createReaderRoute)\s*\(/;
    const gated = walkPages().filter(([route, file]) => {
      if (!route.startsWith('/api/')) return false;
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const factory = src.match(/export\s+default\s+(create\w+)\s*\(/)?.[1];
      const spec = src.match(/export\s*\{\s*default\s*\}\s*from\s*'([^']+)'/)?.[1] ?? (factory && src.match(new RegExp(`\\b${factory}\\b[^;]*from\\s*'([^']+)'`))?.[1]);
      const target = !spec ? src : fs.readFileSync(spec.startsWith('@/') ? path.join(ROOT, 'src', `${spec.slice(2)}.ts`) : path.resolve(path.dirname(path.join(ROOT, file)), `${spec}.ts`), 'utf8');
      return GATE.test(target);
    }).map(([r]) => r);
    expect(gated).toContain('/api/v1/cm/change'); // reached through its ticket actions
    const readable = ROUTE_MATRIX.filter((r) => r.legacyService === 'D').map((r) => r.path);
    expect(readable.sort()).toEqual(gated.filter((r) => r !== '/api/v1/cm/change').sort());
    expect(readable).toHaveLength(13);
    expect(findRoute('/api/v1/cm/change')?.legacyService).toBe('see_4_5');
    const allowed = MATRIX_ACTIONS.filter((a) => ACTION_MATRIX[a].cells.legacy_service.some((c) => c !== 'n'));
    expect(allowed.sort()).toEqual(['ticket.attach', 'ticket.create', 'ticket.status', 'view.export']);
  });

  it('budget_edit_row_is_marked_deferred_with_no_enforcing_surface', () => {
    expect(ACTION_MATRIX['budget.edit'].deferred).toEqual({ source: 'src/store/useStore.ts:316-318', enforcingSurface: null });
    expect(fs.readFileSync(path.join(ROOT, 'src/store/useStore.ts'), 'utf8').split('\n').slice(315, 318).join('\n')).toMatch(/updateThresholds/);
    expect(MATRIX_ACTIONS.filter((a) => ACTION_MATRIX[a].deferred)).toEqual(['budget.edit']);
    const finance: Principal = { sub: 'f', role: 'finance', teams: '*', envs: ['dev', 'test', 'prod'], tenant: 't', tokenId: 'j', expiresAt: 4e9, authMethod: 'mock-idp' };
    expect(authorize(finance, 'budget.edit', { kind: 'view', id: '/workloads', env: 'dev' }).allow).toBe(false);
  });

  it('matrix_has_rows_for_every_route_planned_by_this_plan', () => {
    const planned = [
      ['/api/v1/session/login', 'B7', 'public_mock'], ['/api/v1/session/logout', 'B7', 'enforced'],
      ['/api/v1/session/principal', 'B7', 'enforced'], ['/api/v1/session/mock-control', 'B7', 'public_mock'],
      ['/api/v1/workloads', 'B7', 'enforced'], ['/api/v1/cm/webhook', 'C4', 'signed'], ['/api/v1/cm/sync', 'C8', 'enforced'],
      ['/api/v1/audit/records', 'C5', 'enforced'], ['/audit', 'C5', 'enforced'], ['/sign-in', 'B11', 'public'],
    ];
    for (const [p, card, status] of planned) expect([p, findRoute(p)?.plannedBy, findRoute(p)?.status, findRoute(p)?.legacyService]).toEqual([p, card, status, '-']);
    expect(findRoute('/api/v1/cm/sync')?.action).toBe('ticket.update');
  });

  it('matrix_view_codes_match_plan_section_4_4', () => {
    const PLAN: Record<string, [string, string[]]> = {
      findings: ['O D O T O D', ['/']], overview: ['O D O T O D', ['/overview']], workloads: ['O D D T O D', ['/workloads']],
      connectors: ['S D S S S S', ['/connectors', '/api/v1/connectors']],
      costsource: ['- D D T - D', ['/costsource', ...['sources', 'rows', 'findings', 'health', 'ingest'].map((n) => `/api/costsource/${n}`)]],
      attribution: ['O D D T - D', ['/attribution', '/api/attribution']], attribution_user: ['- D - - - D', ['attribution.user_dimension']],
      prediction: ['O D - T - D', ['/prediction', '/api/prediction/predict', '/api/prediction/accuracy']],
      tokenomics: ['O D D T O D', ['/tokenomics', '/api/tokenomics']], frameworks: ['R R R R R R', ['/frameworks']],
      reports: ['O D D T O D', ['/reports', '/api/report/snapshot']],
      finio_export: ['- D D - - D', ['/finio', '/api/v1/finio/export', '/api/finio/export']],
      outcomes: ['O D O T O D', ['/outcomes', '/mission']], frank: ['O D O T O D', ['/agent-workflows', '/api/v1/ai/chat']],
      demo: ['R R R R R R', ['/demo', '/hello', '/finio/demo', '/api/hello']],
      published: ['- D D - - D', ['/api/v1/costs/published', '/api/v1/reports/facts', '/api/v1/reports/engagement', '/api/v1/a2a/handshake', '/api/a2a/handshake']],
      cm_change: [Array(6).fill('see_4_5').join(' '), ['/api/v1/cm/change']], audit: ['O D - T - D', ['/audit', '/api/v1/audit/records']],
      scoped_data: ['O D D T O D', ['/api/v1/workloads']],
      session: ['any any any any any any', ['principal', 'logout', 'login', 'mock-control'].map((n) => `/api/v1/session/${n}`).concat('/sign-in', '/api/auth/login', '/api/auth/logout', '/api/auth/session')],
      webhook: ['- - - - - -', ['/api/v1/cm/webhook']], status_sync: ['- Y - Y* - -', ['/api/v1/cm/sync']],
      simulation: [Array(6).fill('dev_test_only').join(' '), ['/simulation', '/workspace', ...['chat', 'command', 'frank', 'operations', 'report', 'session', 'state', 'status'].map((n) => `/api/v1/simulation/${n}`)]],
    };
    expect(Object.keys(VIEW_GROUPS).sort()).toEqual(Object.keys(PLAN).sort());
    for (const [g, [codes, routes]] of Object.entries(PLAN)) {
      expect(PERSONA_ROLES.map((r) => VIEW_GROUPS[g as keyof typeof VIEW_GROUPS].codes[r]).join(' '), g).toBe(codes);
      for (const route of routes) expect(findRoute(route)?.group, route).toBe(g);
    }
    expect(ROUTE_MATRIX.map((r) => r.path).sort()).toEqual(Object.values(PLAN).flatMap(([, rs]) => rs).sort());
  });

  it('matrix_action_cells_match_plan_section_4_5', () => {
    // dev/test/prod per column: cto finops_lead finance eng_lead procurement auditor legacy_service.
    const PLAN: Record<MatrixAction, string> = {
      'change.request': 'nnn YYY nnn ***  nnn nnn nnn', 'change.approve': 'YYY YYn YYY nnn YYY nnn nnn',
      'change.apply': 'nnn nnn nnn **A nnn nnn nnn', 'ticket.create': 'nnn YYY nnn *** nnn nnn YYY',
      'ticket.attach': 'nnn YYY nnn *** nnn nnn YYY', 'ticket.status': 'YYY YYY YYY *** YYY YYY YYY',
      'ticket.bind': 'nnn YYY nnn *** nnn nnn nnn', 'ticket.update': 'nnn YYY nnn *** nnn nnn nnn',
      'ticket.get': 'YYY YYY YYY *** YYY YYY nnn', 'mcp.read': 'YYY YYY YYY *** YYY YYY nnn',
      'mcp.write': 'nnn nnn nnn nnn nnn nnn nnn', 'budget.edit': 'nnn YYn YYY nnn YYY nnn nnn',
      'connector.manage': 'nnn YYY nnn nnn nnn nnn nnn', 'view.export': 'YYY YYY YYY *** YYY YYY YYY',
      'ingest.write': 'nnn YYY nnn nnn nnn nnn nnn', 'audit.read': 'YYY YYY nnn *** nnn YYY nnn',
    };
    expect(Object.keys(ACTION_MATRIX).sort()).toEqual([...MATRIX_ACTIONS].sort());
    for (const a of MATRIX_ACTIONS) {
      const got = ROLES.map((r: Role) => ACTION_MATRIX[a].cells[r].map((c) => (c === 'Y*' ? '*' : c)).join('')).join(' ');
      expect(got, a).toBe(PLAN[a].replace(/ +/g, ' '));
    }
    expect(MATRIX_ACTIONS.filter((a) => ACTION_MATRIX[a].requiresImpact)).toEqual(['change.approve']);
    expect(ACTION_MATRIX['change.approve'].requiresImpact).toEqual({ finance: 'cost', procurement: 'commitment' });
  });

  it('matrix_does_not_exceed_simulation_permissions', () => {
    // F6: src/simulation/server/workflow.ts:95-96, the per-action role table (drift-checked below).
    const SIM: Record<string, [MatrixAction, string[], number, string]> = {
      'request-change': ['change.request', ['technical'], 95, "'request-change': ['technical']"],
      'approve-change': ['change.approve', ['executive', 'procurement'], 96, "'approve-change': ['executive', 'procurement']"],
      'apply-change': ['change.apply', ['technical'], 96, "'apply-change': ['technical']"],
      budget: ['budget.edit', ['executive', 'procurement'], 95, "budget: ['executive', 'procurement']"],
    };
    const lines = fs.readFileSync(path.join(ROOT, 'src/simulation/server/workflow.ts'), 'utf8').split('\n');
    const persona: Partial<Record<Role, string>> = { cto: 'executive', finance: 'executive', eng_lead: 'technical', procurement: 'procurement' };
    for (const [cmd, [action, personas, line, literal]] of Object.entries(SIM)) {
      expect(lines[line - 1], cmd).toContain(literal);
      for (const [role, p] of Object.entries(persona) as Array<[Role, string]>) {
        if (ACTION_MATRIX[action].cells[role].some((c) => c !== 'n')) expect(personas, `${role} ${action}`).toContain(p);
      }
    }
  });

  it('exported policy is deeply frozen, so a write throws and changes no decision', () => {
    const frozen = (o: unknown): boolean => !o || typeof o !== 'object' || (Object.isFrozen(o) && Object.values(o).every(frozen));
    for (const o of [ACTION_MATRIX, VIEW_GROUPS, ROUTE_MATRIX, READABLE_CODES, ROUTE_STATUSES]) expect(frozen(o)).toBe(true);
    expect(() => {
      (ACTION_MATRIX['mcp.write'].cells.finops_lead as unknown as string[])[0] = 'Y';
    }).toThrow(TypeError);
    const finops: Principal = { sub: 'f', role: 'finops_lead', teams: '*', envs: ['dev'], tenant: 't', tokenId: 'j', expiresAt: 4e9, authMethod: 'mock-idp' };
    expect(authorize(finops, 'mcp.write', { kind: 'mcp_tool', id: 'x', env: 'dev' }).allow).toBe(false);
  });
});

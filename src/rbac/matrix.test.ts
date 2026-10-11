// Card A1: the permission matrix as data (PLAN 4.4 persona by view, PLAN 4.5
// persona by action). The expected values below are an independent literal
// copy of the PLAN tables, so editing the matrix without editing the plan (or
// this copy) fails a test.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  ACTION_MATRIX,
  ROUTE_MATRIX,
  ROUTE_STATUSES,
  VIEW_GROUPS,
  findRoute,
  type RouteRow,
} from './matrix';
import { authorize } from './authorize';
import { ACTIONS, DEPLOY_ENVS, PERSONA_ROLES, ROLES, type Action, type Principal, type Role } from '@/identity/types';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PAGES_DIR = path.join(REPO_ROOT, 'pages');
const CARD_ID = /^(?:A[1-8]|B(?:[1-9]|1[01])|C[1-8])$/;

/** Every route file under pages/, as [route path, repo-relative file]. */
function walkPages(dir = PAGES_DIR, acc: Array<[string, string]> = []): Array<[string, string]> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkPages(abs, acc);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
    const rel = path.relative(PAGES_DIR, abs).split(path.sep).join('/');
    // _app, _document and _error are not routes.
    if (/^_(app|document|error)\./.test(rel)) continue;
    let route = '/' + rel.replace(/\.(ts|tsx|js|jsx)$/, '');
    route = route.replace(/\/index$/, '') || '/';
    acc.push([route, `pages/${rel}`]);
  }
  return acc;
}

const PERSONA_COLUMNS = ['cto', 'finops_lead', 'finance', 'eng_lead', 'procurement', 'auditor'] as const;

function codesOf(groupId: RouteRow['group']): string {
  const g = VIEW_GROUPS[groupId];
  return PERSONA_COLUMNS.map((r) => g.codes[r]).join(' ');
}

describe('permission matrix', () => {
  it('matrix_covers_every_page_and_api_route', () => {
    const files = walkPages();
    expect(files.length).toBeGreaterThan(40);
    const missing: string[] = [];
    for (const [route, file] of files) {
      const row = findRoute(route);
      if (!row) {
        missing.push(route);
        continue;
      }
      expect(row.file, route).toBe(file);
      expect(ROUTE_STATUSES as readonly string[], route).toContain(row.status.replace(/\(.*\)$/, ''));
      expect(row.kind, route).toBe(route.startsWith('/api/') ? 'api' : 'page');
    }
    expect(missing, 'routes without a matrix row').toEqual([]);

    // A row whose file does not exist yet must name the card that plans it.
    const existing = new Set(files.map(([r]) => r));
    for (const row of ROUTE_MATRIX) {
      if (row.kind === 'facet') {
        expect(row.file, row.path).toBeNull();
        expect(row.facetOf && existing.has(row.facetOf), `${row.path} facet of an existing route`).toBe(true);
        continue;
      }
      const ext = row.kind === 'api' ? 'ts' : 'tsx';
      expect([`pages${row.path === '/' ? '/index' : row.path}.${ext}`, `pages${row.path}/index.${ext}`], row.path).toContain(row.file);
      if (!existing.has(row.path)) {
        expect(row.plannedBy, `${row.path} has no file and no plannedBy`).toMatch(CARD_ID);
      }
      if (row.plannedBy !== undefined) expect(row.plannedBy).toMatch(CARD_ID);
      if (row.status.startsWith('deferred(')) expect(row.status).toMatch(/^deferred\((?:A[1-8]|B(?:[1-9]|1[01])|C[1-8])\)$/);
      expect(ROUTE_STATUSES as readonly string[]).toContain(row.status.replace(/\(.*\)$/, ''));
    }

    // Paths are unique.
    const paths = ROUTE_MATRIX.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);

    // The demo pages and the sign-in page are public.
    for (const p of ['/demo', '/hello', '/finio/demo', '/sign-in']) {
      expect(findRoute(p)?.status, p).toBe('public');
    }
    // hello stays an explicit public liveness route (PLAN 4.3).
    expect(findRoute('/api/hello')?.status).toBe('public');
    // Only the listed rows are public; nothing else slipped in.
    expect(ROUTE_MATRIX.filter((r) => r.status === 'public').map((r) => r.path).sort()).toEqual(
      ['/api/hello', '/demo', '/finio/demo', '/hello', '/sign-in'].sort(),
    );
    // Simulation routes are sim_only; cm/change is deferred to C3 (or enforced once C3 lands).
    for (const [route] of files.filter(([r]) => r.startsWith('/api/v1/simulation/') || r === '/simulation' || r === '/workspace')) {
      expect(findRoute(route)?.status, route).toBe('sim_only');
    }
    expect(['deferred(C3)', 'enforced']).toContain(findRoute('/api/v1/cm/change')?.status);
    // Lookups are exact and never fall through to the prototype.
    for (const p of ['__proto__', 'constructor', 'toString', '/Overview', '/overview/', '']) {
      expect(findRoute(p), p).toBeUndefined();
    }
  });

  it('legacy_service_column_grants_exactly_todays_gateway_access', () => {
    // Today's gateway access, derived from the source rather than restated: an
    // API route file that calls withGateway, or the shared live-data gate, or
    // re-exports a file that does. Hello is public and counted separately.
    const GATE = /\bwithGateway\s*\(|\bgateSourceAccess\s*\(|\bevaluateLiveDataAuth\s*\(/;
    const apiFiles = walkPages().filter(([r]) => r.startsWith('/api/'));
    const gated = new Set<string>();
    // Follows a default re-export (`export { default } from '...'`) and a
    // default export built by an imported factory (`export default createX()`).
    const resolveSpec = (from: string, spec: string) =>
      spec.startsWith('@/') ? path.join(REPO_ROOT, 'src', `${spec.slice(2)}.ts`) : path.resolve(path.dirname(from), `${spec}.ts`);
    for (const [route, file] of apiFiles) {
      const abs = path.join(REPO_ROOT, file);
      const src = fs.readFileSync(abs, 'utf8');
      const reexport = src.match(/export\s*\{\s*default\s*\}\s*from\s*'([^']+)'/);
      const factory = src.match(/export\s+default\s+(create\w+)\s*\(/);
      const factoryImport = factory ? src.match(new RegExp(`import\\s*\\{[^}]*\\b${factory[1]}\\b[^}]*\\}\\s*from\\s*'([^']+)'`)) : null;
      const delegate = reexport?.[1] ?? factoryImport?.[1];
      const target = delegate ? fs.readFileSync(resolveSpec(abs, delegate), 'utf8') : src;
      if (GATE.test(target)) gated.add(route);
    }
    expect(gated.size).toBeGreaterThanOrEqual(12);
    // cm/change is reached through its ticket actions, not as a readable view.
    const viaActions = '/api/v1/cm/change';
    expect(gated.has(viaActions)).toBe(true);

    const legacyReadable = ROUTE_MATRIX.filter((r) => r.status !== 'public' && ['O', 'D', 'T', 'S', 'R', 'any'].includes(r.legacyService)).map((r) => r.path);
    expect(legacyReadable.sort()).toEqual([...gated].filter((r) => r !== viaActions).sort());
    expect(findRoute(viaActions)?.legacyService).toBe('see_4_5');
    // Every legacy cell is explicit: full access, the 4.5 marker, or none.
    for (const row of ROUTE_MATRIX) expect(['D', '-', 'see_4_5'], row.path).toContain(row.legacyService);
    // No page, and no route planned by this sprint, is legacy-readable.
    for (const row of ROUTE_MATRIX) {
      if (row.kind !== 'api' && row.status !== 'public') expect(row.legacyService, row.path).toBe('-');
      if (row.plannedBy) expect(row.legacyService, row.path).toBe('-');
    }

    // Actions: exactly today's cm/change operations (create, attach, status)
    // and the FinOps export; every other action is denied in every env.
    const allowed = ACTIONS.filter((a): a is Exclude<Action, 'view.read'> => a !== 'view.read').filter((a) => ACTION_MATRIX[a].cells.legacy_service.some((c) => c !== 'n'));
    expect(allowed.sort()).toEqual(['ticket.attach', 'ticket.create', 'ticket.status', 'view.export'].sort());
    for (const a of allowed) expect(ACTION_MATRIX[a].cells.legacy_service).toEqual(['Y', 'Y', 'Y']);
  });

  it('budget_edit_row_is_marked_deferred_with_no_enforcing_surface', () => {
    const row = ACTION_MATRIX['budget.edit'];
    expect(row.deferred).toBeDefined();
    expect(row.deferred?.enforcingSurface).toBeNull();
    expect(row.deferred?.source).toBe('src/store/useStore.ts:316-318');
    // The cited source is still the client-only threshold mutation.
    const store = fs.readFileSync(path.join(REPO_ROOT, 'src/store/useStore.ts'), 'utf8').split('\n');
    expect(store.slice(315, 318).join('\n')).toMatch(/updateThresholds/);
    // It is the only deferred action row, and a deferred row never yields an allow.
    const deferred = ACTIONS.filter((a) => a !== 'view.read' && ACTION_MATRIX[a].deferred !== undefined);
    expect(deferred).toEqual(['budget.edit']);
    const finance: Principal = {
      sub: 'f', role: 'finance', teams: '*', envs: ['dev', 'test', 'prod'], tenant: 't', tokenId: 'j',
      expiresAt: 4_102_444_800, authMethod: 'mock-idp',
    };
    for (const env of DEPLOY_ENVS) {
      expect(authorize(finance, 'budget.edit', { kind: 'view', id: '/workloads', env }).allow).toBe(false);
    }
  });

  it('matrix_has_rows_for_every_route_planned_by_this_plan', () => {
    const planned: Array<[string, string, string]> = [
      ['/api/v1/session/login', 'B7', 'public_mock'],
      ['/api/v1/session/logout', 'B7', 'enforced'],
      ['/api/v1/session/principal', 'B7', 'enforced'],
      ['/api/v1/session/mock-control', 'B7', 'public_mock'],
      ['/api/v1/workloads', 'B7', 'enforced'],
      ['/api/v1/cm/webhook', 'C4', 'signed'],
      ['/api/v1/audit/records', 'C5', 'enforced'],
      ['/audit', 'C5', 'enforced'],
      ['/sign-in', 'B11', 'public'],
    ];
    for (const [p, card, status] of planned) {
      const row = findRoute(p);
      expect(row, p).toBeDefined();
      expect(row?.plannedBy, p).toBe(card);
      expect(row?.status, p).toBe(status);
    }
    expect(VIEW_GROUPS[findRoute('/api/v1/cm/webhook')!.group].codes).toEqual(
      Object.fromEntries(PERSONA_ROLES.map((r) => [r, '-'])),
    );
  });

  it('matrix_view_codes_match_plan_section_4_4', () => {
    // [group, codes for cto finops_lead finance eng_lead procurement auditor, routes]
    const PLAN_4_4: Array<[string, string, string[]]> = [
      ['findings', 'O D O T O D', ['/']],
      ['overview', 'O D O T O D', ['/overview']],
      ['workloads', 'O D D T O D', ['/workloads']],
      ['connectors', 'S D S S S S', ['/connectors', '/api/v1/connectors']],
      ['costsource', '- D D T - D', ['/costsource', '/api/costsource/sources', '/api/costsource/rows', '/api/costsource/findings', '/api/costsource/health', '/api/costsource/ingest']],
      ['attribution', 'O D D T - D', ['/attribution', '/api/attribution']],
      ['attribution_user', '- D - - - D', ['attribution.user_dimension']],
      ['prediction', 'O D - T - D', ['/prediction', '/api/prediction/predict', '/api/prediction/accuracy']],
      ['tokenomics', 'O D D T O D', ['/tokenomics', '/api/tokenomics']],
      ['frameworks', 'R R R R R R', ['/frameworks']],
      ['reports', 'O D D T O D', ['/reports', '/api/report/snapshot']],
      ['finio_export', '- D D - - D', ['/finio', '/api/v1/finio/export', '/api/finio/export']],
      ['outcomes', 'O D O T O D', ['/outcomes', '/mission']],
      ['frank', 'O D O T O D', ['/agent-workflows', '/api/v1/ai/chat']],
      ['demo', 'R R R R R R', ['/demo', '/hello', '/finio/demo', '/api/hello']],
      ['published', '- D D - - D', ['/api/v1/costs/published', '/api/v1/a2a/handshake', '/api/a2a/handshake']],
      ['cm_change', 'see_4_5 see_4_5 see_4_5 see_4_5 see_4_5 see_4_5', ['/api/v1/cm/change']],
      ['audit', 'O D - T - D', ['/audit', '/api/v1/audit/records']],
      ['scoped_data', 'O D D T O D', ['/api/v1/workloads']],
      ['session', 'any any any any any any', ['/api/v1/session/principal', '/api/v1/session/logout', '/api/v1/session/login', '/api/v1/session/mock-control', '/sign-in']],
      ['webhook', '- - - - - -', ['/api/v1/cm/webhook']],
      ['simulation', 'dev_test_only dev_test_only dev_test_only dev_test_only dev_test_only dev_test_only', [
        '/simulation', '/workspace', '/api/v1/simulation/chat', '/api/v1/simulation/command', '/api/v1/simulation/frank',
        '/api/v1/simulation/operations', '/api/v1/simulation/report', '/api/v1/simulation/session', '/api/v1/simulation/state',
        '/api/v1/simulation/status',
      ]],
    ];
    expect(Object.keys(VIEW_GROUPS).sort()).toEqual(PLAN_4_4.map(([g]) => g).sort());
    const assigned: string[] = [];
    for (const [group, codes, routes] of PLAN_4_4) {
      expect(codesOf(group as RouteRow['group']), group).toBe(codes);
      for (const r of routes) {
        expect(findRoute(r)?.group, r).toBe(group);
        assigned.push(r);
      }
    }
    // Every row is in exactly one listed group (no unlisted row with other codes).
    expect(ROUTE_MATRIX.map((r) => r.path).sort()).toEqual(assigned.sort());
  });

  it('matrix_action_cells_match_plan_section_4_5', () => {
    // dev / test / prod; columns cto, finops_lead, finance, eng_lead, procurement, auditor.
    // The view.export and ingest.write rows are included; ticket.bind,
    // ticket.update and ticket.get are the pending amendment (Copilot revision 8).
    const PLAN: Record<Exclude<Action, 'view.read'>, string> = {
      'change.request': 'n / n / n | Y / Y / Y | n / n / n | Y* / Y* / Y* | n / n / n | n / n / n',
      'change.approve': 'Y / Y / Y | Y / Y / n | Y / Y / Y | n / n / n | Y / Y / Y | n / n / n',
      'change.apply': 'n / n / n | n / n / n | n / n / n | Y* / Y* / A | n / n / n | n / n / n',
      'ticket.create': 'n / n / n | Y / Y / Y | n / n / n | Y* / Y* / Y* | n / n / n | n / n / n',
      'ticket.attach': 'n / n / n | Y / Y / Y | n / n / n | Y* / Y* / Y* | n / n / n | n / n / n',
      'ticket.status': 'Y / Y / Y | Y / Y / Y | Y / Y / Y | Y* / Y* / Y* | Y / Y / Y | Y / Y / Y',
      'ticket.bind': 'n / n / n | Y / Y / Y | n / n / n | Y* / Y* / Y* | n / n / n | n / n / n',
      'ticket.update': 'n / n / n | Y / Y / Y | n / n / n | Y* / Y* / Y* | n / n / n | n / n / n',
      'ticket.get': 'Y / Y / Y | Y / Y / Y | Y / Y / Y | Y* / Y* / Y* | Y / Y / Y | Y / Y / Y',
      'mcp.read': 'Y / Y / Y | Y / Y / Y | Y / Y / Y | Y* / Y* / Y* | Y / Y / Y | Y / Y / Y',
      'mcp.write': 'n / n / n | n / n / n | n / n / n | n / n / n | n / n / n | n / n / n',
      'budget.edit': 'n / n / n | Y / Y / n | Y / Y / Y | n / n / n | Y / Y / Y | n / n / n',
      'connector.manage': 'n / n / n | Y / Y / Y | n / n / n | n / n / n | n / n / n | n / n / n',
      'view.export': 'Y / Y / Y | Y / Y / Y | Y / Y / Y | Y* / Y* / Y* | Y / Y / Y | Y / Y / Y',
      'ingest.write': 'n / n / n | Y / Y / Y | n / n / n | n / n / n | n / n / n | n / n / n',
      'audit.read': 'Y / Y / Y | Y / Y / Y | n / n / n | Y* / Y* / Y* | n / n / n | Y / Y / Y',
    };
    const rows = ACTIONS.filter((a): a is Exclude<Action, 'view.read'> => a !== 'view.read');
    expect(Object.keys(ACTION_MATRIX).sort()).toEqual(rows.slice().sort());
    for (const action of rows) {
      const got = PERSONA_COLUMNS.map((r) => ACTION_MATRIX[action].cells[r].join(' / ')).join(' | ');
      expect(got, action).toBe(PLAN[action]);
      // Every role, legacy included, has an explicit three-env cell.
      for (const role of ROLES) expect(ACTION_MATRIX[action].cells[role], `${action} ${role}`).toHaveLength(DEPLOY_ENVS.length);
    }
    // Qualifiers from the 4.5 cell text that authorize() enforces.
    expect(ACTION_MATRIX['change.approve'].requiresImpact).toEqual({ finance: 'cost', procurement: 'commitment' });
    for (const action of rows.filter((a) => a !== 'change.approve')) {
      expect(ACTION_MATRIX[action].requiresImpact, action).toBeUndefined();
    }
    // "A" appears only in eng_lead's prod apply cell; "Y*" only in the eng_lead column.
    for (const action of rows) {
      for (const role of ROLES) {
        ACTION_MATRIX[action].cells[role].forEach((cell, i) => {
          if (cell === 'A') expect([action, role, DEPLOY_ENVS[i]]).toEqual(['change.apply', 'eng_lead', 'prod']);
          if (cell === 'Y*') expect(role, action).toBe('eng_lead');
        });
      }
    }
    // MCP write tools are denied everywhere until D6.
    for (const role of ROLES) expect(ACTION_MATRIX['mcp.write'].cells[role]).toEqual(['n', 'n', 'n']);
    // The auditor column has no write cell.
    for (const action of ['change.request', 'change.approve', 'change.apply', 'ticket.create', 'ticket.attach', 'ticket.bind', 'ticket.update', 'mcp.write', 'budget.edit', 'connector.manage', 'ingest.write'] as const) {
      expect(ACTION_MATRIX[action].cells.auditor, action).toEqual(['n', 'n', 'n']);
    }
  });

  it('matrix_does_not_exceed_simulation_permissions', () => {
    // F6, restated as constants with their source line
    // (src/simulation/server/workflow.ts:95-96, the per-action role table).
    const SIM_SOURCE = 'src/simulation/server/workflow.ts';
    const SIM: Record<string, { personas: string[]; line: number; literal: string }> = {
      'request-change': { personas: ['technical'], line: 95, literal: "'request-change': ['technical']" },
      'approve-change': { personas: ['executive', 'procurement'], line: 96, literal: "'approve-change': ['executive', 'procurement']" },
      'apply-change': { personas: ['technical'], line: 96, literal: "'apply-change': ['technical']" },
      budget: { personas: ['executive', 'procurement'], line: 95, literal: "budget: ['executive', 'procurement']" },
    };
    // The constants still match the simulation source (a drift guard).
    const lines = fs.readFileSync(path.join(REPO_ROOT, SIM_SOURCE), 'utf8').split('\n');
    for (const [cmd, { line, literal }] of Object.entries(SIM)) {
      expect(lines[line - 1], `${SIM_SOURCE}:${line} ${cmd}`).toContain(literal);
    }
    // Closest simulation persona per role (PLAN 4.1; finance maps to executive
    // for approval per PLAN 4.5). Roles with no simulation persona are new.
    const SIM_PERSONA: Partial<Record<Role, string>> = {
      cto: 'executive', finance: 'executive', eng_lead: 'technical', procurement: 'procurement',
    };
    const MAP: Record<string, Exclude<Action, 'view.read'>> = {
      'request-change': 'change.request', 'approve-change': 'change.approve', 'apply-change': 'change.apply', budget: 'budget.edit',
    };
    for (const [cmd, action] of Object.entries(MAP)) {
      for (const [role, persona] of Object.entries(SIM_PERSONA) as Array<[Role, string]>) {
        const grantsAnywhere = ACTION_MATRIX[action].cells[role].some((c) => c !== 'n');
        if (grantsAnywhere) expect(SIM[cmd].personas, `${role} ${action} exceeds simulation ${cmd}`).toContain(persona);
      }
    }
    // And the mapping in PLAN 4.5 holds: request and apply map to eng_lead;
    // approve maps to cto, finance and procurement.
    expect(ACTION_MATRIX['change.request'].cells.eng_lead).toContain('Y*');
    expect(ACTION_MATRIX['change.apply'].cells.eng_lead).toContain('Y*');
    for (const r of ['cto', 'finance', 'procurement'] as const) expect(ACTION_MATRIX['change.approve'].cells[r]).toContain('Y');
  });
});

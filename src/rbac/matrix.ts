// The permission matrix as data (card A1): PLAN 4.4 (persona by view) and
// PLAN 4.5 (persona by action, per environment), plus the `legacy_service`
// column. Proposed until the owner ratifies it (D2). authorize() in
// ./authorize.ts is the only reader that makes decisions; tests enumerate it.
//
// Card C3 edits this file (sequenced after A1) to flip `/api/v1/cm/change`
// from `deferred(C3)` to `enforced`. No other card edits it.
import type { Action, ChangeImpact, DeployEnv, PersonaRole, Resource, Role } from '@/identity/types';

// ---------------------------------------------------------------------------
// PLAN 4.4: persona by view
// ---------------------------------------------------------------------------

/**
 * View codes. O organization roll-up; D drill-down, all teams; T drill-down
 * limited to the principal's own teams; S status only (never credentials);
 * R reference content; '-' no access. `any`: any authenticated principal
 * (session rows). `dev_test_only`: the simulation, which keeps its own session
 * model (RBAC never grants it). `see_4_5`: decided by the action matrix only.
 * `Y` and `Y*`: an action route written in PLAN 4.5 cell codes (all teams, own
 * teams); the route's `action` decides, and view.read on it stays denied.
 */
export type ViewCode = 'O' | 'D' | 'T' | 'S' | 'R' | '-' | 'any' | 'dev_test_only' | 'see_4_5' | 'Y' | 'Y*';

/** Codes that let a principal read a view (the scope is applied by the data seam). */
export const READABLE_CODES: readonly ViewCode[] = Object.freeze(['O', 'D', 'T', 'S', 'R', 'any'] as const);

export type CardId = `${'A' | 'B' | 'C'}${number}`;

/** Base route statuses; `deferred` is always written `deferred(<card>)`. */
export const ROUTE_STATUSES = Object.freeze(['enforced', 'public', 'public_mock', 'signed', 'sim_only', 'deferred'] as const);

/**
 * The intended final enforcement of a route. `enforced`: authentication plus
 * authorize() (wired by the card in `enforcedBy`); `public`: no principal
 * needed; `public_mock`: mock login, 404 unless the mock IdP is enabled;
 * `signed`: an HMAC signature instead of a bearer; `sim_only`: the simulation's
 * own session model, 404 unless the simulation is enabled; `deferred(<card>)`:
 * that card wires and then flips it.
 */
export type RouteStatus = Exclude<(typeof ROUTE_STATUSES)[number], 'deferred'> | `deferred(${CardId})`;

export type ViewGroupId =
  | 'findings' | 'overview' | 'workloads' | 'connectors' | 'costsource' | 'attribution' | 'attribution_user'
  | 'prediction' | 'tokenomics' | 'frameworks' | 'reports' | 'finio_export' | 'outcomes' | 'frank' | 'demo'
  | 'published' | 'cm_change' | 'audit' | 'scoped_data' | 'session' | 'webhook' | 'status_sync' | 'simulation';

export interface ViewGroup {
  label: string; // the PLAN 4.4 row
  codes: Readonly<Record<PersonaRole, ViewCode>>;
}

type Codes = [cto: ViewCode, finops_lead: ViewCode, finance: ViewCode, eng_lead: ViewCode, procurement: ViewCode, auditor: ViewCode];

function group(label: string, c: Codes): ViewGroup {
  const [cto, finops_lead, finance, eng_lead, procurement, auditor] = c;
  return Object.freeze({ label, codes: Object.freeze({ cto, finops_lead, finance, eng_lead, procurement, auditor }) });
}

const ALL = (code: ViewCode): Codes => [code, code, code, code, code, code];

export const VIEW_GROUPS: Readonly<Record<ViewGroupId, ViewGroup>> = Object.freeze({
  findings: group('Findings', ['O', 'D', 'O', 'T', 'O', 'D']),
  overview: group('Overview', ['O', 'D', 'O', 'T', 'O', 'D']),
  workloads: group('Workloads', ['O', 'D', 'D', 'T', 'O', 'D']),
  connectors: group('Connectors (FinOps lead configures)', ['S', 'D', 'S', 'S', 'S', 'S']),
  costsource: group('Cost sources', ['-', 'D', 'D', 'T', '-', 'D']),
  attribution: group('Attribution, team dimension', ['O', 'D', 'D', 'T', '-', 'D']),
  attribution_user: group('Attribution, user dimension (personal data)', ['-', 'D', '-', '-', '-', 'D']),
  prediction: group('Prediction', ['O', 'D', '-', 'T', '-', 'D']),
  tokenomics: group('Tokenomics (org-level aggregate: T is a role-only check)', ['O', 'D', 'D', 'T', 'O', 'D']),
  frameworks: group('Frameworks', ALL('R')),
  reports: group('Reports (export carries the caller scope)', ['O', 'D', 'D', 'T', 'O', 'D']),
  finio_export: group('FinOps export', ['-', 'D', 'D', '-', '-', 'D']),
  outcomes: group('Outcomes and executive dashboard', ['O', 'D', 'O', 'T', 'O', 'D']),
  frank: group('Frank (context built on the server from the caller scope only)', ['O', 'D', 'O', 'T', 'O', 'D']),
  demo: group('Demo pages (fixture data only)', ALL('R')),
  published: group('Published costs; A2A handshake', ['-', 'D', 'D', '-', '-', 'D']),
  cm_change: group('Change management (see PLAN 4.5)', ALL('see_4_5')),
  audit: group('Audit log', ['O', 'D', '-', 'T', '-', 'D']),
  scoped_data: group('Scoped data endpoint (workloads, budgets, alerts for the caller scope)', ['O', 'D', 'D', 'T', 'O', 'D']),
  session: group('Session endpoints and sign-in', ALL('any')),
  webhook: group('Inbound webhook (signature and replay check, no role)', ALL('-')),
  status_sync: group('Status sync (action ticket.update per PLAN 4.5)', ['-', 'Y', '-', 'Y*', '-', '-']),
  simulation: group('Customer simulation (dev and test only, own session model)', ALL('dev_test_only')),
});

export interface RouteRow {
  /** Route path (pages and API routes) or a facet id. */
  path: string;
  kind: 'page' | 'api' | 'facet';
  /** Repo-relative source file; null for a facet. */
  file: string | null;
  group: ViewGroupId;
  status: RouteStatus;
  /** The card that wires the enforcement (null when nothing is wired: public, signed by its own card, sim_only). */
  enforcedBy: CardId | null;
  /** Set when the file does not exist yet: the card that creates it. */
  plannedBy?: CardId;
  /** For a facet: the route whose data it qualifies. */
  facetOf?: string;
  /** For an action route: the PLAN 4.5 action that decides every operation on it. */
  action?: MatrixAction;
  /**
   * The legacy_service column: exactly today's access through the shared
   * token to gateway-wrapped routes (withGateway or the live-data gate).
   * '-' everywhere else, including every page and every route this plan adds.
   */
  legacyService: 'D' | '-' | 'see_4_5';
}

type RowSpec = Omit<RouteRow, 'kind' | 'file'> & { kind?: RouteRow['kind']; file?: string };

function row(spec: RowSpec): RouteRow {
  const kind = spec.kind ?? (spec.path.startsWith('/api/') ? 'api' : 'page');
  const file =
    kind === 'facet' ? null : (spec.file ?? `pages${spec.path === '/' ? '/index' : spec.path}.${kind === 'api' ? 'ts' : 'tsx'}`);
  return Object.freeze({ ...spec, kind, file });
}

const page = (path: string, group: ViewGroupId, extra: Partial<RowSpec> = {}): RouteRow =>
  row({ path, group, status: 'enforced', enforcedBy: 'B11', legacyService: '-', ...extra });

const api = (path: string, group: ViewGroupId, enforcedBy: CardId, extra: Partial<RowSpec> = {}): RouteRow =>
  row({ path, group, status: 'enforced', enforcedBy, legacyService: '-', ...extra });

const SIM = { status: 'sim_only', enforcedBy: null } as const;

export const ROUTE_MATRIX: readonly RouteRow[] = Object.freeze([
  // Pages (the view guard is card B11; pages read the store, scoped by B7/B8).
  page('/', 'findings'),
  page('/overview', 'overview'),
  page('/workloads', 'workloads'),
  page('/connectors', 'connectors'),
  page('/costsource', 'costsource'),
  page('/attribution', 'attribution'),
  page('/prediction', 'prediction'),
  page('/tokenomics', 'tokenomics'),
  page('/frameworks', 'frameworks'),
  page('/reports', 'reports'),
  page('/finio', 'finio_export'),
  page('/outcomes', 'outcomes'),
  page('/mission', 'outcomes'),
  page('/agent-workflows', 'frank'),
  page('/demo', 'demo', { status: 'public', enforcedBy: null }),
  page('/hello', 'demo', { status: 'public', enforcedBy: null }),
  page('/finio/demo', 'demo', { status: 'public', enforcedBy: null }),
  page('/simulation', 'simulation', SIM),
  page('/workspace', 'simulation', SIM),
  page('/audit', 'audit', { plannedBy: 'C5' }),
  page('/sign-in', 'session', { status: 'public', enforcedBy: null, plannedBy: 'B11' }),

  // Facet: the user dimension of attribution (personal data), checked by B3.
  row({
    path: 'attribution.user_dimension', kind: 'facet', group: 'attribution_user', status: 'enforced',
    enforcedBy: 'B3', facetOf: '/api/attribution', legacyService: '-',
  }),

  // Live-data gate routes (card B2). Today the shared token unlocks them.
  api('/api/v1/connectors', 'connectors', 'B2', { legacyService: 'D', file: 'pages/api/v1/connectors/index.ts' }),
  api('/api/costsource/sources', 'costsource', 'B2', { legacyService: 'D' }),
  api('/api/costsource/rows', 'costsource', 'B2', { legacyService: 'D' }),
  api('/api/costsource/findings', 'costsource', 'B2', { legacyService: 'D' }),
  api('/api/costsource/health', 'costsource', 'B2', { legacyService: 'D' }),

  // The six open routes (F3) and hello (card B3). Not gateway-wrapped today.
  api('/api/costsource/ingest', 'costsource', 'B3'),
  api('/api/attribution', 'attribution', 'B3'),
  api('/api/prediction/predict', 'prediction', 'B3'),
  api('/api/prediction/accuracy', 'prediction', 'B3'),
  api('/api/tokenomics', 'tokenomics', 'B3'),
  api('/api/report/snapshot', 'reports', 'B3'),
  api('/api/hello', 'demo', 'B3', { status: 'public', enforcedBy: null }),

  // Gateway-wrapped routes without a per-role check today (card B9).
  api('/api/v1/ai/chat', 'frank', 'B9', { legacyService: 'D' }),
  api('/api/v1/finio/export', 'finio_export', 'B9', { legacyService: 'D' }),
  api('/api/finio/export', 'finio_export', 'B9', { legacyService: 'D' }),
  api('/api/v1/costs/published', 'published', 'B9', { legacyService: 'D' }),
  api('/api/v1/a2a/handshake', 'published', 'B9', { legacyService: 'D' }),
  api('/api/a2a/handshake', 'published', 'B9', { legacyService: 'D' }),

  // Change management: every operation is decided by the action matrix (C3).
  api('/api/v1/cm/change', 'cm_change', 'C3', { status: 'deferred(C3)', legacyService: 'see_4_5' }),

  // Routes this plan adds.
  api('/api/v1/session/login', 'session', 'B7', { status: 'public_mock', plannedBy: 'B7' }),
  api('/api/v1/session/mock-control', 'session', 'B7', { status: 'public_mock', plannedBy: 'B7' }),
  api('/api/v1/session/logout', 'session', 'B7', { plannedBy: 'B7' }),
  api('/api/v1/session/principal', 'session', 'B7', { plannedBy: 'B7' }),
  api('/api/v1/workloads', 'scoped_data', 'B7', { plannedBy: 'B7' }),
  api('/api/v1/cm/webhook', 'webhook', 'C4', { status: 'signed', plannedBy: 'C4' }),
  api('/api/v1/cm/sync', 'status_sync', 'C8', { plannedBy: 'C8', action: 'ticket.update' }),
  api('/api/v1/audit/records', 'audit', 'C5', { plannedBy: 'C5' }),

  // Customer simulation: own session model, 404 unless enabled (F5).
  ...['chat', 'command', 'frank', 'operations', 'report', 'session', 'state', 'status'].map((name) =>
    api(`/api/v1/simulation/${name}`, 'simulation', 'B3', SIM),
  ),
]);

const ROUTE_INDEX: ReadonlyMap<string, RouteRow> = new Map(ROUTE_MATRIX.map((r) => [r.path, r]));

/** Exact lookup by path or facet id; never consults the prototype chain. */
export function findRoute(path: unknown): RouteRow | undefined {
  return typeof path === 'string' ? ROUTE_INDEX.get(path) : undefined;
}

// ---------------------------------------------------------------------------
// PLAN 4.5: persona by action, per environment
// ---------------------------------------------------------------------------

/** Y allowed; n denied; Y* own teams only; A own teams, approved ticket, approver differs from requester. */
export type Cell = 'Y' | 'n' | 'Y*' | 'A';

/** Cells in DEPLOY_ENVS order: dev, test, prod. */
export type EnvCells = readonly [dev: Cell, test: Cell, prod: Cell];

export type MatrixAction = Exclude<Action, 'view.read'>;

export interface ActionRow {
  cells: Readonly<Record<Role, EnvCells>>;
  /** Resource kinds the action may be asked about; anything else is denied. */
  kinds: readonly Resource['kind'][];
  /** Approval qualifiers from the PLAN cell text, enforced by authorize(). */
  requiresImpact?: Readonly<Partial<Record<Role, ChangeImpact>>>;
  /** Qualifiers enforced elsewhere (documented, not decided here). */
  notes?: Readonly<Partial<Record<Role, string>>>;
  /** A row with no enforcing surface: documents intent; authorize() never allows it. */
  deferred?: Readonly<{ reason: string; source: string; enforcingSurface: null }>;
}

type Cells7 = [cto: EnvCells, finops_lead: EnvCells, finance: EnvCells, eng_lead: EnvCells, procurement: EnvCells, auditor: EnvCells, legacy_service: EnvCells];

const N: EnvCells = Object.freeze(['n', 'n', 'n'] as const);
const Y: EnvCells = Object.freeze(['Y', 'Y', 'Y'] as const);
const YS: EnvCells = Object.freeze(['Y*', 'Y*', 'Y*'] as const);

/** A frozen copy per row, so no exported cell tuple is shared or writable. */
const cellsOf = (e: EnvCells): EnvCells => Object.freeze([...e]) as unknown as EnvCells;

function action(c: Cells7, kinds: readonly Resource['kind'][], extra: Omit<ActionRow, 'cells' | 'kinds'> = {}): ActionRow {
  const [cto, finops_lead, finance, eng_lead, procurement, auditor, legacy_service] = c;
  return Object.freeze({
    ...extra,
    kinds: Object.freeze([...kinds]),
    cells: Object.freeze({
      cto: cellsOf(cto), finops_lead: cellsOf(finops_lead), finance: cellsOf(finance), eng_lead: cellsOf(eng_lead),
      procurement: cellsOf(procurement), auditor: cellsOf(auditor), legacy_service: cellsOf(legacy_service),
    }),
  });
}

const CHANGE = ['change'] as const;
const TICKET = ['ticket', 'change'] as const;
const MCP = ['mcp_tool'] as const;
const VIEWS = ['view', 'route'] as const;

// Columns: cto, finops_lead, finance, eng_lead, procurement, auditor, legacy_service.
export const ACTION_MATRIX: Readonly<Record<MatrixAction, ActionRow>> = Object.freeze({
  'change.request': action([N, Y, N, YS, N, N, N], CHANGE),
  'change.approve': action([Y, ['Y', 'Y', 'n'], Y, N, Y, N, N], CHANGE, {
    requiresImpact: Object.freeze({ finance: 'cost', procurement: 'commitment' }),
    notes: Object.freeze({ finops_lead: 'prod approval needs CTO or Finance' }),
  }),
  'change.apply': action([N, N, N, ['Y*', 'Y*', 'A'], N, N, N], CHANGE),
  'ticket.create': action([N, Y, N, YS, N, N, Y], TICKET),
  'ticket.attach': action([N, Y, N, YS, N, N, Y], TICKET),
  'ticket.status': action([Y, Y, Y, YS, Y, Y, Y], TICKET),
  // Amendment rows (C3 lifecycle). Proposed: bind follows attach, update
  // follows create, get follows status. New operations: no legacy grant.
  'ticket.bind': action([N, Y, N, YS, N, N, N], TICKET),
  'ticket.update': action([N, Y, N, YS, N, N, N], TICKET),
  'ticket.get': action([Y, Y, Y, YS, Y, Y, N], TICKET),
  'mcp.read': action([Y, Y, Y, YS, Y, Y, N], MCP, {
    notes: Object.freeze({
      cto: 'summary tools (allowlist roles[], card B5)',
      finance: 'cost tools (allowlist roles[], card B5)',
      procurement: 'commitment tools (allowlist roles[], card B5)',
    }),
  }),
  'mcp.write': action([N, N, N, N, N, N, N], MCP), // denied everywhere until D6
  'budget.edit': action([N, ['Y', 'Y', 'n'], Y, N, Y, N, N], VIEWS, {
    deferred: Object.freeze({
      reason: 'threshold editing is a client-only store mutation with no server surface to enforce',
      source: 'src/store/useStore.ts:316-318',
      enforcingSurface: null,
    }),
  }),
  'connector.manage': action([N, Y, N, N, N, N, N], VIEWS),
  'view.export': action([Y, Y, Y, YS, Y, Y, Y], VIEWS, {
    notes: Object.freeze({ cto: 'roll-up shape (card B8)', procurement: 'roll-up shape (card B8)' }),
  }),
  'ingest.write': action([N, Y, N, N, N, N, N], ['route']),
  'audit.read': action([Y, Y, N, YS, N, Y, N], ['audit', 'view', 'route']),
});

/** The cell for a role, action and environment (DEPLOY_ENVS order). */
export function cellFor(row: ActionRow, role: Role, env: DeployEnv): Cell {
  const cells = row.cells[role];
  return cells[env === 'dev' ? 0 : env === 'test' ? 1 : 2];
}

/**
 * Routes an action on a view or route resource must match, beyond being
 * readable: `ingest.write` only on the ingest route, `connector.manage` only on
 * the connector registry, `audit.read` only on the audit views.
 */
export const ACTION_ROUTE_GROUPS: Readonly<Partial<Record<MatrixAction, readonly string[]>>> = Object.freeze({
  'ingest.write': Object.freeze(['/api/costsource/ingest']),
  'connector.manage': Object.freeze(['/connectors', '/api/v1/connectors']),
  'audit.read': Object.freeze(['/audit', '/api/v1/audit/records']),
});

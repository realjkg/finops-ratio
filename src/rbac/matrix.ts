// PLAN 4.4 (persona by view) and 4.5 (persona by action and env) as deeply frozen
// data, with the fail-closed legacy_service column. Proposed until D2; C3 flips cm/change.
import { PERSONA_ROLES, ROLES, type Action, type ChangeImpact, type PersonaRole, type Resource, type Role } from '@/identity/types';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) for (const v of Object.values(Object.freeze(o))) deepFreeze(v);
  return o;
}

// O roll-up; D all teams; T own teams; S status; R reference; '-' none; any: any principal;
// dev_test_only: the simulation's own session model; see_4_5, Y, Y*: an action route (PLAN 4.5).
export type ViewCode = 'O' | 'D' | 'T' | 'S' | 'R' | '-' | 'any' | 'dev_test_only' | 'see_4_5' | 'Y' | 'Y*';
export const READABLE_CODES: readonly ViewCode[] = deepFreeze(['O', 'D', 'T', 'S', 'R', 'any']);
export type CardId = `${'A' | 'B' | 'C'}${number}`;
export const ROUTE_STATUSES = deepFreeze(['enforced', 'public', 'public_mock', 'signed', 'sim_only', 'deferred'] as const);
export type RouteStatus = Exclude<(typeof ROUTE_STATUSES)[number], 'deferred'> | `deferred(${CardId})`;

// Codes per group, in the order cto finops_lead finance eng_lead procurement auditor.
const GROUP_CODES = {
  findings: 'O D O T O D', overview: 'O D O T O D', workloads: 'O D D T O D', connectors: 'S D S S S S',
  costsource: '- D D T - D', attribution: 'O D D T - D', attribution_user: '- D - - - D', prediction: 'O D - T - D',
  tokenomics: 'O D D T O D', frameworks: 'R R R R R R', reports: 'O D D T O D', finio_export: '- D D - - D',
  outcomes: 'O D O T O D', frank: 'O D O T O D', demo: 'R R R R R R', published: '- D D - - D',
  cm_change: 'see_4_5 see_4_5 see_4_5 see_4_5 see_4_5 see_4_5', audit: 'O D - T - D', scoped_data: 'O D D T O D',
  session: 'any any any any any any', webhook: '- - - - - -', status_sync: '- Y - Y* - -',
  simulation: 'dev_test_only dev_test_only dev_test_only dev_test_only dev_test_only dev_test_only',
} as const;
export type ViewGroupId = keyof typeof GROUP_CODES;

export const VIEW_GROUPS = deepFreeze(Object.fromEntries(Object.entries(GROUP_CODES).map(([g, s]) =>
  [g, { codes: Object.fromEntries(PERSONA_ROLES.map((r, i) => [r, s.split(' ')[i]])) }]))) as Readonly<Record<ViewGroupId, { codes: Readonly<Record<PersonaRole, ViewCode>> }>>;

export interface RouteRow {
  path: string; // route path, or a facet id
  kind: 'page' | 'api' | 'facet';
  group: ViewGroupId;
  status: RouteStatus;
  plannedBy?: CardId; // the card that creates a file that does not exist yet
  facetOf?: string; // facet only: the route whose data it qualifies
  action?: MatrixAction; // action route: the PLAN 4.5 action that decides it
  /** Exactly today's shared-token access (withGateway or the live-data gate); '-' elsewhere. */
  legacyService: 'D' | '-' | 'see_4_5';
}

type Opts = Partial<Omit<RouteRow, 'path' | 'group' | 'kind'>>;
const r = (path: string, group: ViewGroupId, o: Opts = {}): RouteRow => ({
  path, group, status: 'enforced', legacyService: '-', ...o,
  kind: path.startsWith('/api/') ? 'api' : path.startsWith('/') ? 'page' : 'facet',
});
const PUBLIC = { status: 'public' } as const;
const SIM = { status: 'sim_only' } as const;
const LEGACY = { legacyService: 'D' } as const;

export const ROUTE_MATRIX: readonly RouteRow[] = deepFreeze([
  r('/', 'findings'), r('/overview', 'overview'), r('/workloads', 'workloads'), r('/connectors', 'connectors'),
  r('/costsource', 'costsource'), r('/attribution', 'attribution'), r('/prediction', 'prediction'),
  r('/tokenomics', 'tokenomics'), r('/frameworks', 'frameworks'), r('/reports', 'reports'), r('/finio', 'finio_export'),
  r('/outcomes', 'outcomes'), r('/mission', 'outcomes'), r('/agent-workflows', 'frank'),
  r('/demo', 'demo', PUBLIC), r('/hello', 'demo', PUBLIC), r('/finio/demo', 'demo', PUBLIC),
  r('/simulation', 'simulation', SIM), r('/workspace', 'simulation', SIM),
  r('/audit', 'audit', { plannedBy: 'C5' }), r('/sign-in', 'session', { ...PUBLIC, plannedBy: 'B11' }),
  r('attribution.user_dimension', 'attribution_user', { facetOf: '/api/attribution' }),
  // Live-data gate (B2) and gateway-wrapped (B9) routes: the shared token reaches them today.
  r('/api/v1/connectors', 'connectors', LEGACY), r('/api/costsource/sources', 'costsource', LEGACY),
  r('/api/costsource/rows', 'costsource', LEGACY), r('/api/costsource/findings', 'costsource', LEGACY),
  r('/api/costsource/health', 'costsource', LEGACY), r('/api/v1/ai/chat', 'frank', LEGACY),
  r('/api/v1/finio/export', 'finio_export', LEGACY), r('/api/finio/export', 'finio_export', LEGACY),
  r('/api/v1/costs/published', 'published', LEGACY), r('/api/v1/reports/facts', 'published', LEGACY), r('/api/v1/reports/engagement', 'published', LEGACY), r('/api/v1/a2a/handshake', 'published', LEGACY),
  r('/api/a2a/handshake', 'published', LEGACY),
  // The open routes of F3 (B3); hello stays public.
  r('/api/costsource/ingest', 'costsource'), r('/api/attribution', 'attribution'), r('/api/prediction/predict', 'prediction'),
  r('/api/prediction/accuracy', 'prediction'), r('/api/tokenomics', 'tokenomics'), r('/api/report/snapshot', 'reports'),
  r('/api/hello', 'demo', PUBLIC),
  r('/api/v1/cm/change', 'cm_change', { status: 'deferred(C3)', legacyService: 'see_4_5' }),
  // R2: engagement sign-in (engagement mode only; login is the open entry, logout and session need the session).
  r('/api/auth/login', 'session'), r('/api/auth/logout', 'session'), r('/api/auth/session', 'session'),
  // Routes this plan adds.
  r('/api/v1/session/login', 'session', { status: 'public_mock', plannedBy: 'B7' }),
  r('/api/v1/session/mock-control', 'session', { status: 'public_mock', plannedBy: 'B7' }),
  r('/api/v1/session/logout', 'session', { plannedBy: 'B7' }), r('/api/v1/session/principal', 'session', { plannedBy: 'B7' }),
  r('/api/v1/workloads', 'scoped_data', { plannedBy: 'B7' }),
  r('/api/v1/cm/webhook', 'webhook', { status: 'signed', plannedBy: 'C4' }),
  r('/api/v1/cm/sync', 'status_sync', { plannedBy: 'C8', action: 'ticket.update' }),
  r('/api/v1/audit/records', 'audit', { plannedBy: 'C5' }),
  ...['chat', 'command', 'frank', 'operations', 'report', 'session', 'state', 'status'].map((n) =>
    r(`/api/v1/simulation/${n}`, 'simulation', SIM)),
]);

const ROUTE_INDEX = new Map(ROUTE_MATRIX.map((row) => [row.path, row]));
/** Exact lookup by path or facet id. */
export const findRoute = (path: unknown): RouteRow | undefined => ROUTE_INDEX.get(path as string);

/** Y allowed; n denied; Y* own teams; A own teams, approved ticket, approver differs from requester. */
export type Cell = 'Y' | 'n' | 'Y*' | 'A';
export type EnvCells = readonly [dev: Cell, test: Cell, prod: Cell];
export type MatrixAction = Exclude<Action, 'view.read'>;

export interface ActionRow {
  cells: Readonly<Record<Role, EnvCells>>;
  kinds: readonly Resource['kind'][]; // any other resource kind is denied
  routes?: readonly string[]; // on a view or route resource, only these ids
  requiresImpact?: Readonly<Partial<Record<Role, ChangeImpact>>>;
  /** No enforcing surface: documents intent; authorize() never allows it. */
  deferred?: Readonly<{ source: string; enforcingSurface: null }>;
}

const N: EnvCells = ['n', 'n', 'n'];
const Y: EnvCells = ['Y', 'Y', 'Y'];
const YS: EnvCells = ['Y*', 'Y*', 'Y*'];
type Cells7 = [EnvCells, EnvCells, EnvCells, EnvCells, EnvCells, EnvCells, EnvCells];
const a = (c: Cells7, kinds: readonly Resource['kind'][], extra: Partial<ActionRow> = {}): ActionRow =>
  ({ ...extra, kinds, cells: Object.fromEntries(ROLES.map((role, i) => [role, c[i]])) as unknown as Record<Role, EnvCells> });
const CHANGE = ['change'] as const;
const TICKET = ['ticket', 'change'] as const;
const VIEWS = ['view', 'route'] as const;

// Columns: cto, finops_lead, finance, eng_lead, procurement, auditor, legacy_service.
// Notes kept from the PLAN cells: finops_lead prod approval needs CTO or
// Finance; mcp.read tool classes (summary, cost, commitment) are enforced by
// B5's allowlist roles[]; cto and procurement exports are roll-ups (B8).
// Amendment rows: bind follows attach, update follows create, get follows status.
export const ACTION_MATRIX: Readonly<Record<MatrixAction, ActionRow>> = deepFreeze({
  'change.request': a([N, Y, N, YS, N, N, N], CHANGE),
  'change.approve': a([Y, ['Y', 'Y', 'n'], Y, N, Y, N, N], CHANGE, { requiresImpact: { finance: 'cost', procurement: 'commitment' } }),
  'change.apply': a([N, N, N, ['Y*', 'Y*', 'A'], N, N, N], CHANGE),
  'ticket.create': a([N, Y, N, YS, N, N, Y], TICKET),
  'ticket.attach': a([N, Y, N, YS, N, N, Y], TICKET),
  'ticket.status': a([Y, Y, Y, YS, Y, Y, Y], TICKET),
  'ticket.bind': a([N, Y, N, YS, N, N, N], TICKET),
  'ticket.update': a([N, Y, N, YS, N, N, N], TICKET),
  'ticket.get': a([Y, Y, Y, YS, Y, Y, N], TICKET),
  'mcp.read': a([Y, Y, Y, YS, Y, Y, N], ['mcp_tool']),
  'mcp.write': a([N, N, N, N, N, N, N], ['mcp_tool']), // denied everywhere until D6
  'budget.edit': a([N, ['Y', 'Y', 'n'], Y, N, Y, N, N], VIEWS, { deferred: { source: 'src/store/useStore.ts:316-318', enforcingSurface: null } }),
  'connector.manage': a([N, Y, N, N, N, N, N], VIEWS, { routes: ['/connectors', '/api/v1/connectors'] }),
  'view.export': a([Y, Y, Y, YS, Y, Y, Y], VIEWS),
  'ingest.write': a([N, Y, N, N, N, N, N], ['route'], { routes: ['/api/costsource/ingest'] }),
  'audit.read': a([Y, Y, N, YS, N, Y, N], ['audit', 'view', 'route'], { routes: ['/audit', '/api/v1/audit/records'] }),
});

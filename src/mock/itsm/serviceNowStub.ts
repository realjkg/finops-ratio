// Mock ServiceNow server: the wire subset the real ServiceNowAdapter uses.
//   POST /api/now/table/change_request   create (201 { result: { number, ... } })
//   GET  /api/now/table/change_request   sysparm_query=number=..., sysparm_fields,
//                                        sysparm_limit (200 { result: [...] })
// Basic auth. Loopback only. Nothing is logged except method, path, status.

import {
  applyInjectedFailure,
  listenLoopback,
  readBody,
  safeEqual,
  sendJson,
  type RunningStub,
  type ServiceNowChange,
  type StubOptions,
} from './state';

export interface ServiceNowStubOptions extends StubOptions {
  username: string;
  /** The Basic-auth credential the stub accepts for `username`. */
  credential: string;
}

const FAILURE_BODIES = {
  unauthorized: { error: { message: 'User Not Authenticated', detail: 'Required to provide Auth information' }, status: 'failure' },
  rateLimited: { error: { message: 'Rate limit exceeded', detail: 'Too many requests' }, status: 'failure' },
  serverError: { error: { message: 'Internal server error', detail: 'Unexpected failure' }, status: 'failure' },
};

const TABLE_PATH = '/api/now/table/change_request';
const DEFAULT_LIMIT = 10000;

export async function startServiceNowStub(options: ServiceNowStubOptions): Promise<RunningStub> {
  const expected = `Basic ${Buffer.from(`${options.username}:${options.credential}`).toString('base64')}`;

  const stub = await listenLoopback(options, async (req, res, url) => {
    if (await applyInjectedFailure(stub.state, res, FAILURE_BODIES)) return;

    const supplied = req.headers.authorization;
    if (typeof supplied !== 'string' || !safeEqual(supplied, expected)) {
      sendJson(res, 401, FAILURE_BODIES.unauthorized);
      return;
    }
    if (url.pathname !== TABLE_PATH) {
      sendJson(res, 404, { error: { message: 'Invalid table', detail: null }, status: 'failure' });
      return;
    }

    if (req.method === 'POST') {
      const raw = await readBody(req);
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = raw === null ? undefined : (JSON.parse(raw) as Record<string, unknown>);
      } catch {
        parsed = undefined;
      }
      const short = parsed?.short_description;
      if (typeof short !== 'string' || short.length === 0) {
        sendJson(res, 400, { error: { message: 'Invalid request', detail: 'short_description is required' }, status: 'failure' });
        return;
      }
      const change = stub.state.createServiceNowChange({
        shortDescription: short,
        description: typeof parsed?.description === 'string' ? parsed.description : undefined,
      });
      sendJson(res, 201, { result: toRecord(change) });
      return;
    }

    if (req.method === 'GET') {
      const query = url.searchParams.get('sysparm_query') ?? '';
      const terms = parseQuery(query);
      if (terms === null) {
        sendJson(res, 400, { error: { message: 'Invalid query', detail: 'only field=value terms joined by ^ are supported' }, status: 'failure' });
        return;
      }
      const limitParam = url.searchParams.get('sysparm_limit');
      const limit = limitParam === null ? DEFAULT_LIMIT : Number.parseInt(limitParam, 10);
      const fields = url.searchParams.get('sysparm_fields');
      const wanted = fields ? fields.split(',').map((f) => f.trim()).filter(Boolean) : null;

      const rows = stub.state
        .listServiceNowChanges()
        .map(toRecord)
        .filter((row) => terms.every(([field, value]) => row[field] === value))
        .slice(0, Number.isFinite(limit) && limit >= 0 ? limit : DEFAULT_LIMIT)
        .map((row) => (wanted ? Object.fromEntries(wanted.filter((f) => f in row).map((f) => [f, row[f]])) : row));
      sendJson(res, 200, { result: rows });
      return;
    }
    sendJson(res, 405, { error: { message: 'Method not allowed', detail: null }, status: 'failure' });
  });
  return stub;
}

function toRecord(change: ServiceNowChange): Record<string, string> {
  return {
    sys_id: change.sysId,
    number: change.number,
    short_description: change.shortDescription,
    description: change.description,
    state: change.state,
    sys_created_on: change.sysCreatedOn,
    sys_updated_on: change.sysUpdatedOn,
  };
}

/** `a=b^c=d` to pairs; null when any term is not a plain equality. */
function parseQuery(query: string): Array<[string, string]> | null {
  if (query === '') return [];
  const terms: Array<[string, string]> = [];
  for (const part of query.split('^')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    terms.push([part.slice(0, eq), part.slice(eq + 1)]);
  }
  return terms;
}

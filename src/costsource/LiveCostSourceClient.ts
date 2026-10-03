// Live client — calls the Next.js /api/costsource/* routes. Mirrors
// LiveFinioClient / LiveTokenomicsClient error handling: throws a typed Error on
// both network failure and non-2xx so callers always see a message, never a raw
// fetch rejection or silent undefined.
//
// In this PR the routes serve the same offline seed (no external PointFive). The
// live PointFive adapter — MCP SSE + OAuth 2.1 against mcp.pointfive.co — is PR E.
import type {
  CostSourceClient,
  CostSourceDescriptor,
  CostRowsResult,
  CostFinding,
  SourceHealth,
  CostWindow,
} from './CostSourceClient';
import { withBasePath } from '@/lib/basePath';
import { describeHttpError } from '@/lib/httpError';

/** User-readable message for a live-data request refused for lack of API auth. */
export const LIVE_DATA_AUTH_MESSAGE = 'Live connector data requires authenticated API access';

/**
 * Typed error for a 401 from the live-data routes. The browser client carries
 * no API token (by design — tokens are never embedded in or forwarded from the
 * browser), so live connector data is only reachable through the authenticated
 * API; sandbox sources keep working anonymously.
 */
export class LiveDataAuthError extends Error {
  readonly status = 401;
  constructor() {
    super(LIVE_DATA_AUTH_MESSAGE);
    this.name = 'LiveDataAuthError';
  }
}

async function getJson<T>(url: string, label: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`${label} unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401) {
    throw new LiveDataAuthError();
  }
  if (!res.ok) {
    throw new Error(await describeHttpError(label, res));
  }
  return (await res.json()) as T;
}

export class LiveCostSourceClient implements CostSourceClient {
  readonly mode = 'live' as const;

  async listSources(): Promise<CostSourceDescriptor[]> {
    return getJson<CostSourceDescriptor[]>(withBasePath('/api/costsource/sources'), 'CostSource listSources');
  }

  async fetchCostRows(sourceId: string, window: CostWindow): Promise<CostRowsResult> {
    const params = new URLSearchParams({
      sourceId,
      start: window.start,
      end: window.end,
    });
    return getJson<CostRowsResult>(
      withBasePath(`/api/costsource/rows?${params.toString()}`),
      'CostSource fetchCostRows',
    );
  }

  async fetchFindings(sourceId: string): Promise<CostFinding[]> {
    const params = new URLSearchParams({ sourceId });
    return getJson<CostFinding[]>(
      withBasePath(`/api/costsource/findings?${params.toString()}`),
      'CostSource fetchFindings',
    );
  }

  async healthCheck(sourceId: string): Promise<SourceHealth> {
    const params = new URLSearchParams({ sourceId });
    return getJson<SourceHealth>(
      withBasePath(`/api/costsource/health?${params.toString()}`),
      'CostSource healthCheck',
    );
  }
}


// Live client — fetches from the Next.js /api/attribution route. Mirrors
// LiveTokenomicsClient error handling: throws a typed Error on network failure
// and non-2xx so callers always see a message, never a raw fetch rejection.
import type {
  AttributionClient,
  AttributionDimension,
  AttributionReport,
} from './AttributionClient';
import { withBasePath } from '@/lib/basePath';
import { describeHttpError, readJsonResponse } from '@/lib/httpError';

const ATTRIBUTION_URL = withBasePath('/api/attribution');

export class LiveAttributionClient implements AttributionClient {
  readonly mode = 'live' as const;

  async getAttributionReport(dimension: AttributionDimension): Promise<AttributionReport> {
    let res: Response;
    try {
      res = await fetch(`${ATTRIBUTION_URL}?dimension=${encodeURIComponent(dimension)}`);
    } catch (err) {
      throw new Error(
        `Attribution API unreachable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!res.ok) {
      throw new Error(await describeHttpError('Attribution API', res));
    }
    return readJsonResponse<AttributionReport>(res, 'Attribution API');
  }
}

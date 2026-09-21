// Live client — fetches from the Next.js /api/tokenomics route. Mirrors
// LiveFinioClient error handling: throws a typed Error on network failure and
// non-2xx so callers always see a message, never a raw fetch rejection.
import type { TokenomicsClient, TokenomicsReport } from './TokenomicsClient';
import { withBasePath } from '@/lib/basePath';

const TOKENOMICS_URL = withBasePath('/api/tokenomics');

export class LiveTokenomicsClient implements TokenomicsClient {
  readonly mode = 'live' as const;

  async getTokenomicsReport(): Promise<TokenomicsReport> {
    let res: Response;
    try {
      res = await fetch(TOKENOMICS_URL);
    } catch (err) {
      throw new Error(
        `Tokenomics API unreachable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `Tokenomics API error ${res.status}: ${await res.text()}`,
      );
    }
    return (await res.json()) as TokenomicsReport;
  }
}


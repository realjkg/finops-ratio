// Attribution slice public API — mirrors src/tokenomics/index.ts.
// Callers only ever see the AttributionClient interface and createAttributionClient;
// concrete implementations are internal details.
import { LiveAttributionClient } from './LiveAttributionClient';
import { MockAttributionClient } from './MockAttributionClient';
import type {
  AttributionClient,
  AttributionDimension,
  AttributionReport,
  AttributionRow,
  AttributionRowInputs,
} from './AttributionClient';

export type {
  AttributionClient,
  AttributionDimension,
  AttributionReport,
  AttributionRow,
  AttributionRowInputs,
};

export { ATTRIBUTION_DIMENSIONS, isAttributionDimension } from './AttributionClient';

/** Returns MockAttributionClient by default; pass `'live'` to get LiveAttributionClient. */
export function createAttributionClient(
  mode: 'mock' | 'live' = 'mock',
): AttributionClient {
  return mode === 'live' ? new LiveAttributionClient() : new MockAttributionClient();
}

// In-memory mock — no network. Derives the report from the same seeds the rest
// of the app uses: WORKLOADS for the team dimension, USER_QUERY_EVENTS (the
// deterministic sampled AgentQuery log) for the user dimension. No invented
// numbers: every row's inputs are the workload/event records it summed.
import type {
  AttributionClient,
  AttributionDimension,
  AttributionReport,
} from './AttributionClient';
import { teamAttributionRows, userAttributionRows } from './aggregations';
import { USER_QUERY_EVENTS } from '@/data/userQueries';
import { DEMO_NOW, WORKLOADS } from '@/data/workloads';

/** The reporting window, stated from the deterministic demo clock. */
export function attributionWindow(): string {
  const monthStart = new Date(Date.UTC(DEMO_NOW.getUTCFullYear(), DEMO_NOW.getUTCMonth(), 1));
  const asOf = DEMO_NOW.toISOString().slice(0, 10);
  const start = monthStart.toISOString().slice(0, 10);
  return start === asOf ? `month-to-date through ${asOf} (demo clock)` : `month-to-date ${start} → ${asOf} (demo clock)`;
}

export class MockAttributionClient implements AttributionClient {
  readonly mode = 'mock' as const;

  async getAttributionReport(dimension: AttributionDimension): Promise<AttributionReport> {
    // Small delay so the UI can show a realistic loading state (mock precedent).
    await new Promise((resolve) => setTimeout(resolve, 200));

    const rows = dimension === 'team' ? teamAttributionRows(WORKLOADS) : userAttributionRows(USER_QUERY_EVENTS);

    return {
      generatedAt: new Date().toISOString(),
      dimension,
      window: attributionWindow(),
      rows,
      totalInferenceCost: sum(rows.map((r) => r.inferenceCost)),
      totalTokensIn: sum(rows.map((r) => r.tokensIn)),
      totalTokensOut: sum(rows.map((r) => r.tokensOut)),
    };
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

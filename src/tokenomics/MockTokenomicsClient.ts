// In-memory mock — no network. Returns a TokenomicsReport built from the
// exported seed inputs (src/tokenomics/seeds.ts) via the shared report
// assembly, mirroring MockFinioClient's pattern.
import type { TokenomicsClient, TokenomicsReport } from './TokenomicsClient';
import { buildTokenomicsReport } from './reportAssembly';
import {
  COUNTER_ALIGNMENT_SEED,
  PIPELINE_INTEGRITY_SEED,
  LEDGER_SYNC_SEED,
} from './seeds';

export class MockTokenomicsClient implements TokenomicsClient {
  readonly mode = 'mock' as const;

  async getTokenomicsReport(): Promise<TokenomicsReport> {
    // Small delay so the UI can show a realistic loading state.
    await new Promise((resolve) => setTimeout(resolve, 200));

    return buildTokenomicsReport(
      {
        counterAlignment: COUNTER_ALIGNMENT_SEED,
        pipelineIntegrity: PIPELINE_INTEGRITY_SEED,
        ledgerSync: LEDGER_SYNC_SEED,
      },
      new Date().toISOString(),
    );
  }
}

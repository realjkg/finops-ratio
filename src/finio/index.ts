// FinIO slice public API — mirrors src/hello/index.ts.
// Callers only ever see the FinioClient interface and createFinioClient;
// concrete implementations are an internal detail.
//
// Nothing server-side is re-exported here: config.ts and sessionStore.ts import
// Node's `crypto` and are imported only by the API routes.
import { LiveFinioClient } from './LiveFinioClient';
import { MockFinioClient } from './MockFinioClient';
import type { FinioClient } from './FinioClient';

export type {
  FinioClient,
  FinioExport,
  FinioOperation,
  FocusRow,
  FocusVersion,
  HandshakeRequest,
  HandshakeResult,
} from './FinioClient';
export { FINIO_OPERATIONS, FINIO_SOURCE_ID } from './FinioClient';
export { validateFocusRow, validateFocusRows } from './focusValidation';
export type { FocusRowValidation } from './focusValidation';
export { SUPPORTED_FOCUS_VERSIONS } from './exchange';

/** Returns MockFinioClient by default; pass `'live'` to get LiveFinioClient. */
export function createFinioClient(mode: 'mock' | 'live' = 'mock'): FinioClient {
  return mode === 'live' ? new LiveFinioClient() : new MockFinioClient();
}

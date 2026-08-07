// In-memory mock — no network, no Node crypto, browser-safe.
//
// It runs the SAME exchange rules as the live route (src/finio/exchange.ts):
// it negotiates the FOCUS version, rejects an unsupported one with the same 409
// text, mints a session with a real expiry, and refuses an unknown or expired
// session with the same 401. The only thing it swaps out is the session's
// integrity mechanism — an in-process map instead of an HMAC — because the mock
// is one peer talking to itself and has no signature to defend.
//
// Rows come from the shared builder, so mock rows and live rows are identical by
// construction rather than by hopeful duplication.

import type { FinioClient, FinioExport, HandshakeRequest, HandshakeResult } from './FinioClient';
import type { FocusVersion } from './FinioClient';
import {
  INVALID_SESSION,
  acceptedOperations,
  buildFinioExport,
  failureMessage,
  negotiateFocusVersion,
  parseHandshakeRequest,
} from './exchange';

const SESSION_TTL_MS = 5 * 60_000;

export class MockFinioClient implements FinioClient {
  readonly mode = 'mock' as const;

  // Sessions the mock has issued: id -> what it was issued for.
  private readonly sessions = new Map<string, { expiresAtMs: number; focusVersion: FocusVersion }>();

  async handshake(req: HandshakeRequest): Promise<HandshakeResult> {
    // Simulate a short network round-trip so the loading state is visible.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const parsed = parseHandshakeRequest(req);
    if (!parsed.ok) throw new Error(failureMessage('handshake', parsed.failure));

    const negotiated = negotiateFocusVersion(parsed.request.focusVersion);
    if (!negotiated.ok) throw new Error(failureMessage('handshake', negotiated.failure));

    const expiresAtMs = Date.now() + SESSION_TTL_MS;
    const sessionId = `mock.${negotiated.version}.${parsed.request.nonce}`;
    this.sessions.set(sessionId, { expiresAtMs, focusVersion: negotiated.version });

    return {
      sessionId,
      accepts: acceptedOperations(parsed.request.capabilities),
      focusVersion: negotiated.version,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async export(sessionId: string): Promise<FinioExport> {
    // Small delay so the UI shows a realistic two-phase loading state.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const session = this.sessions.get(sessionId);
    if (!session || Date.now() > session.expiresAtMs) {
      this.sessions.delete(sessionId);
      throw new Error(failureMessage('export', INVALID_SESSION));
    }

    return buildFinioExport(session.focusVersion);
  }
}

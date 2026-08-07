// POST /api/v1/a2a/handshake — step 1 of the FinIO A2A exchange.
//
// Versioned under /v1/ and composed with withGateway per the API-First rule in
// .obvious/obvious.md. The earlier unversioned route did neither: it sat at
// /api/a2a/handshake outside the version prefix and hand-rolled its own method
// guard and error shape, so it had no payload-size limit, no per-tenant rate
// limit, no structured request log, and returned {error: string} while every
// other route in the repo returns {error:{code,message}}.
//
// The gateway owns: 405 method, 413 oversized, 401 tenant auth, 429 rate limit,
// 500 on a thrown handler. This handler owns the FinIO-specific outcomes:
//   401 — missing or wrong X-FinIO-Peer-Token (only when one is configured)
//   400 — malformed handshake body
//   409 — a focusVersion outside the supported v1.0-v1.4 range

import type { NextApiRequest, NextApiResponse } from 'next';
import { withGateway, sendError, type GatewayContext } from '@/server/gateway';
import { checkPeerToken, resolveFinioPeerAuth } from '@/finio/config';
import { createSession } from '@/finio/sessionStore';
import {
  acceptedOperations,
  negotiateFocusVersion,
  parseHandshakeRequest,
} from '@/finio/exchange';
import type { HandshakeResult } from '@/finio/FinioClient';

/** Read the peer token from its dedicated header. */
function peerToken(req: NextApiRequest): string | null {
  const raw = req.headers['x-finio-peer-token'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function handshake(
  req: NextApiRequest,
  res: NextApiResponse,
  _ctx: GatewayContext,
): Promise<void> {
  // --- A2A peer authentication (distinct from the gateway's tenant auth) ---
  const auth = checkPeerToken(peerToken(req), resolveFinioPeerAuth());
  if (!auth.ok) {
    sendError(res, 401, 'unauthorized_peer', auth.message);
    return;
  }

  // --- Body ---
  const parsed = parseHandshakeRequest(req.body);
  if (!parsed.ok) {
    sendError(res, parsed.failure.status, parsed.failure.code, parsed.failure.message);
    return;
  }

  // --- FOCUS version negotiation ---
  const negotiated = negotiateFocusVersion(parsed.request.focusVersion);
  if (!negotiated.ok) {
    sendError(res, negotiated.failure.status, negotiated.failure.code, negotiated.failure.message);
    return;
  }

  // --- Mint a session bound to the negotiated version ---
  const session = createSession(negotiated.version);

  const result: HandshakeResult = {
    sessionId: session.sessionId,
    accepts: acceptedOperations(parsed.request.capabilities),
    focusVersion: session.focusVersion,
    expiresAt: session.expiresAt,
  };
  res.status(200).json(result);
}

export default withGateway(handshake, { methods: ['POST'] });

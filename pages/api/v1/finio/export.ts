// GET /api/v1/finio/export — step 2 of the FinIO A2A exchange.
//
// Validates the session minted by /api/v1/a2a/handshake, then emits FOCUS rows
// at the version that session was issued for. Pure over seed data — no
// persistence, no external calls.
//
// Two things the earlier route did not do. It ignored the negotiated version and
// always emitted its own default, which made the handshake's version field
// decorative. And it never checked its own output, so a malformed row would have
// gone to the peer unnoticed; the export is now validated before it is sent, and
// a failure is reported as a 500 here rather than as a schema violation there.
//
// Errors:
//   401 — missing, unknown, or expired session
//   500 — the responder built a row that fails FOCUS validation

import type { NextApiRequest, NextApiResponse } from 'next';
import { withGateway, sendError, type GatewayContext } from '@/server/gateway';
import { validateSession } from '@/finio/sessionStore';
import { buildFinioExport, INVALID_SESSION } from '@/finio/exchange';
import { validateFocusRows } from '@/finio/focusValidation';

/**
 * The session id, from its dedicated header or the query param.
 *
 * `Authorization: Bearer` is deliberately NOT accepted: that header belongs to
 * the gateway's per-tenant credential, and overloading it with a second,
 * differently-scoped secret is how a request ends up authenticated as the wrong
 * principal.
 */
function sessionIdFrom(req: NextApiRequest): string | null {
  const header = req.headers['x-finio-session'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader;

  const { sessionId } = req.query;
  const fromQuery = Array.isArray(sessionId) ? sessionId[0] : sessionId;
  return typeof fromQuery === 'string' && fromQuery.length > 0 ? fromQuery : null;
}

async function exportFocus(
  req: NextApiRequest,
  res: NextApiResponse,
  _ctx: GatewayContext,
): Promise<void> {
  const sessionId = sessionIdFrom(req);
  const session = sessionId ? validateSession(sessionId) : null;

  if (!session || !session.ok) {
    // One message for every rejection reason: a peer learns that the session is
    // no good, not whether it was forged, malformed, or merely stale.
    sendError(res, INVALID_SESSION.status, INVALID_SESSION.code, INVALID_SESSION.message);
    return;
  }

  const payload = buildFinioExport(session.focusVersion);

  const check = validateFocusRows(payload.rows);
  if (!check.ok) {
    sendError(
      res,
      500,
      'invalid_focus_export',
      `Refusing to emit non-conformant FOCUS rows: ${check.errors.join('; ')}`,
    );
    return;
  }

  res.status(200).json(payload);
}

export default withGateway(exportFocus, { methods: ['GET'] });

// Live client — calls the versioned FinIO routes. Browser-safe: no credential
// is compiled into this file. It previously imported the shared A2A secret from
// FinioClient.ts, which put that secret in the client bundle.
//
// Header layering, because three credentials could otherwise collide on one
// `Authorization` header:
//   Authorization        — the gateway's per-tenant API key (src/server/gateway),
//                          omitted here exactly as LiveAIClient/LiveCMClient omit
//                          it; the gateway does not enforce it in the zero-config
//                          demo.
//   X-FinIO-Peer-Token   — the A2A shared secret identifying the peer agent.
//                          NEVER sent from here: a browser copy of it would be
//                          compiled into the client bundle (a NEXT_PUBLIC_
//                          variable is inlined at build time) and published to
//                          every visitor. Peer agents call the API directly
//                          with the header; a deployment that enforces
//                          FINIO_PEER_TOKEN makes the browser handshake fail
//                          with a typed FinioPeerAuthError instead.
//   X-FinIO-Session      — the sessionId minted by the handshake.
//
// Error handling mirrors the sibling live clients: a typed Error on transport
// failure and on non-2xx, never a raw fetch rejection. The non-2xx message is
// unwrapped from the gateway's {error:{code,message}} envelope so it reads
// identically to the message MockFinioClient throws for the same refusal; a
// body that is not the envelope is never quoted (src/lib/httpError.ts).

import type { FinioClient, FinioExport, HandshakeRequest, HandshakeResult } from './FinioClient';
import { withBasePath } from '@/lib/basePath';
import { describeHttpError, describeHttpErrorBody, readErrorBody } from '@/lib/httpError';

const HANDSHAKE_URL = withBasePath('/api/v1/a2a/handshake');
const EXPORT_URL = withBasePath('/api/v1/finio/export');

export const FINIO_PEER_AUTH_MESSAGE =
  'FinIO peer authentication required — use the API with X-FinIO-Peer-Token';

/**
 * Typed error for the handshake's peer-auth 401 (code `unauthorized_peer`):
 * this deployment enforces FINIO_PEER_TOKEN, which the browser never holds.
 * Mirrors LiveDataAuthError so the page can show actionable copy.
 */
export class FinioPeerAuthError extends Error {
  readonly status = 401;
  constructor() {
    super(FINIO_PEER_AUTH_MESSAGE);
    this.name = 'FinioPeerAuthError';
  }
}

/** The gateway envelope's error code, when the body is one. */
function errorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === 'string' ? parsed.error.code : null;
  } catch {
    return null;
  }
}


export class LiveFinioClient implements FinioClient {
  readonly mode = 'live' as const;

  async handshake(req: HandshakeRequest): Promise<HandshakeResult> {
    let res: Response;
    try {
      res = await fetch(HANDSHAKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
    } catch (err) {
      throw new Error(
        `FinIO handshake unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      // Never throws: an unreadable body is '' (code unknown → typed HTTP error).
      const body = await readErrorBody(res);
      if (res.status === 401 && errorCode(body) === 'unauthorized_peer') {
        throw new FinioPeerAuthError();
      }
      throw new Error(describeHttpErrorBody('FinIO handshake', res.status, body));
    }
    return (await res.json()) as HandshakeResult;
  }

  async export(sessionId: string): Promise<FinioExport> {
    let res: Response;
    try {
      res = await fetch(EXPORT_URL, {
        headers: { 'X-FinIO-Session': sessionId },
      });
    } catch (err) {
      throw new Error(
        `FinIO export unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new Error(await describeHttpError('FinIO export', res));
    }
    return (await res.json()) as FinioExport;
  }
}

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
//   X-FinIO-Session      — the sessionId minted by the handshake.
//
// Error handling mirrors the sibling live clients: a typed Error on transport
// failure and on non-2xx, never a raw fetch rejection. The non-2xx message is
// unwrapped from the gateway's {error:{code,message}} envelope so it reads
// identically to the message MockFinioClient throws for the same refusal.

import type { FinioClient, FinioExport, HandshakeRequest, HandshakeResult } from './FinioClient';

const HANDSHAKE_URL = '/api/v1/a2a/handshake';
const EXPORT_URL = '/api/v1/finio/export';

/**
 * Optional peer token for deployments that enforce one. This is a routing
 * credential the operator chooses to expose to the browser, not a server secret:
 * FINIO_PEER_TOKEN (unprefixed) stays server-side and is never read here.
 */
function peerTokenHeader(): Record<string, string> {
  const token = process.env.NEXT_PUBLIC_FINIO_PEER_TOKEN;
  return token ? { 'X-FinIO-Peer-Token': token } : {};
}

/** Pull the human-readable message out of the gateway's error envelope. */
async function describeFailure(res: Response): Promise<string> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return body;
}

export class LiveFinioClient implements FinioClient {
  readonly mode = 'live' as const;

  async handshake(req: HandshakeRequest): Promise<HandshakeResult> {
    let res: Response;
    try {
      res = await fetch(HANDSHAKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...peerTokenHeader() },
        body: JSON.stringify(req),
      });
    } catch (err) {
      throw new Error(
        `FinIO handshake unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new Error(`FinIO handshake error ${res.status}: ${await describeFailure(res)}`);
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
      throw new Error(`FinIO export error ${res.status}: ${await describeFailure(res)}`);
    }
    return (await res.json()) as FinioExport;
  }
}

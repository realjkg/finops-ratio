// PointFive OAuth 2.1 client scaffolding (PR E).
//
// PointFive's MCP Server authenticates via OAuth 2.1 (art_gvr7b5Ne §2). This is
// the token-acquisition seam the live MCP transport uses. It is SCAFFOLDING:
// no real PointFive credentials exist yet, so it is never invoked in the default
// (dark) build, and tests inject a fake `fetch` so no real network call is made.
//
// The `httpFetch` dependency is injectable for exactly that reason — the class
// never reaches for a global directly, which keeps it pure-by-construction and
// trivially mockable.

import type { PointFiveCredentials } from './pointfiveConfig';
import { logUpstreamError, readJsonBody, statusReason } from './transports/focusExport';
import { redactErrorText } from './transports/redact';

const LABEL = 'PointFive OAuth token endpoint';

/** Minimal OAuth 2.1 token response (RFC 6749 §5.1 subset). */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/** The fetch surface the OAuth client needs — matches the global `fetch`. */
export type HttpFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

// Refresh slightly before true expiry to avoid using a token that lapses mid-call.
const EXPIRY_SKEW_MS = 30_000;

/**
 * OAuth 2.1 client-credentials token source for the PointFive MCP connection.
 *
 * Caches the access token until shortly before expiry. Throws a typed Error on
 * transport failure or a non-2xx token response so the adapter surfaces a clear
 * message instead of a raw rejection — it never swallows the failure.
 */
export class PointFiveOAuthClient {
  private cached: CachedToken | null = null;

  constructor(
    private readonly credentials: PointFiveCredentials,
    private readonly httpFetch: HttpFetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns a valid bearer token, reusing the cached one until near expiry. */
  async getAccessToken(): Promise<string> {
    const nowMs = this.now();
    if (this.cached && this.cached.expiresAtMs - EXPIRY_SKEW_MS > nowMs) {
      return this.cached.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.credentials.oauthClientId,
      client_secret: this.credentials.oauthClientSecret,
    }).toString();

    let res: Awaited<ReturnType<HttpFetch>>;
    try {
      res = await this.httpFetch(this.credentials.oauthTokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (err) {
      throw new Error(`PointFive OAuth token request failed: ${redactErrorText(err)}`);
    }

    if (!res.ok) {
      // Status + fixed reason only; the body (may echo client credentials) is
      // logged server-side, redacted — never thrown to an API caller.
      const text = await res.text().catch(() => '');
      if (text) logUpstreamError(LABEL, res.status, text);
      throw new Error(`${LABEL} returned ${res.status} (${statusReason(res.status)})`);
    }

    const token = await readJsonBody<OAuthTokenResponse>(res, LABEL);
    this.cached = {
      accessToken: token.access_token,
      expiresAtMs: nowMs + token.expires_in * 1000,
    };
    return token.access_token;
  }
}


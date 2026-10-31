// R2 B: OIDC sign-in (engagement mode only; 404 otherwise) with openid-client
// (pinned 6.8.8): Authorization Code + PKCE (S256), state and nonce, the exact
// callback `${RATIO_ENGAGEMENT_ORIGIN}/api/auth/oidc/callback`. The library
// validates the ID token (signature via JWKS, iss, aud, exp, nonce); every IdP
// request goes through guardedFetch (server-side, SSRF-checked, pinned).
//   GET /api/auth/oidc/start?connection=<id>  stores a single-use transaction
//       (state, nonce, PKCE verifier) server-side, bound to the browser by a
//       __Host- cookie (SameSite=Lax: the IdP returns by a cross-site top-level
//       GET, which Strict would strip), and redirects to the IdP.
//   GET /api/auth/oidc/callback  consumes the transaction (replay fails), runs
//       the code grant, and maps (connection, iss, sub) through an explicit
//       binding only (resolveExternalIdentity). A bound, active member gets the
//       same server session as local sign-in; anything else is the uniform
//       not_provisioned (403) with no session. Email never links anyone.
// The client secret is read from the env var named by clientSecretRef and is
// never logged; IdP tokens never reach the browser. SERVER-ONLY.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import * as oidc from 'openid-client';
import { engagementConfigFromEnv, engagementMode } from '@/engagement/config';
import { sendError } from '@/server/gateway/withGateway';
import { runAuditHook } from './authz';
import { directoryFromEnv, type Connection, type Directory, type Instance } from './directory';
import { authSettings, sessionCookie, sessionToken } from './http';
import { resolveExternalIdentity } from './identity';
import type { AuthAuditEvent } from './routes';
import { guardedFetch } from './safeFetch';
import { sessionStore, SessionStoreError, type EngagementSessionStore } from './session';

type Env = Record<string, string | undefined>;
export const OIDC_TX_COOKIE = '__Host-ratio_oidc';
const TX_TTL_MS = 10 * 60_000;
const CONFIG_TTL_MS = 10 * 60_000;
const txCookie = (v: string, maxAge: number) => `${OIDC_TX_COOKIE}=${v}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const NOT_PROVISIONED = 'This account is not provisioned for this engagement';
const FAILED = 'Sign-in failed. Start again.';

/** Single-use sign-in transactions; only the hash of the browser's transaction token is stored. */
export class OidcTransactionStore {
  private db!: DatabaseSync;
  constructor(filename: string) {
    try {
      this.db = new DatabaseSync(filename);
      this.db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS oidc_transactions (hash TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL, state TEXT NOT NULL, nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL);`);
    } catch { throw new SessionStoreError(); }
  }
  create(connectionId: string, now: number) {
    const t = { token: randomBytes(32).toString('hex'), state: oidc.randomState(), nonce: oidc.randomNonce(), verifier: oidc.randomPKCECodeVerifier() };
    try {
      this.db.prepare('DELETE FROM oidc_transactions WHERE expires<=?').run(now);
      this.db.prepare('INSERT INTO oidc_transactions VALUES (?,?,?,?,?,?)').run(sha256(t.token), connectionId, t.state, t.nonce, t.verifier, now + TX_TTL_MS);
    } catch { throw new SessionStoreError(); }
    return t;
  }
  /** The transaction of this token, deleted in the same statement (single use), or null. */
  consume(token: string, now: number): { connectionId: string; state: string; nonce: string; verifier: string } | null {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    let row: Record<string, unknown> | undefined;
    try { row = this.db.prepare('DELETE FROM oidc_transactions WHERE hash=? RETURNING *').get(sha256(token)) as Record<string, unknown> | undefined; } catch { throw new SessionStoreError(); }
    return row && Number(row.expires) > now ? { connectionId: String(row.connection_id), state: String(row.state), nonce: String(row.nonce), verifier: String(row.verifier) } : null;
  }
}
const txStores = new Map<string, OidcTransactionStore>();

export interface OidcRouteDeps {
  env?: Env; now?: () => number; store?: (file: string) => EngagementSessionStore; transactions?: (file: string) => OidcTransactionStore;
  fetch?: oidc.CustomFetch; audit?: (e: AuthAuditEvent) => void | Promise<void>; configCache?: Map<string, { at: number; config: oidc.Configuration }>;
}
interface Ctx { origin: string; instance: Instance; directory: Directory; env: Env; now: number; sessions: EngagementSessionStore; txs: OidcTransactionStore; audit(status: number, id?: string): void }
const sharedConfigs = new Map<string, { at: number; config: oidc.Configuration }>();

function route(action: 'oidc_start' | 'oidc_callback', deps: OidcRouteDeps, body: (req: NextApiRequest, res: NextApiResponse, ctx: Ctx) => Promise<void>): NextApiHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const env = deps.env ?? process.env;
    try { if (!engagementMode(env)) return sendError(res, 404, 'not_found', 'Not found'); } catch { return sendError(res, 503, 'not_configured', 'Sign-in is not configured on this server'); }
    const settings = authSettings(env);
    const cfg = engagementConfigFromEnv(env);
    const instance = cfg.ok ? { tenantId: cfg.config.tenantId, engagementId: cfg.config.engagementId } : null;
    const dir = instance ? directoryFromEnv(env, instance) : null;
    if (!settings || !instance || !dir?.ok || !/^[0-5]$/.test(env.RATIO_TRUSTED_PROXY_HOPS ?? '')) return sendError(res, 503, 'not_configured', 'Sign-in is not configured on this server');
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return sendError(res, 405, 'method_not_allowed', 'Method not allowed'); }
    const sink = deps.audit ?? ((e: AuthAuditEvent) => console.info(JSON.stringify(e)));
    try {
      const sessions = (deps.store ?? sessionStore)(settings.stateFile);
      const txs = deps.transactions ? deps.transactions(settings.stateFile) : txStores.get(settings.stateFile) ?? txStores.set(settings.stateFile, new OidcTransactionStore(settings.stateFile)).get(settings.stateFile)!;
      await body(req, res, { origin: settings.origin, instance, directory: dir.directory, env, now: (deps.now ?? Date.now)(), sessions, txs,
        audit: (status, id) => runAuditHook(sink, { event: 'auth', action, outcome: status < 400 ? 'success' : 'denied', status, principalKind: id ? 'user' : 'none', principalId: id ?? null, ...instance }) });
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof SessionStoreError) return sendError(res, 503, 'session_store_unavailable', 'Sign-in is temporarily unavailable');
      console.error('{"event":"oidc_route_failed"}');
      sendError(res, 500, 'internal_error', 'Internal error');
    }
  };
}

/** The discovered client configuration of an enabled connection (cached 10 min); every IdP request uses the guarded fetch. */
async function configFor(conn: Connection, secret: string, deps: OidcRouteDeps, now: number): Promise<oidc.Configuration> {
  const cache = deps.configCache ?? sharedConfigs;
  const key = JSON.stringify([conn.id, conn.issuer, conn.clientId, sha256(secret)]);
  const hit = cache.get(key);
  if (hit && now - hit.at < CONFIG_TTL_MS) return hit.config;
  const fetch = deps.fetch ?? (guardedFetch() as unknown as oidc.CustomFetch);
  const config = await oidc.discovery(new URL(conn.issuer), conn.clientId, undefined, oidc.ClientSecretPost(secret), { [oidc.customFetch]: fetch, timeout: 10 });
  config[oidc.customFetch] = fetch;
  // Verify the ID token signature against the IdP's JWKS too (the library otherwise relies on TLS for the direct token response).
  oidc.enableNonRepudiationChecks(config);
  cache.set(key, { at: now, config });
  return config;
}
const callbackUrl = (origin: string) => `${origin}/api/auth/oidc/callback`;

export function createOidcStartRoute(deps: OidcRouteDeps = {}): NextApiHandler {
  return route('oidc_start', deps, async (req, res, ctx) => {
    const q = req.query ?? {};
    const conn = Object.keys(q).length === 1 && typeof q.connection === 'string' ? ctx.directory.connections.get(q.connection) : undefined;
    if (!conn || !conn.enabled) { sendError(res, 400, 'invalid_request', 'Unknown sign-in connection'); return ctx.audit(400); }
    const secret = ctx.env[conn.clientSecretRef];
    if (!secret) { sendError(res, 503, 'not_configured', 'Sign-in is not configured on this server'); return ctx.audit(503); }
    let config: oidc.Configuration;
    try { config = await configFor(conn, secret, deps, ctx.now); } catch { sendError(res, 503, 'idp_unavailable', 'The identity provider is unavailable'); return ctx.audit(503); }
    const t = ctx.txs.create(conn.id, ctx.now);
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: callbackUrl(ctx.origin), scope: 'openid', state: t.state, nonce: t.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(t.verifier), code_challenge_method: 'S256',
    });
    res.setHeader('Set-Cookie', txCookie(t.token, TX_TTL_MS / 1000));
    res.setHeader('Location', url.href);
    res.status(302).end();
    ctx.audit(302);
  });
}

export function createOidcCallbackRoute(deps: OidcRouteDeps = {}): NextApiHandler {
  return route('oidc_callback', deps, async (req, res, ctx) => {
    const cleared = txCookie('', 0);
    const fail = (status: number, code: string, message: string) => { res.setHeader('Set-Cookie', cleared); sendError(res, status, code, message); ctx.audit(status); };
    const tx = ctx.txs.consume(req.cookies?.[OIDC_TX_COOKIE] ?? '', ctx.now);
    const conn = tx ? ctx.directory.connections.get(tx.connectionId) : undefined;
    if (!tx || !conn || !conn.enabled) return fail(401, 'unauthorized', FAILED);
    const secret = ctx.env[conn.clientSecretRef];
    if (!secret) return fail(503, 'not_configured', 'Sign-in is not configured on this server');
    let claims: oidc.IDToken | undefined;
    try {
      const config = await configFor(conn, secret, deps, ctx.now);
      const current = new URL(callbackUrl(ctx.origin));
      current.search = new URL(req.url ?? '', ctx.origin).search;
      claims = (await oidc.authorizationCodeGrant(config, current, { pkceCodeVerifier: tx.verifier, expectedState: tx.state, expectedNonce: tx.nonce, idTokenExpected: true })).claims();
    } catch {
      return fail(401, 'unauthorized', FAILED);
    }
    if (!claims || typeof claims.sub !== 'string' || claims.iss !== conn.issuer) return fail(401, 'unauthorized', FAILED);
    const r = resolveExternalIdentity(ctx.directory, { connectionId: conn.id, issuer: claims.iss, subject: claims.sub });
    if (r.kind !== 'bound' || ctx.directory.memberships.get(r.userId)?.status !== 'active') return fail(403, 'not_provisioned', NOT_PROVISIONED);
    ctx.sessions.revoke(sessionToken(req)); // never keep a presented session (fixation)
    const { token } = ctx.sessions.create({ userId: r.userId, ...ctx.instance }, ctx.now);
    res.setHeader('Set-Cookie', [sessionCookie(token), cleared]);
    res.setHeader('Location', '/');
    res.status(303).end();
    ctx.audit(200, r.userId);
  });
}

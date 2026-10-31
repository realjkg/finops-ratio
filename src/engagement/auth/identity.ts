// R2: IdP-agnostic identity. An identity provider adapter (OIDC first; a SAML
// broker or another bridge later) validates a completed sign-in and yields an
// ExternalIdentity: the connection id, the VALIDATED issuer and subject. That
// triple is the only external identity key; email and display name never
// identify or link anyone. It maps to an internal user only through an explicit
// binding in the directory; anything else is 'not_provisioned' (one result for
// every cause: no user enumeration). Local scrypt credentials remain the
// bootstrap and recovery path for operators and tests. SERVER-ONLY.
import type { Directory } from './directory';
import { dummyHash, verifyPassword } from './password';

export interface ExternalIdentity {
  connectionId: string;
  /** The issuer validated by the adapter (for OIDC: the ID token iss after signature, audience, expiry and nonce checks). */
  issuer: string;
  subject: string;
  /** Validated provider claims kept for audit or a provider-specific rule (Entra: tid, oid). Never an identity key. */
  claims?: Readonly<Record<string, string>>;
}

/** The contract every adapter implements; PR B adds the OIDC one (Authorization Code + PKCE). */
export interface IdentityProvider {
  readonly connectionId: string;
  /** Validates a completed sign-in (for OIDC: the callback with state, code and the stored PKCE verifier and nonce). */
  complete(input: unknown, ctx: { now: number }): Promise<ExternalIdentity | null>;
}

export type Resolution = { kind: 'bound'; userId: string } | { kind: 'not_provisioned' };

export function resolveExternalIdentity(dir: Directory, ext: ExternalIdentity): Resolution {
  const conn = dir.connections.get(ext.connectionId);
  if (!conn || !conn.enabled || conn.issuer !== ext.issuer) return { kind: 'not_provisioned' };
  const userId = dir.bindingOf(conn.id, ext.issuer, ext.subject);
  const user = userId ? dir.users.get(userId.toLowerCase()) : undefined;
  return user && user.status === 'active' ? { kind: 'bound', userId: user.id } : { kind: 'not_provisioned' };
}

/** Local sign-in: the user id of an active user whose local credential matches, else null. Same scrypt work either way. */
export async function authenticateLocal(dir: Directory, username: string, password: string): Promise<string | null> {
  const user = typeof username === 'string' ? dir.users.get(username.toLowerCase()) : undefined;
  const hash = user && user.status === 'active' ? dir.credentials.get(user.id) : undefined;
  const ok = await verifyPassword(password, hash ?? dummyHash());
  return ok && hash && user ? user.id : null;
}

// Self-validating session tokens for the FinIO A2A exchange. SERVER-SIDE ONLY.
//
// A server-side Map would break the moment the app runs on more than one
// instance (or across Next.js route contexts), so the sessionId carries its own
// state and is verified by signature instead of by lookup.
//
// Format: "<expiresAtMs>-<focusVersion>-<hmac>"
//
// The delimiter is '-', not '.', because the FOCUS version is itself dotted
// ("1.4") and a dot-delimited token splits into four fields, not three — every
// session would read as malformed. None of the three fields can contain a
// hyphen: the expiry is digits, the version is digits and dots, the signature is
// hex.
//
// The negotiated FOCUS version is part of the signed payload, not just the
// handshake response. Without that, the export route had no way to know what
// version the peer agreed to and always emitted its own default — the handshake
// negotiated a version that the export then ignored. Binding it to the token
// also means a peer cannot re-point an issued session at a different version.

import { createHmac } from 'crypto';
import { FOCUS_VERSIONS, type FocusVersion } from '@/costsource/focusVersions';
import { secretsMatch, sessionSecret, type FinioEnv } from './config';

const SESSION_TTL_MS = 5 * 60_000; // 5 minutes

function sign(payload: string, env?: FinioEnv): string {
  return createHmac('sha256', sessionSecret(env)).update(payload).digest('hex').slice(0, 32);
}

export interface FinioSession {
  sessionId: string;
  expiresAt: string; // ISO 8601
  focusVersion: FocusVersion;
}

/** Field separator — see the format note above; must not occur inside a field. */
const SEP = '-';

/** Mint a session bound to the negotiated FOCUS version. */
export function createSession(focusVersion: FocusVersion, env?: FinioEnv): FinioSession {
  const expiresAtMs = Date.now() + SESSION_TTL_MS;
  const payload = `${expiresAtMs}${SEP}${focusVersion}`;
  return {
    sessionId: `${payload}${SEP}${sign(payload, env)}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
    focusVersion,
  };
}

export type SessionCheck =
  | { ok: true; focusVersion: FocusVersion }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/**
 * Verify a sessionId's signature and expiry, recovering the version it was
 * issued for. No shared state required — the token is self-contained.
 */
export function validateSession(sessionId: string, env?: FinioEnv): SessionCheck {
  const parts = sessionId.split(SEP);
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  const [expiresRaw, versionRaw, signature] = parts;
  if (!FOCUS_VERSIONS.includes(versionRaw as FocusVersion)) {
    return { ok: false, reason: 'malformed' };
  }
  if (!/^\d+$/.test(expiresRaw)) return { ok: false, reason: 'malformed' };
  const expiresAtMs = Number.parseInt(expiresRaw, 10);
  if (!Number.isFinite(expiresAtMs)) return { ok: false, reason: 'malformed' };

  // Signature before expiry: an attacker learns nothing about our clock from an
  // unsigned token, and the comparison is constant-time.
  const expected = sign(`${expiresRaw}${SEP}${versionRaw}`, env);
  if (signature.length !== expected.length || !secretsMatch(signature, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (Date.now() > expiresAtMs) return { ok: false, reason: 'expired' };

  return { ok: true, focusVersion: versionRaw as FocusVersion };
}

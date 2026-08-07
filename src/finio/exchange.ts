// The FinIO exchange rules, as pure functions.
//
// Both transports run this module. Previously MockFinioClient accepted anything
// — it never negotiated a version, never checked a session, and returned a
// sessionId of `mock-<nonce>` that nothing validated. That made the mock a
// strictly more permissive peer than the live route, so the seam's central claim
// (mock and live differ only in transport) was false on every error path, and
// the demo could not show a 409 or a 401 at all without a server.
//
// Browser-safe by construction: no `crypto`, no `process`, no Node imports. The
// server layers signed sessions on top (sessionStore.ts); the mock layers an
// in-memory map. The decisions themselves live here, once.

import { FOCUS_VERSIONS, CANONICAL_FOCUS_VERSION, type FocusVersion } from '@/costsource/focusVersions';
import { FINIO_OPERATIONS, type FinioExport, type HandshakeRequest } from './FinioClient';
import { finioRowsForVersion } from './finioRows';

/** A refusal, in the shape both transports report it. */
export interface FinioFailure {
  status: number;
  code: string;
  message: string;
}

/** The error text a caller sees, identical in mock and live mode. */
export function failureMessage(operation: 'handshake' | 'export', failure: FinioFailure): string {
  return `FinIO ${operation} error ${failure.status}: ${failure.message}`;
}

/** Versions this responder can shape rows to — the full canonical range. */
export const SUPPORTED_FOCUS_VERSIONS: readonly FocusVersion[] = FOCUS_VERSIONS;

export type Negotiation =
  | { ok: true; version: FocusVersion }
  | { ok: false; failure: FinioFailure };

/**
 * Agree a FOCUS version with the initiator.
 *
 * The responder honours any version in the canonical v1.0-v1.4 range rather than
 * the single pinned '1.1' the original draft allowed. Pinning would have refused
 * peers speaking the version this repo itself calls canonical (v1.4).
 * Out-of-range requests get a 409 naming both sides, per the spec.
 */
export function negotiateFocusVersion(requested: unknown): Negotiation {
  if (typeof requested !== 'string' || !SUPPORTED_FOCUS_VERSIONS.includes(requested as FocusVersion)) {
    return {
      ok: false,
      failure: {
        status: 409,
        code: 'focus_version_mismatch',
        message:
          `focusVersion mismatch: requested '${String(requested)}', ` +
          `responder supports '${SUPPORTED_FOCUS_VERSIONS.join(', ')}'`,
      },
    };
  }
  return { ok: true, version: requested as FocusVersion };
}

export type HandshakeParse =
  | { ok: true; request: HandshakeRequest }
  | { ok: false; failure: FinioFailure };

/** Validate an inbound handshake body before any version negotiation. */
export function parseHandshakeRequest(body: unknown): HandshakeParse {
  const invalid = (message: string): HandshakeParse => ({
    ok: false,
    failure: { status: 400, code: 'invalid_request', message },
  });

  if (typeof body !== 'object' || body === null) {
    return invalid('Handshake body must be a JSON object');
  }
  const { agentId, capabilities, focusVersion, nonce } = body as Record<string, unknown>;

  if (typeof agentId !== 'string' || agentId.length === 0) {
    return invalid('agentId is required');
  }
  if (typeof nonce !== 'string' || nonce.length === 0) {
    return invalid('nonce is required');
  }
  if (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== 'string')) {
    return invalid('capabilities must be an array of strings');
  }
  if (typeof focusVersion !== 'string') {
    return invalid('focusVersion is required');
  }

  return {
    ok: true,
    request: {
      agentId,
      capabilities: capabilities as string[],
      focusVersion: focusVersion as FocusVersion,
      nonce,
    },
  };
}

/** Operations this responder will honour — intersected with what the peer asked for. */
export function acceptedOperations(requested: string[]): typeof FINIO_OPERATIONS[number][] {
  return FINIO_OPERATIONS.filter((op) => requested.includes(op));
}

/** Build the export payload at the negotiated version. */
export function buildFinioExport(
  version: FocusVersion = CANONICAL_FOCUS_VERSION,
): FinioExport {
  return {
    focusVersion: version,
    generatedAt: new Date().toISOString(),
    rows: finioRowsForVersion(version),
  };
}

/** The 401 both transports return for a session that does not check out. */
export const INVALID_SESSION: FinioFailure = {
  status: 401,
  code: 'invalid_session',
  message: 'Invalid or expired sessionId',
};

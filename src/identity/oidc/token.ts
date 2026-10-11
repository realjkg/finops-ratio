// Compact JWS parsing (checklist 1.1). Trust boundary: the raw bearer string.
// Nothing here touches a key or the network, and the payload is decoded to
// bytes (canonical base64url only) but NOT parsed as JSON until the signature
// has verified.
//
// Order: type and size, three non-empty base64url segments, canonical
// encoding of all three, strict UTF-8 JSON header, then the header rules:
//   1. header-injection members (jku, x5u, x5c, jwk, crit) are refused outright;
//   2. any other member outside alg, typ, kid, x5t, x5t#S256 is refused;
//   3. alg must be an exact member of the configured allowlist (so `none`,
//      HS256 and every case variant are refused before any key is touched);
//   4. typ, when present, must be JWT or at+jwt;
//   5. kid is required, a bounded printable string.
// x5t and x5t#S256 are tolerated hints and never used for key selection.

import { OidcError } from './errors';
import { KID_RE, isOidcAlg, isPlainObject, type OidcAlg } from './shared';

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const MAX_HEADER_SEGMENT = 2048;
const MAX_SIGNATURE_SEGMENT = 1400; // an 8192-bit RSA signature is 1366 characters
const INJECTION_MEMBERS: readonly string[] = ['jku', 'x5u', 'x5c', 'jwk', 'crit'];
const HEADER_MEMBERS: ReadonlySet<string> = new Set(['alg', 'typ', 'kid', 'x5t', 'x5t#S256']);
const TYPES: readonly string[] = ['JWT', 'at+jwt'];
const MAX_THUMBPRINT = 128;

export interface ParsedToken {
  readonly alg: OidcAlg;
  readonly kid: string;
  /** `header.payload` exactly as received; this is what the signature covers. */
  readonly signingInput: Buffer;
  readonly payloadBytes: Buffer;
  readonly signature: Buffer;
}

/** Canonical, unpadded base64url to bytes; throws OidcError('malformed') otherwise. */
function decodeCanonical(segment: string): Buffer {
  if (!SEGMENT_RE.test(segment)) throw new OidcError('malformed');
  const bytes = Buffer.from(segment, 'base64url');
  // Exactly one accepted spelling per byte string (no padding, no stray bits).
  if (bytes.toString('base64url') !== segment) throw new OidcError('malformed');
  return bytes;
}

/** Strict UTF-8 (invalid sequences and a byte-order mark are errors) to a JSON value; throws the given code. */
export function parseJsonBytes(bytes: Buffer, code: 'malformed' | 'invalid_claims'): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new OidcError(code);
  }
}

function checkHeader(value: unknown, allowed: ReadonlySet<OidcAlg>): { alg: OidcAlg; kid: string } {
  if (!isPlainObject(value)) throw new OidcError('malformed');
  const header = value;
  for (const key of Object.keys(header)) if (INJECTION_MEMBERS.includes(key)) throw new OidcError('forbidden_header');
  for (const key of Object.keys(header)) if (!HEADER_MEMBERS.has(key)) throw new OidcError('malformed');

  if (typeof header.alg !== 'string') throw new OidcError('malformed');
  if (!isOidcAlg(header.alg) || !allowed.has(header.alg)) throw new OidcError('unsupported_alg');
  if (Object.hasOwn(header, 'typ') && !(typeof header.typ === 'string' && TYPES.includes(header.typ))) throw new OidcError('malformed');
  for (const hint of ['x5t', 'x5t#S256']) {
    if (Object.hasOwn(header, hint) && !(typeof header[hint] === 'string' && (header[hint] as string).length <= MAX_THUMBPRINT)) {
      throw new OidcError('malformed');
    }
  }
  if (typeof header.kid !== 'string' || !KID_RE.test(header.kid)) throw new OidcError('malformed');
  return { alg: header.alg, kid: header.kid };
}

/** Parse the compact serialization up to, and including, the header rules. Throws OidcError. */
export function parseCompact(token: unknown, maxLength: number, allowed: ReadonlySet<OidcAlg>): ParsedToken {
  if (typeof token !== 'string' || token.length === 0) throw new OidcError('malformed');
  if (token.length > maxLength) throw new OidcError('token_too_large');
  const segments = token.split('.');
  if (segments.length !== 3) throw new OidcError('malformed');
  const [headerSeg, payloadSeg, signatureSeg] = segments;
  if (headerSeg.length > MAX_HEADER_SEGMENT || signatureSeg.length > MAX_SIGNATURE_SEGMENT) throw new OidcError('malformed');

  const headerBytes = decodeCanonical(headerSeg);
  const payloadBytes = decodeCanonical(payloadSeg);
  const signature = decodeCanonical(signatureSeg);
  const { alg, kid } = checkHeader(parseJsonBytes(headerBytes, 'malformed'), allowed);
  return { alg, kid, signingInput: Buffer.from(`${headerSeg}.${payloadSeg}`, 'utf8'), payloadBytes, signature };
}

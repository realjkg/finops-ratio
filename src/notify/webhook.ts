// Signed generic webhook channel, plus the verifier a receiver can use.
//
// Wire format (version "v1"):
//   POST <tenant webhook URL>
//   Content-Type:          application/json
//   X-Ratio-Timestamp:     <unix seconds, decimal>
//   X-Ratio-Signature:     v1=<lower-case hex of HMAC-SHA256(secret, "<timestamp>.<body>")>
//   X-Ratio-Delivery-Id:   <hex id, stable across retries of the same alert>
// The signature covers the timestamp AND the exact body bytes, so neither can
// be altered or replayed under a new timestamp. The delivery id header repeats
// the `id` field inside the signed body (derived from tenant, dedupe key and
// severity); a receiver that needs replay protection INSIDE the time window
// should remember the body's `id` values it has already accepted.
//
// TRUST BOUNDARY (sender): the signing secret is resolved from a handle on every
// attempt and never leaves this module except as the HMAC. (receiver): headers
// and body are attacker-controlled; verifyWebhookSignature checks formats and
// the replay window first, compares in constant time, and returns a FIXED code.
//
// Uses node:crypto, so this module is server-only.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AlertEvent } from './alertEvent';
import { postGuarded, type HttpChannelDeps } from './httpDelivery';
import { resolveSecret } from './secrets';
import type { AlertChannel, ChannelResult, Clock, SendContext } from './types';

export const WEBHOOK_TIMESTAMP_HEADER = 'X-Ratio-Timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'X-Ratio-Signature';
export const WEBHOOK_DELIVERY_HEADER = 'X-Ratio-Delivery-Id';
export const SIGNATURE_VERSION = 'v1';

/** Replay window the verifier applies by default, in seconds. */
export const DEFAULT_TOLERANCE_SEC = 300;
export const MAX_TOLERANCE_SEC = 3600;
/** A receiver refuses bodies larger than this before hashing them. */
export const MAX_VERIFY_BODY_BYTES = 1024 * 1024;
/** Accepted secrets / signatures per verification (key rotation). */
export const MAX_VERIFY_SECRETS = 4;

/** HMAC-SHA256 as lower-case hex. Exported for known-answer tests. */
export function hmacSha256Hex(secret: string, data: Uint8Array | string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Constant-time equality of two byte arrays. Different lengths return false
 * immediately (lengths are public); equal lengths are compared with
 * crypto.timingSafeEqual, which does not exit early on a differing byte.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function toBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

function signedBytes(timestamp: string, body: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]);
}

export interface WebhookSignature {
  readonly timestamp: string;
  readonly signature: string;
}

/** Sign `body` at `timestampSec` (whole unix seconds). */
export function signWebhook(secret: string, timestampSec: number, body: string): WebhookSignature {
  const timestamp = String(Math.floor(timestampSec));
  const mac = hmacSha256Hex(secret, signedBytes(timestamp, toBytes(body)));
  return { timestamp, signature: `${SIGNATURE_VERSION}=${mac}` };
}

export type VerifyCode =
  | 'config_invalid'
  | 'body_too_large'
  | 'missing_timestamp'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'future_timestamp'
  | 'missing_signature'
  | 'bad_signature_format'
  | 'signature_mismatch';

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly code: VerifyCode };

export interface VerifyInput {
  /** One secret, or up to four while a secret is being rotated. */
  readonly secrets: string | readonly string[];
  /** Value of the X-Ratio-Timestamp header. */
  readonly timestamp: string | undefined;
  /** Value of the X-Ratio-Signature header (one or more `v1=<hex>` values separated by commas or spaces). */
  readonly signature: string | undefined;
  /** The raw request body, byte for byte as received. */
  readonly body: string | Uint8Array;
  /** Current unix seconds, from the receiver's clock. */
  readonly nowSec: number;
  /** Accepted clock distance in seconds (default 300, at most 3600). */
  readonly toleranceSec?: number;
}

const TIMESTAMP_RE = /^(0|[1-9]\d{0,11})$/;
const SIGNATURE_TOKEN_RE = /^v1=([0-9a-fA-F]{64})$/;

/**
 * Verify a delivery. Order: configuration, size, timestamp format, replay
 * window, signature format, then a constant-time comparison against every
 * candidate (no early exit, so the number of secrets or signatures tried does
 * not depend on which one matches). Fixed codes only.
 */
export function verifyWebhookSignature(input: VerifyInput): VerifyResult {
  const secrets = typeof input.secrets === 'string' ? [input.secrets] : [...input.secrets];
  const tolerance = input.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (
    secrets.length === 0 ||
    secrets.length > MAX_VERIFY_SECRETS ||
    secrets.some((s) => typeof s !== 'string' || s.length === 0) ||
    !Number.isFinite(input.nowSec) ||
    !Number.isFinite(tolerance) ||
    tolerance <= 0 ||
    tolerance > MAX_TOLERANCE_SEC
  ) {
    return { ok: false, code: 'config_invalid' };
  }

  const body = toBytes(input.body);
  if (body.length > MAX_VERIFY_BODY_BYTES) return { ok: false, code: 'body_too_large' };

  if (input.timestamp === undefined || input.timestamp === '') return { ok: false, code: 'missing_timestamp' };
  if (!TIMESTAMP_RE.test(input.timestamp)) return { ok: false, code: 'bad_timestamp' };
  const ts = Number(input.timestamp);
  const skew = input.nowSec - ts;
  if (skew > tolerance) return { ok: false, code: 'stale_timestamp' };
  if (-skew > tolerance) return { ok: false, code: 'future_timestamp' };

  if (input.signature === undefined || input.signature === '') return { ok: false, code: 'missing_signature' };
  const tokens = input.signature.trim().split(/[\s,]+/).filter((t) => t.length > 0);
  if (tokens.length === 0 || tokens.length > MAX_VERIFY_SECRETS) return { ok: false, code: 'bad_signature_format' };
  const candidates: Buffer[] = [];
  for (const token of tokens) {
    const m = SIGNATURE_TOKEN_RE.exec(token);
    if (!m) return { ok: false, code: 'bad_signature_format' };
    candidates.push(Buffer.from(m[1], 'hex'));
  }

  const message = signedBytes(input.timestamp, body);
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(message).digest();
    for (const candidate of candidates) {
      if (constantTimeEqual(expected, candidate)) matched = true;
    }
  }
  return matched ? { ok: true } : { ok: false, code: 'signature_mismatch' };
}

/** Stable per-alert id: the same alert retried carries the same id. */
export function deliveryId(tenant: string, dedupeKey: string, severity: string): string {
  return createHash('sha256').update(`${tenant}\u0000${dedupeKey}\u0000${severity}`).digest('hex').slice(0, 32);
}

/** JSON body sent to the receiver. Strings are already sanitized by parseAlertEvent. */
export function buildWebhookBody(event: AlertEvent): string {
  return JSON.stringify({
    version: 1,
    id: deliveryId(event.tenant, event.dedupeKey, event.severity),
    tenant: event.tenant,
    dedupeKey: event.dedupeKey,
    severity: event.severity,
    title: event.title,
    body: event.body,
    occurredAt: event.occurredAt,
    resources: event.resources,
    links: event.links,
  });
}

export interface WebhookChannelConfig {
  readonly id: string;
  /** Handle of the destination URL. */
  readonly urlHandle: string;
  /** Handle of the HMAC signing secret. */
  readonly secretHandle: string;
}

export function createWebhookChannel(
  cfg: WebhookChannelConfig,
  deps: HttpChannelDeps & { readonly clock: Clock },
): AlertChannel {
  return {
    kind: 'webhook',
    id: cfg.id,
    async send(event: AlertEvent, ctx: SendContext): Promise<ChannelResult> {
      if (event.tenant !== ctx.tenant) return { ok: false, code: 'internal_error', retryable: false };
      const url = await resolveSecret(deps.secrets, ctx.tenant, cfg.urlHandle, 'url');
      if (!url.ok) return { ok: false, code: url.code, retryable: url.code === 'secret_unavailable' };
      const key = await resolveSecret(deps.secrets, ctx.tenant, cfg.secretHandle, 'signing');
      if (!key.ok) return { ok: false, code: key.code, retryable: key.code === 'secret_unavailable' };

      const body = buildWebhookBody(event);
      const sig = signWebhook(key.value, deps.clock.now() / 1000, body);
      return postGuarded(
        url.value,
        body,
        {
          'Content-Type': 'application/json',
          'User-Agent': 'Ratio-Notify/1',
          [WEBHOOK_TIMESTAMP_HEADER]: sig.timestamp,
          [WEBHOOK_SIGNATURE_HEADER]: sig.signature,
          [WEBHOOK_DELIVERY_HEADER]: deliveryId(event.tenant, event.dedupeKey, event.severity),
        },
        deps,
      );
    },
  };
}

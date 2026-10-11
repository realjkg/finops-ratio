// Guarded HTTPS POST used by the Slack and webhook channels.
//
// TRUST BOUNDARY: the URL is hostile until guardOutboundUrl approves it. The
// injected HttpTransport is trusted to honor the PinnedHttpRequest contract
// (connect to the checked address, never follow redirects, cap the response,
// discard the body). This module adds the checks that do not depend on that
// trust: the payload cap, a wall-clock timeout on the injected sleep, a 3xx
// refusal (a redirect is NEVER followed, so a redirect to a private address
// cannot be reached), a response-size verdict, and fixed result codes. A
// response body never leaves the transport, so none can reach a result.

import { guardOutboundUrl, raceTimeout, type EgressPolicy, type SsrfCode } from './ssrf';
import { hostOnly } from './secrets';
import type {
  ChannelResult,
  DnsResolver,
  HttpTransport,
  PinnedHttpRequest,
  PinnedHttpResponse,
  SecretStore,
  Sleep,
} from './types';

export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_REQUEST_BODY_BYTES = 128 * 1024;
/** Retry-After values above this are clamped by the dispatcher anyway; parsing stops here. */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;

export interface HttpDeliveryDeps {
  readonly resolve: DnsResolver;
  readonly http: HttpTransport;
  readonly sleep: Sleep;
  readonly policy: EgressPolicy;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** Dependencies of the URL-based channels (Slack, signed webhook). */
export interface HttpChannelDeps extends HttpDeliveryDeps {
  readonly secrets: SecretStore;
}

/** Retry-After as integer seconds only (HTTP-dates are ignored), as milliseconds, or undefined. */
export function parseRetryAfterMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{1,7}$/.test(value.trim())) return undefined;
  return Math.min(Number(value.trim()) * 1000, MAX_RETRY_AFTER_MS);
}

function validResponse(r: unknown): r is PinnedHttpResponse {
  if (typeof r !== 'object' || r === null) return false;
  const { status, bodyBytes } = r as { status?: unknown; bodyBytes?: unknown };
  return (
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599 &&
    typeof bodyBytes === 'number' &&
    Number.isFinite(bodyBytes) &&
    bodyBytes >= 0
  );
}

function ssrfFailure(code: SsrfCode, rawUrl: string): ChannelResult {
  return { ok: false, code: 'ssrf_denied', retryable: isTransientSsrf(code), detail: code, host: hostOnly(rawUrl) };
}

/** Only resolver trouble can clear up by itself; a blocked address or URL never will. */
function isTransientSsrf(code: SsrfCode): boolean {
  return code === 'dns_failed' || code === 'dns_timeout';
}

/**
 * Classify an HTTP status into a channel result. 2xx succeeds; 3xx is refused
 * (redirects are never followed); 408, 425, 429 and 5xx are retryable; every
 * other status is permanent.
 */
export function classifyStatus(res: PinnedHttpResponse, host: string, maxResponseBytes: number): ChannelResult {
  const { status } = res;
  if (res.bodyBytes > maxResponseBytes || res.bodyTruncated === true) {
    return { ok: false, code: 'response_too_large', retryable: false, status, host };
  }
  if (status >= 200 && status < 300) return { ok: true, status, host };
  if (status >= 300 && status < 400) return { ok: false, code: 'redirect_blocked', retryable: false, status, host };
  if (status === 429) {
    return { ok: false, code: 'http_rate_limited', retryable: true, status, host, retryAfterMs: parseRetryAfterMs(res.retryAfter) };
  }
  if (status === 408 || status === 425 || status >= 500) {
    return { ok: false, code: 'http_server_error', retryable: true, status, host };
  }
  if (status >= 400) return { ok: false, code: 'http_client_error', retryable: false, status, host };
  return { ok: false, code: 'http_unexpected_status', retryable: false, status, host };
}

/**
 * POST `body` to `rawUrl` after the SSRF guard. Resolves and re-checks DNS on
 * EVERY call, so a retry after a rebind is refused. Never throws.
 */
export async function postGuarded(
  rawUrl: string,
  body: string,
  headers: Readonly<Record<string, string>>,
  deps: HttpDeliveryDeps,
): Promise<ChannelResult> {
  if (new TextEncoder().encode(body).length > MAX_REQUEST_BODY_BYTES) {
    return { ok: false, code: 'payload_too_large', retryable: false, host: hostOnly(rawUrl) };
  }

  const guard = await guardOutboundUrl(rawUrl, deps.policy, { resolve: deps.resolve, sleep: deps.sleep });
  if (!guard.ok) return ssrfFailure(guard.code, rawUrl);
  const { target } = guard;

  const timeoutMs = deps.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const abort = new AbortController();
  const request: PinnedHttpRequest = {
    url: target.href,
    hostname: target.hostname,
    port: target.port,
    address: target.address,
    family: target.family,
    method: 'POST',
    headers,
    body,
    timeoutMs,
    maxResponseBytes,
    redirect: 'manual',
    signal: abort.signal,
  };

  let response: unknown;
  try {
    const raced = await raceTimeout(Promise.resolve().then(() => deps.http(request)), timeoutMs, deps.sleep);
    if (raced.timedOut) {
      abort.abort();
      return { ok: false, code: 'timeout', retryable: true, host: target.hostname };
    }
    response = raced.value;
  } catch {
    abort.abort();
    return { ok: false, code: 'transport_error', retryable: true, host: target.hostname };
  }
  if (!validResponse(response)) return { ok: false, code: 'transport_error', retryable: true, host: target.hostname };
  return classifyStatus(response, target.hostname, maxResponseBytes);
}

/**
 * For transport authors: read a response stream, count its bytes and discard
 * them, cancelling the stream as soon as `cap` is exceeded. Returns only counts.
 */
export async function drainCapped(
  stream: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<{ readonly bytes: number; readonly truncated: boolean }> {
  if (stream === null) return { bytes: 0, truncated: false };
  const reader = stream.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes, truncated: false };
    bytes += value.length;
    if (bytes > cap) {
      await reader.cancel().catch(() => undefined);
      return { bytes, truncated: true };
    }
  }
}

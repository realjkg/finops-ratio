// Shared contracts for alert delivery (src/notify/).
//
// Everything with an effect or a source of nondeterminism is an injected
// interface here: clock, sleep, randomness, DNS, secrets, HTTP, mail, audit and
// the dead-letter store. Nothing in this directory opens a socket, reads the
// environment or calls Date.now() / Math.random() on its own, so every test is
// offline and deterministic. See README.md.

import type { AlertEvent, Severity } from './alertEvent';

export type ChannelKind = 'slack' | 'webhook' | 'email';

/** Epoch milliseconds. */
export interface Clock {
  now(): number;
}

/**
 * Wait `ms` milliseconds. When `signal` aborts, a real implementation clears its
 * timer and settles. Injected so retry and timeout tests need no real time.
 */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Uniform random number in [0, 1). */
export type Random = () => number;

/**
 * Resolve a hostname to IP address literals (IPv4 dotted quad or IPv6). It must
 * return addresses, never names. The guard re-checks every answer.
 */
export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

/** Secrets are referenced by handle and resolved here; they are never put in config or logs. */
export interface SecretStore {
  get(tenant: string, handle: string): Promise<string | undefined>;
}

// --- HTTP ---------------------------------------------------------------------

/**
 * One outbound request, already approved by the SSRF guard. The transport MUST
 * connect to `address` (not re-resolve `hostname`), use `hostname` only for SNI
 * and the Host header, NOT follow redirects, stop reading after
 * `maxResponseBytes`, and abort on `signal`.
 */
export interface PinnedHttpRequest {
  readonly url: string;
  readonly hostname: string;
  readonly port: number;
  readonly address: string;
  readonly family: 4 | 6;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly redirect: 'manual';
  readonly signal: AbortSignal;
}

/**
 * What a transport reports. It must DISCARD the response body: only the byte
 * count crosses this boundary, so a response can never leak into logs, audit
 * records or delivery results.
 */
export interface PinnedHttpResponse {
  readonly status: number;
  readonly bodyBytes: number;
  readonly bodyTruncated?: boolean;
  /** Raw Retry-After header value, if any. */
  readonly retryAfter?: string;
}

export type HttpTransport = (req: PinnedHttpRequest) => Promise<PinnedHttpResponse>;

// --- Mail ---------------------------------------------------------------------

export interface MailEnvelope {
  readonly from: string;
  readonly to: readonly string[];
  /** Complete RFC 5322 message with CRLF line endings. */
  readonly raw: string;
  readonly messageId: string;
}

export interface MailResult {
  readonly accepted: boolean;
  /** True for a temporary failure (SMTP 4yz); false or absent for permanent. */
  readonly transient?: boolean;
}

export type MailTransport = (msg: MailEnvelope, signal: AbortSignal) => Promise<MailResult>;

// --- Channels -----------------------------------------------------------------

export type ChannelFailCode =
  | 'secret_handle_invalid'
  | 'secret_missing'
  | 'secret_unavailable'
  | 'secret_invalid'
  | 'ssrf_denied'
  | 'payload_too_large'
  | 'timeout'
  | 'transport_error'
  | 'redirect_blocked'
  | 'response_too_large'
  | 'http_rate_limited'
  | 'http_server_error'
  | 'http_client_error'
  | 'http_unexpected_status'
  | 'mail_transport_missing'
  | 'mail_message_invalid'
  | 'mail_rejected'
  | 'mail_temporary_failure'
  | 'internal_error';

export type ChannelResult =
  | { readonly ok: true; readonly status?: number; readonly host?: string }
  | {
      readonly ok: false;
      readonly code: ChannelFailCode;
      /** True when a later attempt could succeed (network, 5xx, 429). */
      readonly retryable: boolean;
      readonly status?: number;
      readonly host?: string;
      /** Fixed enumerated detail such as an SSRF class; never free text. */
      readonly detail?: string;
      readonly retryAfterMs?: number;
    };

export interface SendContext {
  readonly tenant: string;
  readonly attempt: number;
}

/** One delivery channel. `send` never throws for expected failures. */
export interface AlertChannel {
  readonly kind: ChannelKind;
  readonly id: string;
  send(event: AlertEvent, ctx: SendContext): Promise<ChannelResult>;
}

// --- Audit and dead letters -----------------------------------------------------

export type AuditOutcome =
  | 'accepted'
  | 'rejected'
  | 'skipped'
  | 'suppressed'
  | 'rate_limited'
  | 'delivered'
  | 'failed'
  | 'dead_lettered';

/**
 * One audit record. Contains no secrets, no URLs (host only), no message text
 * and no response data; every string field is a fixed code or a validated token.
 */
export interface AuditRecord {
  readonly at: number;
  readonly tenant: string;
  /** The acting subject (principal sub or a `system:` name). */
  readonly actor: string;
  readonly outcome: AuditOutcome;
  readonly code: string;
  readonly channelId?: string;
  readonly channelKind?: ChannelKind;
  readonly dedupeKey?: string;
  readonly severity?: Severity;
  readonly attempt?: number;
  readonly host?: string;
  readonly httpStatus?: number;
  readonly detail?: string;
  readonly latencyMs?: number;
}

export interface AuditSink {
  record(rec: AuditRecord): void | Promise<void>;
}

export type DeadLetterReason = 'retries_exhausted' | 'permanent_failure' | 'circuit_open' | 'egress_disabled';

/** A delivery that could not be completed. Holds the validated event for replay; no secrets. */
export interface DeadLetterRecord {
  readonly tenant: string;
  readonly channelId: string;
  readonly channelKind: ChannelKind;
  readonly dedupeKey: string;
  readonly severity: Severity;
  readonly reason: DeadLetterReason;
  readonly lastCode: string;
  readonly attempts: number;
  readonly firstAttemptAt: number;
  readonly failedAt: number;
  readonly event: AlertEvent;
}

export interface DeadLetterSink {
  put(rec: DeadLetterRecord): void | Promise<void>;
}

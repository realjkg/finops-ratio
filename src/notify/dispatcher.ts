// Alert dispatcher: routing, dedupe, rate limit, circuit breaker, retry with
// backoff and jitter, dead letters, and one audit record per attempt.
//
// DISABLED BY DEFAULT (D-17, network egress is a restricted class). Nothing is
// sent unless ALL of these hold at the moment of each attempt:
//   1. the injected `egressEnabled()` flag returns true (default: false);
//   2. the tenant has a config whose `tenant` equals the event's tenant;
//   3. a channel in that config has `enabled: true` and lists the event's
//      severity.
// With the flag false the dispatcher performs no config read, no secret read,
// no DNS lookup, no HTTP call and no mail call; it only writes one audit
// record. The flag is re-read before EVERY attempt, so flipping it off stops
// in-flight retries (a kill switch).
//
// TRUST BOUNDARY: the event is untrusted (parseAlertEvent), the tenant config
// is untrusted (parseTenantNotifyConfig), secrets and responses are never
// logged. Audit records, delivery results and dead letters carry fixed codes,
// validated tokens and hosts only. If the audit sink fails, the dispatcher
// fails closed: before any send it refuses the dispatch; after an attempt it
// stops retrying.
//
// All time, randomness, network and storage are injected (see types.ts).

import { parseAlertEvent, type AlertEvent } from './alertEvent';
import { CircuitBreakers } from './circuitBreaker';
import { parseTenantNotifyConfig, type ChannelSpec, type TenantNotifyConfig } from './config';
import { InMemoryDeadLetters } from './deadLetters';
import { DedupeWindow, DEFAULT_DEDUPE_WINDOW_MS } from './dedupe';
import { createEmailChannel } from './email';
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  type HttpChannelDeps,
} from './httpDelivery';
import { createSlackChannel } from './slack';
import { createWebhookChannel } from './webhook';
import { DEFAULT_DNS_TIMEOUT_MS, type EgressPolicy } from './ssrf';
import { SlidingWindowRateLimiter } from '@/server/gateway/rateLimit';
import type {
  AlertChannel,
  AuditRecord,
  AuditSink,
  ChannelKind,
  ChannelResult,
  Clock,
  DeadLetterReason,
  DeadLetterSink,
  DnsResolver,
  HttpTransport,
  MailTransport,
  Random,
  SecretStore,
  Sleep,
} from './types';

/** No configuration can raise the attempt count above this. */
export const MAX_ATTEMPTS_CEILING = 8;
/** No configuration can raise a single backoff delay above this. */
export const MAX_DELAY_CEILING_MS = 300_000;

export interface DispatcherOptions {
  /** Total attempts per delivery, first try included (1 to 8, default 4). */
  readonly maxAttempts?: number;
  /** First backoff delay before jitter (default 500 ms). */
  readonly baseDelayMs?: number;
  /** Cap on one backoff delay (default 30 s, at most 5 min). */
  readonly maxDelayMs?: number;
  readonly dedupeWindowMs?: number;
  /** Deliveries per tenant per rate window (default 60). */
  readonly rateLimitPerWindow?: number;
  readonly rateLimitWindowMs?: number;
  readonly breakerFailureThreshold?: number;
  readonly breakerOpenMs?: number;
  readonly httpTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly dnsTimeoutMs?: number;
  readonly mailTimeoutMs?: number;
}

export interface DispatcherDeps {
  /** Raw tenant config (or undefined). It is re-validated on every dispatch. */
  readonly getTenantConfig: (tenant: string) => unknown;
  readonly secrets: SecretStore;
  readonly resolve: DnsResolver;
  readonly http: HttpTransport;
  readonly mail?: MailTransport;
  readonly audit: AuditSink;
  readonly deadLetters?: DeadLetterSink;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly random: Random;
  /** Egress flag, read before every attempt. Default: always false. */
  readonly egressEnabled?: () => boolean;
  readonly options?: DispatcherOptions;
}

export type DeliveryStatus = 'delivered' | 'failed' | 'suppressed' | 'rate_limited' | 'skipped';

/** Per-channel outcome. Never contains a response body, URL or secret. */
export interface DeliveryResult {
  readonly channelId: string;
  readonly kind: ChannelKind;
  readonly status: DeliveryStatus;
  readonly code: string;
  readonly attempts: number;
  readonly httpStatus?: number;
  readonly retryAfterSec?: number;
  readonly deadLettered: boolean;
}

export type DispatchStatus =
  | 'rejected'
  | 'egress_disabled'
  | 'audit_unavailable'
  | 'no_config'
  | 'config_invalid'
  | 'no_route'
  | 'completed';

export interface DispatchResult {
  readonly status: DispatchStatus;
  /** Fixed code for `rejected` and `config_invalid`. */
  readonly code?: string;
  readonly results: readonly DeliveryResult[];
}

const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

/**
 * Backoff before attempt `attempt + 1`: min(maxDelay, base * 2^(attempt-1)) with
 * "equal jitter", so the delay lies in [exp/2, exp). A server Retry-After raises
 * the delay but never above `maxMs`. `random` is clamped into [0, 1).
 */
export function computeBackoffMs(args: {
  readonly attempt: number;
  readonly baseMs: number;
  readonly maxMs: number;
  readonly random: number;
  readonly retryAfterMs?: number;
}): number {
  const exp = Math.min(args.maxMs, args.baseMs * Math.pow(2, Math.max(0, args.attempt - 1)));
  const r = Number.isFinite(args.random) ? Math.min(Math.max(args.random, 0), 0.999999999) : 0.999999999;
  const jittered = Math.floor(exp / 2 + (r * exp) / 2);
  if (args.retryAfterMs === undefined || !Number.isFinite(args.retryAfterMs) || args.retryAfterMs <= 0) return jittered;
  return Math.max(jittered, Math.min(args.retryAfterMs, args.maxMs));
}

function checkOption(v: number | undefined, def: number, min: number, max: number): number {
  const value = v ?? def;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('invalid notify dispatcher option');
  return value;
}

export class AlertDispatcher {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly httpTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly dnsTimeoutMs: number;
  private readonly mailTimeoutMs: number;
  private readonly dedupe: DedupeWindow;
  private readonly limiter: SlidingWindowRateLimiter;
  private readonly breakers: CircuitBreakers;
  private readonly deadLetters: DeadLetterSink;
  private readonly egress: () => boolean;

  constructor(private readonly deps: DispatcherDeps) {
    const o = deps.options ?? {};
    this.maxAttempts = checkOption(o.maxAttempts, 4, 1, MAX_ATTEMPTS_CEILING);
    this.maxDelayMs = checkOption(o.maxDelayMs, 30_000, 1, MAX_DELAY_CEILING_MS);
    this.baseDelayMs = checkOption(o.baseDelayMs, 500, 1, this.maxDelayMs);
    this.httpTimeoutMs = checkOption(o.httpTimeoutMs, DEFAULT_HTTP_TIMEOUT_MS, 1, 120_000);
    this.maxResponseBytes = checkOption(o.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1, 1024 * 1024);
    this.dnsTimeoutMs = checkOption(o.dnsTimeoutMs, DEFAULT_DNS_TIMEOUT_MS, 1, 60_000);
    this.mailTimeoutMs = checkOption(o.mailTimeoutMs, 30_000, 1, 300_000);
    this.dedupe = new DedupeWindow(deps.clock, checkOption(o.dedupeWindowMs, DEFAULT_DEDUPE_WINDOW_MS, 1, 86_400_000));
    this.limiter = new SlidingWindowRateLimiter(
      checkOption(o.rateLimitPerWindow, 60, 1, 100_000),
      checkOption(o.rateLimitWindowMs, 60_000, 1000, 3_600_000),
      () => deps.clock.now(),
    );
    this.breakers = new CircuitBreakers(deps.clock, {
      failureThreshold: checkOption(o.breakerFailureThreshold, 5, 1, 1000),
      openMs: checkOption(o.breakerOpenMs, 60_000, 1, 86_400_000),
    });
    this.deadLetters = deps.deadLetters ?? new InMemoryDeadLetters();
    this.egress = deps.egressEnabled ?? (() => false);
  }

  private egressOn(): boolean {
    try {
      return this.egress() === true;
    } catch {
      return false; // a throwing flag reads as off
    }
  }

  private async audit(rec: Omit<AuditRecord, 'at'>): Promise<boolean> {
    try {
      await this.deps.audit.record({ ...rec, at: this.deps.clock.now() });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate and deliver one alert. Never throws. `actor` names the acting
   * subject for the audit trail (a principal `sub` or a `system:` name).
   */
  async dispatch(input: unknown, ctx: { readonly actor: string }): Promise<DispatchResult> {
    const actorOk = typeof ctx?.actor === 'string' && ACTOR_RE.test(ctx.actor);
    const actor = actorOk ? ctx.actor : '[invalid-actor]';

    const parsed = parseAlertEvent(input);
    if (!parsed.ok || !actorOk) {
      const code = !parsed.ok ? parsed.code : 'actor_invalid';
      await this.audit({ tenant: '-', actor, outcome: 'rejected', code });
      return { status: 'rejected', code, results: [] };
    }
    const event = parsed.event;
    const head = { tenant: event.tenant, actor, dedupeKey: event.dedupeKey, severity: event.severity } as const;

    if (!this.egressOn()) {
      await this.audit({ ...head, outcome: 'skipped', code: 'egress_disabled' });
      return { status: 'egress_disabled', results: [] };
    }

    let rawConfig: unknown;
    try {
      rawConfig = await this.deps.getTenantConfig(event.tenant);
    } catch {
      await this.audit({ ...head, outcome: 'skipped', code: 'config_unavailable' });
      return { status: 'config_invalid', code: 'config_unavailable', results: [] };
    }
    if (rawConfig === undefined || rawConfig === null) {
      await this.audit({ ...head, outcome: 'skipped', code: 'no_config' });
      return { status: 'no_config', results: [] };
    }
    const cfg = parseTenantNotifyConfig(rawConfig);
    if (!cfg.ok) {
      await this.audit({ ...head, outcome: 'skipped', code: 'config_invalid', detail: cfg.code });
      return { status: 'config_invalid', code: cfg.code, results: [] };
    }
    if (cfg.config.tenant !== event.tenant) {
      await this.audit({ ...head, outcome: 'skipped', code: 'tenant_mismatch' });
      return { status: 'config_invalid', code: 'tenant_mismatch', results: [] };
    }

    const routes = cfg.config.channels.filter((c) => c.enabled && c.severities.includes(event.severity));
    if (routes.length === 0) {
      await this.audit({ ...head, outcome: 'skipped', code: 'no_route' });
      return { status: 'no_route', results: [] };
    }

    // Fail closed: nothing is sent unless the dispatch itself could be audited.
    if (!(await this.audit({ ...head, outcome: 'accepted', code: 'accepted' }))) {
      return { status: 'audit_unavailable', results: [] };
    }

    const results = await Promise.all(routes.map((spec) => this.deliver(spec, cfg.config, event, actor)));
    return { status: 'completed', results };
  }

  private buildChannel(spec: ChannelSpec, cfg: TenantNotifyConfig): AlertChannel {
    const policy: EgressPolicy = {
      allowedHosts: cfg.allowedHosts,
      allowedPorts: cfg.allowedPorts,
      dnsTimeoutMs: this.dnsTimeoutMs,
    };
    const http: HttpChannelDeps = {
      secrets: this.deps.secrets,
      resolve: this.deps.resolve,
      http: this.deps.http,
      sleep: this.deps.sleep,
      policy,
      timeoutMs: this.httpTimeoutMs,
      maxResponseBytes: this.maxResponseBytes,
    };
    switch (spec.kind) {
      case 'slack':
        return createSlackChannel({ id: spec.id, urlHandle: spec.urlHandle }, http);
      case 'webhook':
        return createWebhookChannel(
          { id: spec.id, urlHandle: spec.urlHandle, secretHandle: spec.secretHandle },
          { ...http, clock: this.deps.clock },
        );
      case 'email':
        return createEmailChannel(
          { id: spec.id, from: spec.from, fromName: spec.fromName, to: spec.to },
          { mail: this.deps.mail, clock: this.deps.clock, sleep: this.deps.sleep, timeoutMs: this.mailTimeoutMs },
        );
    }
  }

  private async safeSend(channel: AlertChannel, event: AlertEvent, attempt: number): Promise<ChannelResult> {
    try {
      const res = await channel.send(event, { tenant: event.tenant, attempt });
      if (typeof res === 'object' && res !== null && typeof res.ok === 'boolean') return res;
      return { ok: false, code: 'internal_error', retryable: false };
    } catch {
      return { ok: false, code: 'internal_error', retryable: false };
    }
  }

  private async deliver(
    spec: ChannelSpec,
    cfg: TenantNotifyConfig,
    event: AlertEvent,
    actor: string,
  ): Promise<DeliveryResult> {
    const base = {
      tenant: event.tenant,
      actor,
      channelId: spec.id,
      channelKind: spec.kind,
      dedupeKey: event.dedupeKey,
      severity: event.severity,
    } as const;
    const result = (
      status: DeliveryStatus,
      code: string,
      attempts: number,
      extra: { httpStatus?: number; retryAfterSec?: number; deadLettered?: boolean } = {},
    ): DeliveryResult => ({
      channelId: spec.id,
      kind: spec.kind,
      status,
      code,
      attempts,
      deadLettered: false,
      ...extra,
    });

    const dedupeKey = DedupeWindow.key(event.tenant, spec.id, event.severity, event.dedupeKey);
    if (!this.dedupe.acquire(dedupeKey)) {
      await this.audit({ ...base, outcome: 'suppressed', code: 'duplicate' });
      return result('suppressed', 'duplicate', 0);
    }

    const rate = this.limiter.take(event.tenant);
    if (!rate.allowed) {
      this.dedupe.release(dedupeKey);
      await this.audit({ ...base, outcome: 'rate_limited', code: 'rate_limited' });
      return result('rate_limited', 'rate_limited', 0, { retryAfterSec: rate.retryAfterSec });
    }

    const channel = this.buildChannel(spec, cfg);
    const breakerKey = `${event.tenant}\u0000${spec.id}`;
    const firstAttemptAt = this.deps.clock.now();
    let attempts = 0;
    let lastCode = 'none';
    let lastStatus: number | undefined;

    const deadLetter = async (reason: DeadLetterReason, code: string): Promise<DeliveryResult> => {
      this.dedupe.release(dedupeKey);
      let stored = true;
      try {
        await this.deadLetters.put({
          tenant: event.tenant,
          channelId: spec.id,
          channelKind: spec.kind,
          dedupeKey: event.dedupeKey,
          severity: event.severity,
          reason,
          lastCode: code,
          attempts,
          firstAttemptAt,
          failedAt: this.deps.clock.now(),
          event,
        });
      } catch {
        stored = false;
      }
      await this.audit({
        ...base,
        outcome: stored ? 'dead_lettered' : 'failed',
        code: stored ? reason : 'dead_letter_failed',
        detail: code,
        attempt: attempts,
      });
      return result('failed', code, attempts, { httpStatus: lastStatus, deadLettered: stored });
    };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (!this.egressOn()) {
        if (attempts === 0) {
          this.dedupe.release(dedupeKey);
          await this.audit({ ...base, outcome: 'skipped', code: 'egress_disabled' });
          return result('skipped', 'egress_disabled', 0);
        }
        return deadLetter('egress_disabled', 'egress_disabled');
      }
      if (!this.breakers.allow(breakerKey)) return deadLetter('circuit_open', 'circuit_open');

      attempts = attempt;
      const started = this.deps.clock.now();
      const res = await this.safeSend(channel, event, attempt);
      const latencyMs = Math.max(0, this.deps.clock.now() - started);
      lastCode = res.ok ? 'ok' : res.code;
      lastStatus = res.status;

      const audited = await this.audit({
        ...base,
        outcome: res.ok ? 'delivered' : 'failed',
        code: lastCode,
        attempt,
        host: res.host,
        httpStatus: res.status,
        detail: res.ok ? undefined : res.detail,
        latencyMs,
      });

      if (res.ok) {
        this.breakers.onSuccess(breakerKey);
        return result('delivered', 'ok', attempts, { httpStatus: res.status });
      }
      if (!res.retryable) {
        this.breakers.release(breakerKey);
        return deadLetter('permanent_failure', lastCode);
      }
      if (this.breakers.onFailure(breakerKey) === 'open') return deadLetter('circuit_open', lastCode);
      if (!audited) return deadLetter('retries_exhausted', 'audit_unavailable');
      if (attempt === this.maxAttempts) return deadLetter('retries_exhausted', lastCode);

      await this.deps.sleep(
        computeBackoffMs({
          attempt,
          baseMs: this.baseDelayMs,
          maxMs: this.maxDelayMs,
          random: this.deps.random(),
          retryAfterMs: res.retryAfterMs,
        }),
      );
    }
    return deadLetter('retries_exhausted', lastCode); // unreachable: the loop always returns
  }
}

export function createDispatcher(deps: DispatcherDeps): AlertDispatcher {
  return new AlertDispatcher(deps);
}

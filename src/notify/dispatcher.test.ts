// Dispatcher: disabled by default, routing, dedupe, rate limit, breaker,
// retry/backoff/jitter, dead letters, audit hygiene, and secret absence.

import { describe, it, expect } from 'vitest';
import { CircuitBreakers } from './circuitBreaker';
import { CONFIG_LIMITS, parseTenantNotifyConfig } from './config';
import { InMemoryDeadLetters } from './deadLetters';
import { DedupeWindow } from './dedupe';
import { MAX_ATTEMPTS_CEILING, computeBackoffMs, createDispatcher } from './dispatcher';
import { HANDLE_RE, hostOnly, resolveSecret } from './secrets';
import { SLACK_URL, WEBHOOK_URL, SIGNING_SECRET, T0, makeClock, makeRig, makeSecrets, rawConfig, rawEvent, secretsAbsent, type RigOptions } from './testKit';

const slackOnly = (over: Record<string, unknown> = {}) =>
  rawConfig({ channels: [{ id: 'slack-main', kind: 'slack', enabled: true, severities: ['info', 'warning', 'critical'], urlHandle: 'notify/slack-main', ...over }] });
const actor = { actor: 'system:detector' };
const fail500 = () => ({ status: 500, bodyBytes: 0 });
const everything = (r: ReturnType<typeof makeRig>, extra: unknown[] = []) => [r.audit.records, r.dlq.list(), ...extra];

describe('disabled by default', () => {
  it('without an egress option nothing is called: no config, secret, DNS, HTTP or mail access', async () => {
    const r = makeRig({});
    const d = createDispatcher({
      getTenantConfig: (t) => { r.configCalls.push(t); return rawConfig(); }, secrets: r.secrets.store, resolve: r.resolver.resolve,
      http: r.http.transport, mail: r.mail.transport, audit: r.audit.sink, clock: r.clock, sleep: r.sleeper.sleep, random: () => 0.5,
    });
    const res = await d.dispatch(rawEvent(), actor);
    expect(res).toEqual({ status: 'egress_disabled', results: [] });
    expect([r.configCalls.length, r.secrets.reads.length, r.resolver.calls.length, r.http.requests.length, r.mail.sent.length]).toEqual([0, 0, 0, 0, 0]);
    expect(r.audit.records).toMatchObject([{ outcome: 'skipped', code: 'egress_disabled', tenant: 'acme', actor: 'system:detector' }]);
  });
  it('an explicit false flag, a throwing flag and a truthy non-true value all read as off', async () => {
    for (const flag of [() => false, () => { throw new Error('x'); }, () => 1 as unknown as boolean]) {
      const r = makeRig({});
      const d = createDispatcher({ getTenantConfig: () => rawConfig(), secrets: r.secrets.store, resolve: r.resolver.resolve, http: r.http.transport, audit: r.audit.sink, clock: r.clock, sleep: r.sleeper.sleep, random: () => 0, egressEnabled: flag });
      expect((await d.dispatch(rawEvent(), actor)).status).toBe('egress_disabled');
      expect(r.http.requests).toHaveLength(0);
    }
  });
  it('a channel without enabled:true sends nothing even with egress on', async () => {
    for (const enabled of [false, undefined]) {
      const cfg = rawConfig({ channels: [{ id: 'slack-main', kind: 'slack', ...(enabled === undefined ? {} : { enabled }), severities: ['critical'], urlHandle: 'notify/slack-main' }] });
      const r = makeRig({ config: cfg });
      expect((await r.dispatcher.dispatch(rawEvent(), actor)).status).toBe('no_route');
      expect(r.http.requests).toHaveLength(0); expect(r.secrets.reads).toHaveLength(0);
    }
  });
  it('turning the flag off mid-retry stops further attempts and dead-letters the delivery', async () => {
    const r = makeRig({ config: slackOnly(), httpHandler: () => { r.flag.on = false; return { status: 500, bodyBytes: 0 }; } });
    const res = await r.dispatcher.dispatch(rawEvent(), actor);
    expect(res.results[0]).toMatchObject({ status: 'failed', attempts: 1, deadLettered: true });
    expect(r.http.requests).toHaveLength(1);
    expect(r.dlq.list()[0].reason).toBe('egress_disabled');
  });
  it('rejects an invalid actor without sending', async () => {
    const r = makeRig({});
    for (const a of ['', 'a b', 'a\nb', undefined as unknown as string]) {
      expect(await r.dispatcher.dispatch(rawEvent(), { actor: a })).toMatchObject({ status: 'rejected', code: 'actor_invalid' });
    }
    expect(r.http.requests).toHaveLength(0);
  });
});

describe('validation and config gates', () => {
  it('rejects a malformed event with a fixed code and audits it without echoing input', async () => {
    const r = makeRig({});
    const res = await r.dispatcher.dispatch(rawEvent({ severity: 'CANARY' }), actor);
    expect(res).toEqual({ status: 'rejected', code: 'severity_invalid', results: [] });
    expect(r.audit.records[0]).toMatchObject({ outcome: 'rejected', code: 'severity_invalid', tenant: '-' });
    expect(secretsAbsent(r.audit.records)).toBe(true);
    expect(r.http.requests).toHaveLength(0);
  });
  it('no config, invalid config, throwing config and tenant mismatch send nothing', async () => {
    expect((await makeRig({ config: null }).dispatcher.dispatch(rawEvent(), actor)).status).toBe('no_config');
    const bad = makeRig({ config: { tenant: 'acme', channels: 'x' } });
    expect(await bad.dispatcher.dispatch(rawEvent(), actor)).toMatchObject({ status: 'config_invalid', code: 'channels_invalid' });
    const mismatch = makeRig({ config: rawConfig({ tenant: 'other' }) });
    expect(await mismatch.dispatcher.dispatch(rawEvent(), actor)).toMatchObject({ status: 'config_invalid', code: 'tenant_mismatch' });
    const r = makeRig({});
    const d = createDispatcher({ getTenantConfig: () => { throw new Error('db CANARY'); }, secrets: r.secrets.store, resolve: r.resolver.resolve, http: r.http.transport, audit: r.audit.sink, clock: r.clock, sleep: r.sleeper.sleep, random: () => 0, egressEnabled: () => true });
    expect(await d.dispatch(rawEvent(), actor)).toMatchObject({ status: 'config_invalid', code: 'config_unavailable' });
    expect(secretsAbsent(r.audit.records)).toBe(true);
    for (const x of [bad, mismatch]) expect(x.http.requests).toHaveLength(0);
  });
  it('fails closed when the audit sink is down before sending', async () => {
    const r = makeRig({ auditFailAfter: 0 });
    expect((await r.dispatcher.dispatch(rawEvent(), actor)).status).toBe('audit_unavailable');
    expect(r.http.requests).toHaveLength(0);
  });
  it('rejects invalid dispatcher options', () => {
    const r = makeRig({});
    const mk = (options: object) => () => createDispatcher({ getTenantConfig: () => null, secrets: r.secrets.store, resolve: r.resolver.resolve, http: r.http.transport, audit: r.audit.sink, clock: r.clock, sleep: r.sleeper.sleep, random: () => 0, options });
    expect(mk({ maxAttempts: MAX_ATTEMPTS_CEILING + 1 })).toThrow(); expect(mk({ maxAttempts: 0 })).toThrow(); expect(mk({ maxDelayMs: 300_001 })).toThrow();
    expect(mk({ maxAttempts: MAX_ATTEMPTS_CEILING })).not.toThrow();
  });
});

describe('routing by severity', () => {
  it.each([
    ['info', ['slack-main']],
    ['warning', ['slack-main', 'hook-main']],
    ['critical', ['slack-main', 'hook-main', 'mail-main']],
  ] as const)('%s goes to %j', async (severity, ids) => {
    const r = makeRig({});
    const res = await r.dispatcher.dispatch(rawEvent({ severity }), actor);
    expect(res.results.map((x) => x.channelId).sort()).toEqual([...ids].sort());
    expect(res.results.every((x) => x.status === 'delivered')).toBe(true);
    expect(r.http.requests).toHaveLength(ids.filter((i) => i !== 'mail-main').length);
    expect(r.mail.sent).toHaveLength(ids.includes('mail-main' as never) ? 1 : 0);
  });
  it('a failing channel does not stop the others, and audit has one record per attempt', async () => {
    const r = makeRig({ httpHandler: (req) => (req.hostname === 'hooks.slack.com' ? fail500() : { status: 200, bodyBytes: 0 }), options: { maxAttempts: 2 } });
    const res = await r.dispatcher.dispatch(rawEvent(), actor);
    const by = Object.fromEntries(res.results.map((x) => [x.channelId, x]));
    expect(by['slack-main']).toMatchObject({ status: 'failed', attempts: 2, deadLettered: true });
    expect(by['hook-main']).toMatchObject({ status: 'delivered', attempts: 1 });
    expect(by['mail-main']).toMatchObject({ status: 'delivered' });
    expect(r.audit.records.filter((a) => a.channelId === 'slack-main' && a.outcome === 'failed')).toHaveLength(2);
  });
  it('tenants are isolated: dedupe and rate limit keys include the tenant', async () => {
    const cfgFor = (t: string) => (t === 'acme' ? slackOnly() : { ...slackOnly(), tenant: t });
    const r = makeRig({ options: { rateLimitPerWindow: 1 } });
    const d = createDispatcher({ getTenantConfig: (t) => cfgFor(t), secrets: r.secrets.store, resolve: r.resolver.resolve, http: r.http.transport, audit: r.audit.sink, clock: r.clock, sleep: r.sleeper.sleep, random: () => 0, egressEnabled: () => true, options: { rateLimitPerWindow: 1 } });
    expect((await d.dispatch(rawEvent(), actor)).results[0].status).toBe('delivered');
    expect((await d.dispatch(rawEvent({ tenant: 'globex' }), actor)).results[0].status).toBe('delivered');
    expect((await d.dispatch(rawEvent({ dedupeKey: 'k2' }), actor)).results[0].status).toBe('rate_limited');
  });
});

describe('dedupe', () => {
  it('suppresses an identical alert in the window, delivers after expiry, and on escalation', async () => {
    const r = makeRig({ config: slackOnly(), options: { dedupeWindowMs: 60_000 } });
    const st = async (o: Record<string, unknown> = {}) => (await r.dispatcher.dispatch(rawEvent(o), actor)).results[0].status;
    expect(await st()).toBe('delivered');
    expect(await st()).toBe('suppressed');
    expect(r.http.requests).toHaveLength(1);
    expect(await st({ severity: 'warning' })).toBe('delivered');
    r.clock.advance(59_999); expect(await st()).toBe('suppressed');
    r.clock.advance(1); expect(await st()).toBe('delivered');
    expect(r.audit.records.filter((a) => a.outcome === 'suppressed').map((a) => a.code)).toEqual(['duplicate', 'duplicate']);
  });
  it('a permanently failed delivery releases its key so a re-dispatch can try again', async () => {
    let status = 400;
    const r = makeRig({ config: slackOnly(), httpHandler: () => ({ status, bodyBytes: 0 }) });
    expect((await r.dispatcher.dispatch(rawEvent(), actor)).results[0].status).toBe('failed');
    status = 200;
    expect((await r.dispatcher.dispatch(rawEvent(), actor)).results[0].status).toBe('delivered');
  });
  it('DedupeWindow unit: half-open window, release and bounded size', () => {
    const c = makeClock(0); const w = new DedupeWindow(c, 100, 3);
    expect(w.acquire('a')).toBe(true); c.set(99); expect(w.acquire('a')).toBe(false); c.set(100); expect(w.acquire('a')).toBe(true);
    w.release('a'); expect(w.acquire('a')).toBe(true);
    for (const k of ['b', 'c', 'd', 'e']) w.acquire(k);
    expect(w.size()).toBeLessThanOrEqual(3);
    expect(() => new DedupeWindow(c, 0)).toThrow();
    expect(DedupeWindow.key('t', 'c', 's', 'k')).not.toBe(DedupeWindow.key('t', 'c', 's', 'k2'));
  });
});

describe('per-tenant rate limit', () => {
  it('limits deliveries per window, reports retryAfterSec, releases the dedupe key, and recovers', async () => {
    const r = makeRig({ config: slackOnly(), options: { rateLimitPerWindow: 2, rateLimitWindowMs: 60_000 } });
    const go = async (k: string) => (await r.dispatcher.dispatch(rawEvent({ dedupeKey: k }), actor)).results[0];
    expect((await go('a')).status).toBe('delivered'); expect((await go('b')).status).toBe('delivered');
    const limited = await go('c');
    expect(limited).toMatchObject({ status: 'rate_limited', attempts: 0 }); expect(limited.retryAfterSec).toBeGreaterThan(0);
    expect(r.http.requests).toHaveLength(2);
    r.clock.advance(60_001);
    expect((await go('c')).status).toBe('delivered');
  });
});

describe('retry, backoff and jitter', () => {
  it('retries transient failures with exponential backoff and succeeds', async () => {
    const r = makeRig({ config: slackOnly(), httpHandler: (_q, n) => (n < 3 ? fail500() : { status: 200, bodyBytes: 0 }), random: () => 0, options: { baseDelayMs: 100, maxDelayMs: 10_000 } });
    const res = await r.dispatcher.dispatch(rawEvent(), actor);
    expect(res.results[0]).toMatchObject({ status: 'delivered', attempts: 3 });
    expect(r.sleeper.delays).toEqual([50, 100]); // random 0 -> lower bound exp/2: 100/2, 200/2
    expect(r.audit.records.filter((a) => a.attempt !== undefined).map((a) => [a.attempt, a.outcome])).toEqual([[1, 'failed'], [2, 'failed'], [3, 'delivered']]);
  });
  it('exhausts the ceiling, writes a dead letter, and stops at maxAttempts', async () => {
    const r = makeRig({ config: slackOnly(), httpHandler: fail500, options: { maxAttempts: 4 } });
    const res = await r.dispatcher.dispatch(rawEvent(), actor);
    expect(res.results[0]).toMatchObject({ status: 'failed', code: 'http_server_error', attempts: 4, deadLettered: true, httpStatus: 500 });
    expect(r.http.requests).toHaveLength(4); expect(r.sleeper.delays).toHaveLength(3);
    const dl = r.dlq.list();
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({ tenant: 'acme', channelId: 'slack-main', reason: 'retries_exhausted', attempts: 4, lastCode: 'http_server_error' });
    expect(dl[0].event.title).toBe('Budget hard threshold crossed');
    expect(r.audit.records.at(-1)).toMatchObject({ outcome: 'dead_lettered', code: 'retries_exhausted' });
  });
  it('the retry ceiling is hard: the maximum configurable attempts is 8', async () => {
    const r = makeRig({ config: slackOnly(), httpHandler: fail500, options: { maxAttempts: 8, breakerFailureThreshold: 1000 } });
    await r.dispatcher.dispatch(rawEvent(), actor);
    expect(r.http.requests).toHaveLength(8);
  });
  it('permanent failures are not retried', async () => {
    for (const status of [400, 404, 302]) {
      const r = makeRig({ config: slackOnly(), httpHandler: () => ({ status, bodyBytes: 0 }) });
      const res = await r.dispatcher.dispatch(rawEvent(), actor);
      expect(res.results[0]).toMatchObject({ attempts: 1, deadLettered: true });
      expect(r.dlq.list()[0].reason).toBe('permanent_failure');
    }
  });
  it('an SSRF refusal on retry (DNS rebinding to private) is not retried and dead-letters', async () => {
    const r = makeRig({ config: slackOnly(), resolverTable: { 'hooks.slack.com': [['93.184.216.34'], ['10.0.0.9']] }, httpHandler: fail500 });
    const res = await r.dispatcher.dispatch(rawEvent(), actor);
    expect(res.results[0]).toMatchObject({ attempts: 2, code: 'ssrf_denied' });
    expect(r.http.requests).toHaveLength(1);
    expect(r.audit.records.some((a) => a.detail === 'blocked_private')).toBe(true);
  });
  it('Retry-After raises the delay but is capped at maxDelayMs', async () => {
    const r = makeRig({ config: slackOnly(), httpHandler: (_q, n) => (n === 1 ? { status: 429, bodyBytes: 0, retryAfter: '3600' } : { status: 200, bodyBytes: 0 }), options: { maxDelayMs: 5000 }, random: () => 0 });
    await r.dispatcher.dispatch(rawEvent(), actor);
    expect(r.sleeper.delays).toEqual([5000]);
  });
  it('computeBackoffMs: jitter bounds, cap, clamping and Retry-After', () => {
    const f = (attempt: number, random: number, retryAfterMs?: number) => computeBackoffMs({ attempt, baseMs: 100, maxMs: 1000, random, retryAfterMs });
    for (let a = 1; a <= 10; a += 1) {
      const exp = Math.min(1000, 100 * 2 ** (a - 1));
      expect(f(a, 0)).toBe(Math.floor(exp / 2));
      expect(f(a, 0.999999)).toBeLessThan(exp); expect(f(a, 0.999999)).toBeGreaterThanOrEqual(Math.floor(exp / 2));
    }
    expect(f(1, -5)).toBe(50); expect(f(1, 7)).toBeLessThan(100); expect(f(1, Number.NaN)).toBeLessThan(100);
    expect(f(1, 0, 400)).toBe(400); expect(f(1, 0, 99_999)).toBe(1000); expect(f(1, 0, -1)).toBe(50);
    expect(f(30, 0.5)).toBeLessThanOrEqual(1000);
  });
  it('uses the injected random for every backoff', async () => {
    const r = makeRig({ config: slackOnly(), httpHandler: fail500, options: { maxAttempts: 3 }, random: () => 0.25 });
    await r.dispatcher.dispatch(rawEvent(), actor);
    expect(r.randoms).toEqual([0.25, 0.25]);
  });
});

describe('circuit breaker', () => {
  it('opens after the threshold, short-circuits without sending, half-opens after openMs, and closes on success', async () => {
    let ok = false;
    const r = makeRig({ config: slackOnly(), httpHandler: () => (ok ? { status: 200, bodyBytes: 0 } : fail500()), options: { maxAttempts: 3, breakerFailureThreshold: 3, breakerOpenMs: 60_000 } });
    const go = async (k: string) => (await r.dispatcher.dispatch(rawEvent({ dedupeKey: k }), actor)).results[0];
    expect(await go('a')).toMatchObject({ status: 'failed', attempts: 3 });
    expect(r.dlq.list()[0].reason).toBe('circuit_open');
    const before = r.http.requests.length;
    expect(await go('b')).toMatchObject({ status: 'failed', code: 'circuit_open', attempts: 0 });
    expect(r.http.requests).toHaveLength(before);
    r.clock.advance(60_000); ok = true;
    expect(await go('c')).toMatchObject({ status: 'delivered' });
    expect(await go('d')).toMatchObject({ status: 'delivered' });
  });
  it('a failed half-open probe re-opens the circuit with a fresh timer', async () => {
    const r = makeRig({ config: slackOnly(), httpHandler: fail500, options: { maxAttempts: 1, breakerFailureThreshold: 1, breakerOpenMs: 1000 } });
    const go = async (k: string) => (await r.dispatcher.dispatch(rawEvent({ dedupeKey: k }), actor)).results[0];
    await go('a'); expect((await go('b')).code).toBe('circuit_open');
    r.clock.advance(1000); const probe = await go('c'); expect(probe.code).toBe('http_server_error');
    expect((await go('d')).code).toBe('circuit_open');
    r.clock.advance(999); expect((await go('e')).code).toBe('circuit_open');
  });
  it('breakers are per channel and per tenant', async () => {
    const r = makeRig({ httpHandler: (q) => (q.hostname === 'hooks.slack.com' ? fail500() : { status: 200, bodyBytes: 0 }), options: { maxAttempts: 1, breakerFailureThreshold: 1 } });
    await r.dispatcher.dispatch(rawEvent({ dedupeKey: 'a' }), actor);
    const res = await r.dispatcher.dispatch(rawEvent({ dedupeKey: 'b' }), actor);
    expect(res.results.find((x) => x.channelId === 'slack-main')?.code).toBe('circuit_open');
    expect(res.results.find((x) => x.channelId === 'hook-main')?.status).toBe('delivered');
  });
  it('CircuitBreakers unit: one probe slot in half-open, lost probe recovers, bounded size', () => {
    const c = makeClock(0); const b = new CircuitBreakers(c, { failureThreshold: 2, openMs: 100 }, 2);
    expect(b.state('k')).toBe('closed'); b.onFailure('k'); expect(b.onFailure('k')).toBe('open'); expect(b.state('k')).toBe('open'); expect(b.allow('k')).toBe(false);
    c.set(100); expect(b.state('k')).toBe('half_open'); expect(b.allow('k')).toBe(true); expect(b.allow('k')).toBe(false);
    c.set(200); expect(b.allow('k')).toBe(true);
    b.onSuccess('k'); expect(b.state('k')).toBe('closed'); expect(b.allow('k')).toBe(true);
    b.onFailure('x'); b.onFailure('y'); b.onFailure('z'); expect(b.size()).toBeLessThanOrEqual(2);
    expect(() => new CircuitBreakers(c, { failureThreshold: 0, openMs: 1 })).toThrow();
  });
});

describe('dead letters', () => {
  it('InMemoryDeadLetters is bounded and counts drops', () => {
    const d = new InMemoryDeadLetters(2); const rec = (n: number) => ({ tenant: 't', channelId: 'c', channelKind: 'slack' as const, dedupeKey: `${n}`, severity: 'info' as const, reason: 'retries_exhausted' as const, lastCode: 'x', attempts: 1, firstAttemptAt: 0, failedAt: 0, event: undefined as never });
    d.put(rec(1)); d.put(rec(2)); d.put(rec(3));
    expect(d.list().map((x) => x.dedupeKey)).toEqual(['2', '3']); expect(d.dropped()).toBe(1);
    expect(() => new InMemoryDeadLetters(0)).toThrow();
  });
  it('a failing dead-letter sink is audited as failed and does not throw', async () => {
    const r = makeRig({ config: slackOnly(), httpHandler: () => ({ status: 400, bodyBytes: 0 }) });
    const d = createDispatcher({ getTenantConfig: () => slackOnly(), secrets: r.secrets.store, resolve: r.resolver.resolve, http: r.http.transport, audit: r.audit.sink, deadLetters: { put: () => { throw new Error('disk CANARY'); } }, clock: r.clock, sleep: r.sleeper.sleep, random: () => 0, egressEnabled: () => true });
    const res = await d.dispatch(rawEvent(), actor);
    expect(res.results[0]).toMatchObject({ status: 'failed', deadLettered: false });
    expect(r.audit.records.at(-1)).toMatchObject({ outcome: 'failed', code: 'dead_letter_failed' });
    expect(secretsAbsent(r.audit.records)).toBe(true);
  });
});

describe('audit hygiene and secrets', () => {
  const scenarios: Array<[string, RigOptions]> = [
    ['success', {}],
    ['server error', { httpHandler: () => ({ status: 500, bodyBytes: 9 }), options: { maxAttempts: 2 } }],
    ['redirect to private', { httpHandler: () => ({ status: 302, bodyBytes: 0 }) }],
    ['ssrf private DNS', { resolverTable: { 'hooks.slack.com': ['10.0.0.1'], 'alerts.customer.example': ['169.254.169.254'] } }],
    ['transport throws URL', { httpHandler: () => { throw new Error(`failed ${SLACK_URL} ${WEBHOOK_URL} ${SIGNING_SECRET}`); }, options: { maxAttempts: 2 } }],
    ['secret store throws', { secretValues: { 'notify/slack-main': new Error(SLACK_URL), 'notify/hook-url': new Error(WEBHOOK_URL), 'notify/hook-secret': new Error(SIGNING_SECRET) }, options: { maxAttempts: 2 } }],
    ['secret URL is private', { secretValues: { 'notify/slack-main': 'https://127.0.0.1/CANARY', 'notify/hook-url': 'https://[::1]/CANARY', 'notify/hook-secret': SIGNING_SECRET } }],
    ['mail transport throws', { mailHandler: () => { throw new Error('smtp password=CANARY'); } }],
  ];
  it.each(scenarios)('%s: no secret appears in results, audit records, dead letters or the thrown surface', async (_n, opts) => {
    const r = makeRig(opts);
    const res = await r.dispatcher.dispatch(rawEvent(), actor);
    expect(secretsAbsent(res)).toBe(true);
    expect(secretsAbsent(r.audit.records)).toBe(true);
    expect(secretsAbsent(r.dlq.list().map((d) => ({ ...d, event: undefined })))).toBe(true);
    for (const a of r.audit.records) expect(Object.keys(a).every((k) => ['at', 'tenant', 'actor', 'outcome', 'code', 'channelId', 'channelKind', 'dedupeKey', 'severity', 'attempt', 'host', 'httpStatus', 'detail', 'latencyMs'].includes(k))).toBe(true);
    for (const x of everything(r)) expect(JSON.stringify(x)).not.toMatch(/\?token|\/services\/|whsec_/);
  });
  it('audit records name the acting subject, only the host of a URL, and latency from the injected clock', async () => {
    const r = makeRig({ config: slackOnly(), httpHandler: () => { r.clock.advance(42); return { status: 200, bodyBytes: 0 }; } });
    await r.dispatcher.dispatch(rawEvent(), { actor: 'user:alice@acme' });
    const rec = r.audit.records.find((a) => a.outcome === 'delivered');
    expect(rec).toMatchObject({ actor: 'user:alice@acme', host: 'hooks.slack.com', httpStatus: 200, latencyMs: 42, attempt: 1, channelKind: 'slack', at: T0 + 42 });
    expect(r.audit.records.every((a) => a.actor === 'user:alice@acme')).toBe(true);
  });
  it('delivery results contain no response body fields', async () => {
    const r = makeRig({ config: slackOnly(), httpHandler: () => ({ status: 500, bodyBytes: 5, body: 'CANARY secret response' } as never), options: { maxAttempts: 1 } });
    const res = await r.dispatcher.dispatch(rawEvent(), actor);
    expect(Object.keys(res.results[0]).sort()).toEqual(['attempts', 'channelId', 'code', 'deadLettered', 'httpStatus', 'kind', 'status']);
  });
  it('an audit sink that starts failing mid-delivery stops retries (fail closed)', async () => {
    const r = makeRig({ config: slackOnly(), httpHandler: fail500, auditFailAfter: 2, options: { maxAttempts: 5 } });
    await r.dispatcher.dispatch(rawEvent(), actor);
    expect(r.http.requests.length).toBeLessThan(5);
  });
});

describe('oversized payloads', () => {
  it('a maximal event is truncated for Slack and email, not refused', async () => {
    const big = rawEvent({ title: 'T'.repeat(200), body: '<&>'.repeat(1333), resources: Array.from({ length: 20 }, (_, i) => ({ kind: 'workload', id: `r${i}`.padEnd(150, 'x'), label: 'L'.repeat(100) })) });
    const r = makeRig({});
    const res = await r.dispatcher.dispatch(big, actor);
    expect(res.results.every((x) => x.status === 'delivered')).toBe(true);
    const body = JSON.parse(r.http.requests[0].body);
    for (const b of body.blocks) expect((b.text?.text ?? '').length).toBeLessThanOrEqual(3000);
    expect(r.mail.sent[0].raw.length).toBeLessThan(131_072);
  });
});

describe('config parser', () => {
  const ch = { id: 'a', kind: 'slack', enabled: true, severities: ['info'], urlHandle: 'notify/x' };
  const code = (c: unknown) => { const p = parseTenantNotifyConfig(c); return p.ok ? 'ok' : p.code; };
  it('accepts a full config and defaults enabled to false', () => {
    expect(code(rawConfig())).toBe('ok');
    const p = parseTenantNotifyConfig({ tenant: 't', channels: [{ ...ch, enabled: undefined }] });
    expect(p.ok && p.config.channels[0].enabled).toBe(false);
  });
  it('caps channels, hosts, ports and recipients at and past the limit', () => {
    const chans = (n: number) => Array.from({ length: n }, (_, i) => ({ ...ch, id: `c${i}` }));
    expect(code({ tenant: 't', channels: chans(CONFIG_LIMITS.channels) })).toBe('ok');
    expect(code({ tenant: 't', channels: chans(CONFIG_LIMITS.channels + 1) })).toBe('too_many_channels');
    const hosts = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.example.com`);
    expect(code({ tenant: 't', allowedHosts: hosts(50) })).toBe('ok'); expect(code({ tenant: 't', allowedHosts: hosts(51) })).toBe('too_many_hosts');
    expect(code({ tenant: 't', allowedPorts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })).toBe('ok'); expect(code({ tenant: 't', allowedPorts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] })).toBe('too_many_ports');
    const mail = (n: number) => ({ id: 'm', kind: 'email', severities: ['info'], from: 'a@b.example', to: Array.from({ length: n }, (_, i) => `u${i}@b.example`) });
    expect(code({ tenant: 't', channels: [mail(20)] })).toBe('ok'); expect(code({ tenant: 't', channels: [mail(21)] })).toBe('too_many_recipients');
  });
  it('refuses unknown fields, duplicates, bad hosts, ports, handles and severities', () => {
    expect(code({ tenant: 't', extra: 1 })).toBe('unknown_field');
    expect(code({ tenant: 't', channels: [{ ...ch, url: 'https://x' }] })).toBe('unknown_field');
    expect(code({ tenant: 't', channels: [ch, ch] })).toBe('duplicate_channel_id');
    for (const h of ['*', '127.0.0.1', 'localhost', 'a.local', 5]) expect(code({ tenant: 't', allowedHosts: [h] })).toBe('hosts_invalid');
    for (const p of [0, 65536, 1.5, '443']) expect(code({ tenant: 't', allowedPorts: [p] })).toBe('ports_invalid');
    for (const h of ['https://hooks.slack.com/x', 'Has Space', '', '../x']) expect(code({ tenant: 't', channels: [{ ...ch, urlHandle: h }] })).toBe('handle_invalid');
    for (const s of [[], ['urgent'], ['info', 'info'], 'info']) expect(code({ tenant: 't', channels: [{ ...ch, severities: s }] })).toBe('channel_invalid');
    expect(code({ tenant: 'bad tenant!' })).toBe('tenant_invalid'); expect(code(null)).toBe('malformed');
  });
});

describe('secret resolution', () => {
  it('validates handles and values, returns fixed codes', async () => {
    const s = makeSecrets({ 'good/handle': 'https://hooks.slack.com/x', 'bad/url': 'https://a.example/\n', 'short/key': 'short', 'ok/key': 'a-sufficiently-long-key', 'boom/h': new Error('CANARY') });
    expect(await resolveSecret(s.store, 't', 'good/handle', 'url')).toEqual({ ok: true, value: 'https://hooks.slack.com/x' });
    expect(await resolveSecret(s.store, 't', 'ok/key', 'signing')).toMatchObject({ ok: true });
    expect(await resolveSecret(s.store, 't', 'short/key', 'signing')).toEqual({ ok: false, code: 'secret_invalid' });
    expect(await resolveSecret(s.store, 't', 'bad/url', 'url')).toEqual({ ok: false, code: 'secret_invalid' });
    expect(await resolveSecret(s.store, 't', 'nope', 'url')).toEqual({ ok: false, code: 'secret_missing' });
    expect(await resolveSecret(s.store, 't', 'boom/h', 'url')).toEqual({ ok: false, code: 'secret_unavailable' });
    expect(await resolveSecret(s.store, 't', 'https://hooks.slack.com/real-secret', 'url')).toEqual({ ok: false, code: 'secret_handle_invalid' });
    expect(HANDLE_RE.test('Has Upper')).toBe(false);
    expect(s.reads.map((x) => x.handle)).not.toContain('https://hooks.slack.com/real-secret');
  });
  it('hostOnly drops everything but the host', () => {
    expect(hostOnly('https://user:pw@Hooks.Slack.com:8443/services/T/B/x?token=1#f')).toBe('hooks.slack.com');
    expect(hostOnly('nonsense')).toBe('[invalid-host]'); expect(hostOnly(5)).toBe('[invalid-host]');
  });
});

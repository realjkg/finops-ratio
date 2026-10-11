// Test support for src/notify/: deterministic fakes for every injected seam.
// Imported only by *.test.ts files. No network, no real time, no randomness.
// The canary strings below stand in for real secrets; secretsAbsent() asserts
// that none of them leaks into an error, audit record, result or dead letter.

import { InMemoryDeadLetters } from './deadLetters';
import { createDispatcher, type AlertDispatcher, type DispatcherOptions } from './dispatcher';
import type {
  AuditRecord,
  AuditSink,
  DnsResolver,
  HttpTransport,
  MailEnvelope,
  MailResult,
  MailTransport,
  PinnedHttpRequest,
  PinnedHttpResponse,
  SecretStore,
  Sleep,
} from './types';

export const SLACK_URL = ['https://hooks.slack', '.com/services/T0CANARY/B0CANARY/', 'xoxCANARYslacksecret'].join('');
export const WEBHOOK_URL = 'https://alerts.customer.example/ratio/hook?token=CANARYTOKEN987';
export const SIGNING_SECRET = 'whsec_CANARY_0123456789abcdef';
export const PUBLIC_IP = '93.184.216.34';
export const PUBLIC_IP_2 = '34.120.54.55';

export const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

export function makeClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
}
export type FakeClock = ReturnType<typeof makeClock>;

/**
 * Sleep fake. A call WITHOUT a signal is a backoff sleep: it is recorded,
 * advances the fake clock and resolves at once. A call WITH a signal is a
 * timeout timer: it stays pending until `fireTimers()` or until the signal
 * aborts, so it never wins a race by accident.
 */
export function makeSleep(clock: FakeClock) {
  const delays: number[] = [];
  const timers: Array<{ ms: number; fire: () => void }> = [];
  const sleep: Sleep = (ms, signal) => {
    if (!signal) {
      delays.push(ms);
      clock.advance(ms);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const fire = () => resolve();
      timers.push({ ms, fire });
      signal.addEventListener('abort', fire, { once: true });
    });
  };
  return {
    sleep,
    delays,
    timers,
    fireTimers() {
      for (const t of timers) t.fire();
    },
  };
}
export type FakeSleep = ReturnType<typeof makeSleep>;

/** Let pending promise callbacks run (real microtask/macrotask turn, no timers involved). */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export type ResolverAnswer = readonly string[] | Error | (() => readonly string[]);

export function makeResolver(table: Record<string, ResolverAnswer | ResolverAnswer[]>) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const resolve: DnsResolver = async (hostname) => {
    calls.push(hostname);
    const n = counts.get(hostname) ?? 0;
    counts.set(hostname, n + 1);
    const entry = table[hostname];
    if (entry === undefined) throw new Error('NXDOMAIN');
    // An array of arrays/answers is a sequence: the n-th call gets the n-th answer (last one repeats).
    const answer: ResolverAnswer = Array.isArray(entry) && entry.length > 0 && typeof entry[0] !== 'string'
      ? (entry as ResolverAnswer[])[Math.min(n, entry.length - 1)]
      : (entry as ResolverAnswer);
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer() : answer;
  };
  return { resolve, calls };
}

export function makeSecrets(values: Record<string, string | Error>) {
  const reads: Array<{ tenant: string; handle: string }> = [];
  const store: SecretStore = {
    async get(tenant, handle) {
      reads.push({ tenant, handle });
      const v = values[`${tenant}/${handle}`] ?? values[handle];
      if (v instanceof Error) throw v;
      return v;
    },
  };
  return { store, reads };
}

export type HttpHandler = (req: PinnedHttpRequest, n: number) => PinnedHttpResponse | Promise<PinnedHttpResponse> | never;

export function makeHttp(handler: HttpHandler = () => ({ status: 200, bodyBytes: 2 })) {
  const requests: PinnedHttpRequest[] = [];
  const transport: HttpTransport = async (req) => {
    requests.push(req);
    return handler(req, requests.length);
  };
  return { transport, requests };
}

export function makeMail(handler: (msg: MailEnvelope, n: number) => MailResult | Promise<MailResult> = () => ({ accepted: true })) {
  const sent: MailEnvelope[] = [];
  const transport: MailTransport = async (msg) => {
    sent.push(msg);
    return handler(msg, sent.length);
  };
  return { transport, sent };
}

export function makeAudit(failAfter?: number) {
  const records: AuditRecord[] = [];
  const sink: AuditSink = {
    record(rec) {
      if (failAfter !== undefined && records.length >= failAfter) throw new Error('audit down CANARY');
      records.push(rec);
    },
  };
  return { sink, records };
}

/** A valid raw alert event (untrusted-input shape). */
export function rawEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant: 'acme',
    dedupeKey: 'budget_hard:wl-001:2026-06',
    severity: 'critical',
    title: 'Budget hard threshold crossed',
    body: 'Workload wl-001 reached 91% of its monthly budget.',
    occurredAt: '2026-06-01T11:59:00.000Z',
    resources: [{ kind: 'workload', id: 'wl-001', label: 'Support bot' }],
    links: [{ label: 'Open in Ratio', url: 'https://ratio.example.com/findings/f-1' }],
    ...overrides,
  };
}

/** A valid raw tenant config with one channel of each kind, all enabled. */
export function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant: 'acme',
    allowedHosts: ['hooks.slack.com', 'alerts.customer.example'],
    allowedPorts: [],
    channels: [
      { id: 'slack-main', kind: 'slack', enabled: true, severities: ['info', 'warning', 'critical'], urlHandle: 'notify/slack-main' },
      {
        id: 'hook-main',
        kind: 'webhook',
        enabled: true,
        severities: ['warning', 'critical'],
        urlHandle: 'notify/hook-url',
        secretHandle: 'notify/hook-secret',
      },
      { id: 'mail-main', kind: 'email', enabled: true, severities: ['critical'], from: 'alerts@ratio.example.com', fromName: 'Ratio Alerts', to: ['owner@acme.example'] },
    ],
    ...overrides,
  };
}

export interface Rig {
  readonly dispatcher: AlertDispatcher;
  readonly clock: FakeClock;
  readonly sleeper: FakeSleep;
  readonly http: ReturnType<typeof makeHttp>;
  readonly mail: ReturnType<typeof makeMail>;
  readonly resolver: ReturnType<typeof makeResolver>;
  readonly secrets: ReturnType<typeof makeSecrets>;
  readonly audit: ReturnType<typeof makeAudit>;
  readonly dlq: InMemoryDeadLetters;
  readonly flag: { on: boolean };
  readonly randoms: number[];
  readonly configCalls: string[];
}

export interface RigOptions {
  config?: unknown;
  httpHandler?: HttpHandler;
  mailHandler?: Parameters<typeof makeMail>[0];
  resolverTable?: Record<string, ResolverAnswer | ResolverAnswer[]>;
  secretValues?: Record<string, string | Error>;
  options?: DispatcherOptions;
  egress?: boolean;
  auditFailAfter?: number;
  random?: () => number;
  noMail?: boolean;
}

export function makeRig(o: RigOptions = {}): Rig {
  const clock = makeClock();
  const sleeper = makeSleep(clock);
  const http = makeHttp(o.httpHandler);
  const mail = makeMail(o.mailHandler);
  const resolver = makeResolver(o.resolverTable ?? { 'hooks.slack.com': [PUBLIC_IP], 'alerts.customer.example': [PUBLIC_IP_2] });
  const secrets = makeSecrets(
    o.secretValues ?? {
      'notify/slack-main': SLACK_URL,
      'notify/hook-url': WEBHOOK_URL,
      'notify/hook-secret': SIGNING_SECRET,
    },
  );
  const audit = makeAudit(o.auditFailAfter);
  const dlq = new InMemoryDeadLetters();
  const flag = { on: o.egress ?? true };
  const randoms: number[] = [];
  const configCalls: string[] = [];
  const config = o.config === undefined ? rawConfig() : o.config;
  const dispatcher = createDispatcher({
    getTenantConfig: (tenant) => {
      configCalls.push(tenant);
      return config;
    },
    secrets: secrets.store,
    resolve: resolver.resolve,
    http: http.transport,
    mail: o.noMail ? undefined : mail.transport,
    audit: audit.sink,
    deadLetters: dlq,
    clock,
    sleep: sleeper.sleep,
    random: () => {
      const r = (o.random ?? (() => 0.5))();
      randoms.push(r);
      return r;
    },
    egressEnabled: () => flag.on,
    options: o.options,
  });
  return { dispatcher, clock, sleeper, http, mail, resolver, secrets, audit, dlq, flag, randoms, configCalls };
}

/** True when no canary secret fragment appears anywhere in `value`'s JSON form. */
export function secretsAbsent(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => (v instanceof Error ? `${v.name}:${v.message}` : v));
  return !/CANARY|\/services\/|token=|xox/i.test(text ?? '');
}

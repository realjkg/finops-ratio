// SSRF guard: URL syntax, ports, host names, IP literals in every spelling,
// the per-tenant allowlist, DNS re-check, rebinding, pinning and timeouts.

import { describe, it, expect } from 'vitest';
import {
  MAX_DNS_ANSWERS,
  guardOutboundUrl,
  hostMatchesAllowlist,
  normalizeAllowlistEntry,
  normalizeHostName,
  raceTimeout,
  type EgressPolicy,
  type GuardResult,
  type SsrfCode,
} from './ssrf';
import { PUBLIC_IP, PUBLIC_IP_2, flush, makeClock, makeResolver, makeSleep, type ResolverAnswer } from './testKit';

function rig(table: Record<string, ResolverAnswer | ResolverAnswer[]> = { 'hooks.slack.com': [PUBLIC_IP] }) {
  const clock = makeClock();
  const sleeper = makeSleep(clock);
  const resolver = makeResolver(table);
  const guard = (url: unknown, policy: EgressPolicy = {}): Promise<GuardResult> =>
    guardOutboundUrl(url, policy, { resolve: resolver.resolve, sleep: sleeper.sleep });
  return { guard, resolver, sleeper };
}

async function codeFor(url: unknown, policy: EgressPolicy = {}, table?: Record<string, ResolverAnswer | ResolverAnswer[]>): Promise<SsrfCode | 'ok'> {
  const r = rig(table);
  const res = await r.guard(url, policy);
  return res.ok ? 'ok' : res.code;
}

describe('guardOutboundUrl: accepted target', () => {
  it('approves a public https URL and pins the checked address', async () => {
    const r = rig({ 'hooks.slack.com': [PUBLIC_IP, PUBLIC_IP_2] });
    const res = await r.guard('https://hooks.slack.com/services/T1/B1/xyz?x=1#frag');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.target.hostname).toBe('hooks.slack.com');
    expect(res.target.port).toBe(443);
    expect(res.target.address).toBe(PUBLIC_IP);
    expect(res.target.family).toBe(4);
    expect(res.target.addresses).toEqual([PUBLIC_IP, PUBLIC_IP_2]);
    expect(res.target.href).toBe('https://hooks.slack.com/services/T1/B1/xyz?x=1');
    expect(r.resolver.calls).toEqual(['hooks.slack.com']);
  });

  it('pins an IPv6 answer and reports its family', async () => {
    const r = rig({ 'hooks.slack.com': ['2606:4700:4700:0:0:0:0:1111'] });
    const res = await r.guard('https://hooks.slack.com/x');
    expect(res.ok && res.target.address).toBe('2606:4700:4700::1111');
    expect(res.ok && res.target.family).toBe(6);
  });

  it('lower-cases the host, handles a trailing dot and an explicit default port', async () => {
    const r = rig({ 'hooks.slack.com': [PUBLIC_IP] });
    const res = await r.guard('https://HOOKS.Slack.COM.:443/x');
    expect(res.ok && res.target.hostname).toBe('hooks.slack.com');
    expect(res.ok && res.target.port).toBe(443);
  });
});

describe('guardOutboundUrl: scheme, userinfo and syntax', () => {
  it.each([
    ['http://hooks.slack.com/x', 'scheme_not_https'],
    ['ftp://hooks.slack.com/x', 'scheme_not_https'],
    ['file:///etc/passwd', 'scheme_not_https'],
    ['gopher://hooks.slack.com/', 'scheme_not_https'],
    ['wss://hooks.slack.com/', 'scheme_not_https'],
    ['javascript:alert(1)', 'scheme_not_https'],
    ['data:text/plain,hi', 'scheme_not_https'],
    ['HTTP://hooks.slack.com/x', 'scheme_not_https'],
  ] as const)('refuses %s', async (url, code) => {
    expect(await codeFor(url)).toBe(code);
  });

  it.each([
    'https://user@hooks.slack.com/x',
    'https://user:pass@hooks.slack.com/x',
    'https://:pass@hooks.slack.com/x',
    'https://hooks.slack.com:pw@hooks.slack.com/x',
  ])('refuses userinfo in %s', async (url) => {
    expect(await codeFor(url)).toBe('userinfo_present');
  });

  it('refuses the userinfo trick that hides a private target behind a public name', async () => {
    expect(await codeFor('https://hooks.slack.com@127.0.0.1/x')).toBe('userinfo_present');
    expect(await codeFor('https://hooks.slack.com%40127.0.0.1/x')).toBe('url_invalid');
  });

  it.each([
    ['not a url'],
    [''],
    ['https://'],
    ['//hooks.slack.com/x'],
    ['/x'],
    ['https://hooks.slack.com/a b'],
    ['https://hooks.slack.com/é'],
    ['https://hooks.slack.com\\@127.0.0.1/'],
    ['https://hooks.slack.com/\nHost: evil'],
    ['https://hooks.slack.com/\u0000'],
    ['https://hooks.slack.com/\t'],
    [' https://hooks.slack.com/x'],
    ['https://hooks.slack.com/x '],
    [null],
    [undefined],
    [42],
    [{ toString: () => 'https://hooks.slack.com/' }],
  ])('refuses malformed input %j', async (url) => {
    expect(await codeFor(url)).toBe('url_invalid');
  });

  it('accepts a URL of exactly 2048 characters and refuses 2049', async () => {
    const base = 'https://hooks.slack.com/';
    expect(await codeFor(base + 'a'.repeat(2048 - base.length))).toBe('ok');
    expect(await codeFor(base + 'a'.repeat(2049 - base.length))).toBe('url_too_long');
  });

  it('honors a smaller maxUrlChars', async () => {
    expect(await codeFor('https://hooks.slack.com/' + 'a'.repeat(100), { maxUrlChars: 50 })).toBe('url_too_long');
  });
});

describe('guardOutboundUrl: ports', () => {
  it.each([22, 23, 25, 110, 143, 445, 1433, 2375, 3306, 5432, 6379, 8080, 8443, 9200, 11211, 27017, 80, 1, 65535])(
    'refuses port %i by default',
    async (port) => {
      expect(await codeFor(`https://hooks.slack.com:${port}/x`)).toBe('port_denied');
    },
  );

  it('allows a port only when the tenant allowlisted it', async () => {
    expect(await codeFor('https://hooks.slack.com:8443/x', { allowedPorts: [8443] })).toBe('ok');
    expect(await codeFor('https://hooks.slack.com:8443/x', { allowedPorts: [9443] })).toBe('port_denied');
    expect(await codeFor('https://hooks.slack.com:6379/x', { allowedPorts: [8443] })).toBe('port_denied');
  });

  it('reports the allowlisted port on the pinned target', async () => {
    const r = rig();
    const res = await r.guard('https://hooks.slack.com:8443/x', { allowedPorts: [8443] });
    expect(res.ok && res.target.port).toBe(8443);
  });

  it('refuses an out-of-range port as an invalid URL', async () => {
    expect(await codeFor('https://hooks.slack.com:65536/x')).toBe('url_invalid');
    expect(await codeFor('https://hooks.slack.com:0/x', { allowedPorts: [0] })).toBe('port_denied');
  });
});

describe('guardOutboundUrl: IP literals in every spelling', () => {
  const allowAll: EgressPolicy = {}; // no allowlist: the IP checks alone must stop these

  it.each([
    ['https://127.0.0.1/x', 'blocked_loopback'],
    ['https://127.0.0.1:443/x', 'blocked_loopback'],
    ['https://127.255.255.254/x', 'blocked_loopback'],
    ['https://[::1]/x', 'blocked_loopback'],
    ['https://[0:0:0:0:0:0:0:1]/x', 'blocked_loopback'],
    ['https://169.254.169.254/latest/meta-data/', 'blocked_metadata'],
    ['https://169.254.1.1/x', 'blocked_link_local'],
    ['https://10.0.0.1/x', 'blocked_private'],
    ['https://10.255.255.255/x', 'blocked_private'],
    ['https://172.16.0.1/x', 'blocked_private'],
    ['https://172.31.255.255/x', 'blocked_private'],
    ['https://192.168.1.1/x', 'blocked_private'],
    ['https://[fc00::1]/x', 'blocked_unique_local'],
    ['https://[fd12:3456::1]/x', 'blocked_unique_local'],
    ['https://[fe80::1]/x', 'blocked_link_local'],
    ['https://[::ffff:127.0.0.1]/x', 'blocked_loopback'],
    ['https://[::ffff:7f00:1]/x', 'blocked_loopback'],
    ['https://[::ffff:10.0.0.1]/x', 'blocked_private'],
    ['https://[::ffff:169.254.169.254]/x', 'blocked_metadata'],
    ['https://[::]/x', 'blocked_unspecified'],
    ['https://0.0.0.0/x', 'blocked_unspecified'],
    ['https://224.0.0.1/x', 'blocked_multicast'],
    ['https://[ff02::1]/x', 'blocked_multicast'],
    ['https://100.64.0.1/x', 'blocked_carrier_nat'],
    ['https://100.100.100.200/x', 'blocked_metadata'],
    ['https://[fd00:ec2::254]/x', 'blocked_metadata'],
    // decimal, hex, octal and short spellings of loopback and metadata
    ['https://2130706433/x', 'blocked_loopback'],
    ['https://0x7f.1/x', 'blocked_loopback'],
    ['https://0x7f000001/x', 'blocked_loopback'],
    ['https://017700000001/x', 'blocked_loopback'],
    ['https://0177.0.0.1/x', 'blocked_loopback'],
    ['https://127.1/x', 'blocked_loopback'],
    ['https://2852039166/x', 'blocked_metadata'],
    ['https://0xa9fea9fe/x', 'blocked_metadata'],
    ['https://0251.0376.0251.0376/x', 'blocked_metadata'],
    ['https://167772161/x', 'blocked_private'],
    ['https://3232235777/x', 'blocked_private'],
  ] as const)('%s -> %s', async (url, code) => {
    const r = rig({});
    const res = await r.guard(url, allowAll);
    expect(res).toEqual({ ok: false, code });
    expect(r.resolver.calls).toEqual([]); // never resolved
  });

  it('refuses even a PUBLIC IP literal (webhooks must use DNS names)', async () => {
    expect(await codeFor('https://8.8.8.8/x')).toBe('ip_literal_denied');
    expect(await codeFor('https://[2606:4700:4700::1111]/x')).toBe('ip_literal_denied');
    expect(await codeFor('https://134744072/x')).toBe('ip_literal_denied'); // 8.8.8.8 as a decimal
  });

  it('refuses malformed numeric hosts', async () => {
    expect(await codeFor('https://1.2.3.4.5/x')).toBe('url_invalid');
    expect(await codeFor('https://999.1.1.1/x')).toBe('url_invalid');
  });
});

describe('guardOutboundUrl: host names', () => {
  it.each([
    'https://localhost/x',
    'https://LOCALHOST/x',
    'https://localhost./x',
    'https://app.localhost/x',
    'https://printer.local/x',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://svc.cluster.internal/x',
    'https://db.corp/x',
    'https://nas.lan/x',
    'https://router.home.arpa/x',
    'https://1.0.0.127.in-addr.arpa/x',
    'https://host.localdomain/x',
  ])('blocks the local-namespace name in %s', async (url) => {
    expect(await codeFor(url, {}, {})).toBe('host_blocked_name');
  });

  it('refuses single-label names (they resolve through search domains)', async () => {
    expect(await codeFor('https://intranet/x', {}, {})).toBe('host_blocked_name');
    expect(await codeFor('https://metadata/x', {}, {})).toBe('host_invalid');
    expect(await codeFor('https://redis/x', {}, {})).toBe('host_invalid');
  });

  it('refuses names with characters outside the host grammar', async () => {
    expect(await codeFor('https://under_score.example.com/x', {}, {})).toBe('host_invalid');
    expect(await codeFor('https://a..b.example.com/x', {}, {})).toBe('host_invalid');
    expect(await codeFor('https:///evil/x', {}, {})).toBe('host_invalid'); // parses as host "evil": single label
  });

  it('normalizeHostName rejects bad labels and lengths', () => {
    expect(normalizeHostName('Example.COM')).toBe('example.com');
    expect(normalizeHostName('example.com.')).toBe('example.com');
    expect(normalizeHostName('example')).toBeNull();
    expect(normalizeHostName('-a.example.com')).toBeNull();
    expect(normalizeHostName('a-.example.com')).toBeNull();
    expect(normalizeHostName(`${'a'.repeat(64)}.example.com`)).toBeNull();
    expect(normalizeHostName(`${'a'.repeat(63)}.example.com`)).not.toBeNull();
    expect(normalizeHostName(`${'a.'.repeat(130)}com`)).toBeNull();
    expect(normalizeHostName('')).toBeNull();
  });
});

describe('guardOutboundUrl: per-tenant host allowlist', () => {
  const table = {
    'hooks.slack.com': [PUBLIC_IP],
    'a.example.com': [PUBLIC_IP],
    'x.y.example.com': [PUBLIC_IP],
    'example.com': [PUBLIC_IP],
    'evilexample.com': [PUBLIC_IP],
  };

  it('allows an exact entry and refuses everything else', async () => {
    const policy = { allowedHosts: ['hooks.slack.com'] };
    expect(await codeFor('https://hooks.slack.com/x', policy, table)).toBe('ok');
    expect(await codeFor('https://a.example.com/x', policy, table)).toBe('host_not_allowed');
  });

  it('matches case-insensitively', async () => {
    expect(await codeFor('https://hooks.slack.com/x', { allowedHosts: ['HOOKS.Slack.com'] }, table)).toBe('ok');
  });

  it('a wildcard matches subdomains at any depth but not the apex or a look-alike', async () => {
    const policy = { allowedHosts: ['*.example.com'] };
    expect(await codeFor('https://a.example.com/x', policy, table)).toBe('ok');
    expect(await codeFor('https://x.y.example.com/x', policy, table)).toBe('ok');
    expect(await codeFor('https://example.com/x', policy, table)).toBe('host_not_allowed');
    expect(await codeFor('https://evilexample.com/x', policy, table)).toBe('host_not_allowed');
  });

  it('an empty allowlist allows no host; an absent allowlist applies no host restriction', async () => {
    expect(await codeFor('https://hooks.slack.com/x', { allowedHosts: [] }, table)).toBe('host_not_allowed');
    expect(await codeFor('https://hooks.slack.com/x', {}, table)).toBe('ok');
  });

  it('an invalid allowlist entry never matches', async () => {
    const policy = { allowedHosts: ['*', '*.', '', 'com', '*.com.', '127.0.0.1', 'localhost'] as string[] };
    expect(await codeFor('https://hooks.slack.com/x', policy, table)).toBe('host_not_allowed');
  });

  it('checks the allowlist BEFORE resolving, so a refused host is never looked up', async () => {
    const r = rig(table);
    expect(await r.guard('https://a.example.com/x', { allowedHosts: ['hooks.slack.com'] })).toEqual({ ok: false, code: 'host_not_allowed' });
    expect(r.resolver.calls).toEqual([]);
  });

  it('the allowlist does not bypass the IP checks', async () => {
    expect(await codeFor('https://127.0.0.1/x', { allowedHosts: ['127.0.0.1'] })).toBe('blocked_loopback');
    expect(await codeFor('https://hooks.slack.com/x', { allowedHosts: ['hooks.slack.com'] }, { 'hooks.slack.com': ['10.0.0.5'] })).toBe('blocked_private');
  });

  it('helpers normalize and match entries', () => {
    expect(normalizeAllowlistEntry('*.Example.com')).toBe('*.example.com');
    expect(normalizeAllowlistEntry('*.localhost')).toBeNull();
    expect(normalizeAllowlistEntry(5)).toBeNull();
    expect(hostMatchesAllowlist('a.example.com', ['*.example.com'])).toBe(true);
    expect(hostMatchesAllowlist('example.com', ['*.example.com'])).toBe(false);
  });
});

describe('guardOutboundUrl: DNS re-check and pinning', () => {
  it('refuses a name that resolves to loopback (wildcard-DNS names such as 127.0.0.1.nip.io)', async () => {
    expect(await codeFor('https://127.0.0.1.nip.io/x', {}, { '127.0.0.1.nip.io': ['127.0.0.1'] })).toBe('blocked_loopback');
  });

  it.each([
    ['10.1.2.3', 'blocked_private'],
    ['172.20.0.9', 'blocked_private'],
    ['192.168.0.10', 'blocked_private'],
    ['169.254.169.254', 'blocked_metadata'],
    ['::1', 'blocked_loopback'],
    ['fc00::5', 'blocked_unique_local'],
    ['fe80::5', 'blocked_link_local'],
    ['::ffff:127.0.0.1', 'blocked_loopback'],
    ['0.0.0.0', 'blocked_unspecified'],
    ['224.0.0.5', 'blocked_multicast'],
  ] as const)('refuses a name that resolves to %s', async (ip, code) => {
    expect(await codeFor('https://hooks.slack.com/x', {}, { 'hooks.slack.com': [ip] })).toBe(code);
  });

  it('refuses when ANY answer is private, even if the first is public', async () => {
    expect(await codeFor('https://hooks.slack.com/x', {}, { 'hooks.slack.com': [PUBLIC_IP, '10.0.0.1'] })).toBe('blocked_private');
    expect(await codeFor('https://hooks.slack.com/x', {}, { 'hooks.slack.com': ['10.0.0.1', PUBLIC_IP] })).toBe('blocked_private');
  });

  it('DNS rebinding: a second resolution that returns a private address is refused', async () => {
    const r = rig({ 'hooks.slack.com': [[PUBLIC_IP], ['169.254.169.254']] });
    const first = await r.guard('https://hooks.slack.com/x');
    expect(first.ok).toBe(true);
    const second = await r.guard('https://hooks.slack.com/x');
    expect(second).toEqual({ ok: false, code: 'blocked_metadata' });
    expect(r.resolver.calls).toHaveLength(2);
  });

  it('pinning: the target carries the FIRST checked answer, and one guard call resolves once', async () => {
    const r = rig({ 'hooks.slack.com': [[PUBLIC_IP], ['127.0.0.1']] });
    const res = await r.guard('https://hooks.slack.com/x');
    expect(res.ok && res.target.address).toBe(PUBLIC_IP);
    expect(r.resolver.calls).toEqual(['hooks.slack.com']); // a transport that connects to target.address never needs a second lookup
  });

  it('refuses unparseable, empty, oversized and non-array answers', async () => {
    expect(await codeFor('https://hooks.slack.com/x', {}, { 'hooks.slack.com': ['not-an-ip'] })).toBe('dns_invalid_answer');
    expect(await codeFor('https://hooks.slack.com/x', {}, { 'hooks.slack.com': ['hooks.slack.com'] })).toBe('dns_invalid_answer');
    expect(await codeFor('https://hooks.slack.com/x', {}, { 'hooks.slack.com': ['0x7f.1'] })).toBe('dns_invalid_answer');
    expect(await codeFor('https://hooks.slack.com/x', {}, { 'hooks.slack.com': [] })).toBe('dns_empty');
    expect(await codeFor('https://hooks.slack.com/x', {}, { 'hooks.slack.com': () => 'oops' as unknown as string[] })).toBe('dns_invalid_answer');
    const many = Array.from({ length: MAX_DNS_ANSWERS + 1 }, (_, i) => `93.184.216.${i + 1}`);
    expect(await codeFor('https://hooks.slack.com/x', {}, { 'hooks.slack.com': many })).toBe('dns_too_many');
    expect(await codeFor('https://hooks.slack.com/x', {}, { 'hooks.slack.com': many.slice(0, MAX_DNS_ANSWERS) })).toBe('ok');
  });

  it('maps a resolver error to a fixed code without echoing its message', async () => {
    const r = rig({ 'hooks.slack.com': new Error('SERVFAIL for hooks.slack.com secret=CANARY') });
    const res = await r.guard('https://hooks.slack.com/x');
    expect(res).toEqual({ ok: false, code: 'dns_failed' });
    expect(JSON.stringify(res)).not.toContain('CANARY');
  });

  it('times out a hung resolver on the injected sleep', async () => {
    const clock = makeClock();
    const sleeper = makeSleep(clock);
    const pending = guardOutboundUrl(
      'https://hooks.slack.com/x',
      { dnsTimeoutMs: 1000 },
      { resolve: () => new Promise<string[]>(() => undefined), sleep: sleeper.sleep },
    );
    await flush();
    expect(sleeper.timers.map((t) => t.ms)).toEqual([1000]);
    sleeper.fireTimers();
    expect(await pending).toEqual({ ok: false, code: 'dns_timeout' });
  });

  it('a resolver that answers in time cancels the timer', async () => {
    const r = rig();
    await r.guard('https://hooks.slack.com/x');
    expect(r.sleeper.timers).toHaveLength(1); // created, then aborted by the guard
  });
});

describe('raceTimeout', () => {
  it('returns the value when the work finishes first and propagates rejection', async () => {
    const clock = makeClock();
    const sleeper = makeSleep(clock);
    expect(await raceTimeout(Promise.resolve(7), 50, sleeper.sleep)).toEqual({ timedOut: false, value: 7 });
    await expect(raceTimeout(Promise.reject(new Error('x')), 50, sleeper.sleep)).rejects.toThrow('x');
  });

  it('reports a timeout without leaving an unhandled rejection from the late work', async () => {
    const clock = makeClock();
    const sleeper = makeSleep(clock);
    let rejectLate: (e: Error) => void = () => undefined;
    const late = new Promise<number>((_, reject) => {
      rejectLate = reject;
    });
    const pending = raceTimeout(late, 50, sleeper.sleep);
    await flush();
    sleeper.fireTimers();
    expect(await pending).toEqual({ timedOut: true });
    rejectLate(new Error('late'));
    await flush();
  });
});

// Checklist 1.2 and 1.5: the JWKS cache, then key rotation and outage through
// the whole verifier. Time is a variable and the network is a script, so every
// case is offline and deterministic. The properties under test: bounded
// documents, TTL, a cooldown that caps fetches, single-flight coalescing,
// stale-if-error with a hard ceiling, and fail-closed on every bad document.

import { describe, expect, it } from 'vitest';
import { OidcError } from './errors';
import { JwksCache, parseJwks, type JwksCacheDeps } from './jwks';
import type { ResolvedJwksOptions } from './config';
import type { OidcAlg } from './shared';
import { FakeJwks, JWKS_URI, NOW, codeOf, edKey, harness, jwksDocument, keys, makeToken, type TestKey } from './testkit';

const K = keys();
const ALL = new Set<OidcAlg>(['RS256', 'ES256', 'EdDSA']);
const OPTS: ResolvedJwksOptions = Object.freeze({
  ttlSeconds: 600,
  refreshCooldownSeconds: 30,
  staleIfErrorSeconds: 3600,
  maxKeys: 4,
  maxBytes: 4096,
  fetchTimeoutMs: 5000,
});

function setup(list: readonly TestKey[] = [K.ed], over: Partial<ResolvedJwksOptions> = {}, deps: Partial<JwksCacheDeps> = {}) {
  const jwks = new FakeJwks(list);
  const clock = { t: NOW };
  const cache = new JwksCache(JWKS_URI, ALL, { ...OPTS, ...over }, {
    fetchJwks: jwks.fetch,
    clock: () => clock.t,
    createSignal: () => new AbortController().signal,
    ...deps,
  });
  return { cache, jwks, clock };
}
const code = (p: Promise<unknown>) => codeOf(p);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('fetching and the TTL', () => {
  it('fetches once on first use, with the configured URL and byte bound, and serves from memory after', async () => {
    const { cache, jwks } = setup();
    expect((await cache.getKey('ed-1')).kid).toBe('ed-1');
    await cache.getKey('ed-1');
    await cache.getKey('ed-1');
    expect(jwks.calls).toEqual([{ url: JWKS_URI, maxBytes: 4096 }]);
  });

  it('keeps serving without a fetch through the last second of the TTL, then refreshes', async () => {
    const { cache, jwks, clock } = setup();
    await cache.getKey('ed-1');
    clock.t = NOW + 599;
    await cache.getKey('ed-1');
    expect(jwks.calls).toHaveLength(1);
    clock.t = NOW + 600;
    await cache.getKey('ed-1');
    expect(jwks.calls).toHaveLength(2);
  });

  it('stores only usable keys and at most maxKeys', async () => {
    const list = [edKey('a'), edKey('b'), edKey('c'), edKey('d')];
    const { cache } = setup(list);
    for (const k of list) expect((await cache.getKey(k.kid)).kid).toBe(k.kid);
  });
});

describe('unknown kid: forced refresh with a cooldown', () => {
  it('refreshes once for an unknown kid and reports unknown_kid when it is still missing', async () => {
    const { cache, jwks, clock } = setup();
    await cache.getKey('ed-1');
    clock.t = NOW + 100;
    await expect(code(cache.getKey('nobody'))).resolves.toBe('unknown_kid');
    expect(jwks.calls).toHaveLength(2);
  });

  it('holds back further unknown-kid refreshes until the cooldown has passed (boundaries)', async () => {
    const { cache, jwks, clock } = setup();
    await cache.getKey('ed-1'); // t = NOW, fetch 1
    clock.t = NOW + 100;
    await code(cache.getKey('x1')); // fetch 2 at NOW + 100
    expect(jwks.calls).toHaveLength(2);
    clock.t = NOW + 100 + 29;
    await code(cache.getKey('x2'));
    expect(jwks.calls).toHaveLength(2);
    clock.t = NOW + 100 + 30;
    await code(cache.getKey('x3'));
    expect(jwks.calls).toHaveLength(3);
  });

  it('turns a flood of random kids into one fetch per cooldown window, not one per token', async () => {
    const { cache, jwks, clock } = setup();
    await cache.getKey('ed-1');
    clock.t = NOW + 50;
    for (let i = 0; i < 1000; i += 1) await code(cache.getKey(`random-${i}`));
    expect(jwks.calls).toHaveLength(2); // the first load plus a single forced refresh
    clock.t = NOW + 50 + 30;
    for (let i = 0; i < 1000; i += 1) await code(cache.getKey(`more-${i}`));
    expect(jwks.calls).toHaveLength(3);
  });

  it('does not let a flood of unknown kids evict or disturb known kids', async () => {
    const { cache, clock } = setup();
    await cache.getKey('ed-1');
    clock.t = NOW + 50;
    for (let i = 0; i < 50; i += 1) await code(cache.getKey(`random-${i}`));
    expect((await cache.getKey('ed-1')).kid).toBe('ed-1');
  });

  it('does not refresh again for an unknown kid right after a TTL refresh in the same call', async () => {
    const { cache, jwks, clock } = setup();
    await cache.getKey('ed-1');
    clock.t = NOW + 600; // expired; the refresh happens, the kid is still missing
    await expect(code(cache.getKey('nobody'))).resolves.toBe('unknown_kid');
    expect(jwks.calls).toHaveLength(2);
  });
});

describe('single flight', () => {
  it('coalesces concurrent first loads into one fetch', async () => {
    const { cache, jwks } = setup();
    jwks.hold();
    const all = Array.from({ length: 50 }, () => cache.getKey('ed-1'));
    await flush();
    expect(jwks.calls).toHaveLength(1);
    jwks.release();
    const keysBack = await Promise.all(all);
    expect(keysBack.every((k) => k.kid === 'ed-1')).toBe(true);
    expect(jwks.calls).toHaveLength(1);
  });

  it('coalesces concurrent misses for unknown kids into one fetch, and all callers see the rotated key', async () => {
    const { cache, jwks, clock } = setup([K.ed]);
    await cache.getKey('ed-1');
    clock.t = NOW + 100;
    jwks.setKeys([K.ed, K.other]);
    jwks.hold();
    const all = Array.from({ length: 50 }, () => cache.getKey('other-1'));
    const randoms = Array.from({ length: 50 }, (_, i) => code(cache.getKey(`junk-${i}`)));
    await flush();
    expect(jwks.calls).toHaveLength(2); // 1 initial + exactly 1 in flight
    jwks.release();
    expect((await Promise.all(all)).every((k) => k.kid === 'other-1')).toBe(true);
    expect((await Promise.all(randoms)).every((c) => c === 'unknown_kid')).toBe(true);
    expect(jwks.calls).toHaveLength(2);
  });

  it('shares one failure among all waiters and clears the slot so a later attempt can run', async () => {
    const { cache, jwks, clock } = setup();
    jwks.setFailure();
    jwks.hold();
    const all = Array.from({ length: 20 }, () => code(cache.getKey('ed-1')));
    await flush();
    jwks.release();
    expect((await Promise.all(all)).every((c) => c === 'jwks_unavailable')).toBe(true);
    expect(jwks.calls).toHaveLength(1);
    jwks.setKeys([K.ed]);
    clock.t = NOW + 30;
    expect((await cache.getKey('ed-1')).kid).toBe('ed-1');
    expect(jwks.calls).toHaveLength(2);
  });
});

describe('key rotation', () => {
  it('picks up a newly published key after the cooldown, and drops a removed key at the next refresh', async () => {
    const { cache, jwks, clock } = setup([K.ed]);
    await cache.getKey('ed-1'); // load at NOW
    jwks.setKeys([K.ed, K.other]);
    clock.t = NOW + 5;
    await expect(code(cache.getKey('other-1'))).resolves.toBe('unknown_kid'); // inside the cooldown: no fetch
    expect(jwks.calls).toHaveLength(1);
    clock.t = NOW + 30;
    expect((await cache.getKey('other-1')).kid).toBe('other-1'); // forced refresh
    expect(jwks.calls).toHaveLength(2);
    jwks.setKeys([K.other]); // the old key is retired
    clock.t = NOW + 30 + 600;
    expect((await cache.getKey('other-1')).kid).toBe('other-1');
    await expect(code(cache.getKey('ed-1'))).resolves.toBe('unknown_kid');
  });

  it('keeps serving both keys during an overlap window', async () => {
    const { cache, jwks, clock } = setup([K.ed, K.other]);
    await cache.getKey('ed-1');
    clock.t = NOW + 700;
    jwks.setKeys([K.other, K.ed]);
    expect((await cache.getKey('ed-1')).kid).toBe('ed-1');
    expect((await cache.getKey('other-1')).kid).toBe('other-1');
  });
});

describe('outage: stale-if-error with a hard ceiling', () => {
  // ttl 600, stale 3600: stale keys may serve while age <= 4200.
  it('serves the stale set when a refresh fails, without hammering the provider', async () => {
    const { cache, jwks, clock } = setup();
    await cache.getKey('ed-1');
    jwks.setFailure();
    clock.t = NOW + 600; // expired, refresh fails
    expect((await cache.getKey('ed-1')).kid).toBe('ed-1');
    expect(jwks.calls).toHaveLength(2);
    for (let t = 601; t < 630; t += 1) {
      clock.t = NOW + t;
      expect((await cache.getKey('ed-1')).kid).toBe('ed-1');
    }
    expect(jwks.calls).toHaveLength(2); // held back by the cooldown
    clock.t = NOW + 630;
    await cache.getKey('ed-1');
    expect(jwks.calls).toHaveLength(3); // one retry per cooldown window
  });

  it('serves the stale set up to and including the ceiling, and fails closed one second after', async () => {
    const { cache, jwks, clock } = setup();
    await cache.getKey('ed-1');
    jwks.setFailure();
    clock.t = NOW + 4200; // age == ttl + staleIfError
    expect((await cache.getKey('ed-1')).kid).toBe('ed-1');
    clock.t = NOW + 4201;
    await expect(code(cache.getKey('ed-1'))).resolves.toBe('jwks_unavailable');
    clock.t = NOW + 100_000;
    await expect(code(cache.getKey('ed-1'))).resolves.toBe('jwks_unavailable');
  });

  it('does not serve stale keys at all when staleIfErrorSeconds is 0', async () => {
    const { cache, jwks, clock } = setup([K.ed], { staleIfErrorSeconds: 0 });
    await cache.getKey('ed-1');
    jwks.setFailure();
    clock.t = NOW + 599;
    expect((await cache.getKey('ed-1')).kid).toBe('ed-1'); // still fresh
    clock.t = NOW + 601;
    await expect(code(cache.getKey('ed-1'))).resolves.toBe('jwks_unavailable');
  });

  it('recovers on its own once the provider is back and the cooldown has passed', async () => {
    const { cache, jwks, clock } = setup();
    await cache.getKey('ed-1');
    jwks.setFailure();
    clock.t = NOW + 5000;
    await expect(code(cache.getKey('ed-1'))).resolves.toBe('jwks_unavailable');
    jwks.setKeys([K.ed, K.other]);
    clock.t = NOW + 5000 + 29;
    await expect(code(cache.getKey('other-1'))).resolves.toBe('jwks_unavailable'); // still cooling down
    clock.t = NOW + 5000 + 30;
    expect((await cache.getKey('other-1')).kid).toBe('other-1');
  });

  it('says jwks_unavailable, not unknown_kid, when a needed refresh failed for a kid the stale set lacks', async () => {
    const { cache, jwks, clock } = setup();
    await cache.getKey('ed-1');
    jwks.setFailure();
    clock.t = NOW + 100;
    await expect(code(cache.getKey('rotated-in'))).resolves.toBe('jwks_unavailable');
    expect((await cache.getKey('ed-1')).kid).toBe('ed-1'); // known kid still serves
  });

  it('fails closed on a first load that fails, and retries only after the cooldown', async () => {
    const { cache, jwks, clock } = setup();
    jwks.setFailure();
    await expect(code(cache.getKey('ed-1'))).resolves.toBe('jwks_unavailable');
    for (let i = 0; i < 100; i += 1) await code(cache.getKey('ed-1'));
    expect(jwks.calls).toHaveLength(1);
    clock.t = NOW + 30;
    await code(cache.getKey('ed-1'));
    expect(jwks.calls).toHaveLength(2);
  });

  it('treats a clock that moved backwards as expired, never as extra fresh', async () => {
    const { cache, jwks, clock } = setup();
    await cache.getKey('ed-1');
    clock.t = NOW - 1000;
    jwks.setFailure();
    await expect(code(cache.getKey('ed-1'))).resolves.toBe('jwks_unavailable'); // refresh attempted, failed, no stale service
    expect(jwks.calls).toHaveLength(2);
  });
});

describe('hostile or broken documents', () => {
  const good = jwksDocument([K.ed.jwk]);
  const dup = (a: TestKey, b: TestKey) => jwksDocument([a.jwk, { ...b.jwk, kid: a.kid }]);

  const refused: [string, string | Uint8Array | object][] = [
    ['not JSON', 'not json'],
    ['empty body', ''],
    ['a JSON array', '[]'],
    ['no keys member', '{}'],
    ['keys not an array', '{"keys":{}}'],
    ['an empty keys array', '{"keys":[]}'],
    ['a non-object entry', '{"keys":[5]}'],
    ['an array entry', '{"keys":[[]]}'],
    ['only unusable keys', jwksDocument([{ ...K.ed.jwk, use: 'enc' }])],
    ['a duplicate kid', dup(K.ed, K.other)],
    ['a duplicate kid where one copy is an encryption key', jwksDocument([K.ed.jwk, { ...K.other.jwk, kid: 'ed-1', use: 'enc' }])],
    ['an invalid UTF-8 body', new Uint8Array([0x7b, 0xff, 0x7d])],
    ['a byte-order mark', new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(good)])],
    ['a non-string body', {}],
  ];

  it.each(refused)('refuses a document with %s, keeping the previous good set', async (_name, body) => {
    const { cache, jwks, clock } = setup();
    await cache.getKey('ed-1');
    jwks.setBody(body as string);
    clock.t = NOW + 600;
    expect((await cache.getKey('ed-1')).kid).toBe('ed-1'); // stale-if-error from the earlier good set
    expect(jwks.calls).toHaveLength(2);
  });

  it.each(refused)('on a first load, refuses a document with %s and fails closed', async (_name, body) => {
    const { cache, jwks } = setup();
    jwks.setBody(body as string);
    await expect(code(cache.getKey('ed-1'))).resolves.toBe('jwks_unavailable');
  });

  it('accepts a Uint8Array body', async () => {
    const { cache, jwks } = setup();
    jwks.setBody(new Uint8Array(Buffer.from(good)));
    expect((await cache.getKey('ed-1')).kid).toBe('ed-1');
  });

  it('bounds the document by bytes, exactly: maxBytes passes, one more byte is refused', () => {
    const pad = (n: number) => good + ' '.repeat(n - Buffer.byteLength(good));
    const opts = { maxBytes: 1024, maxKeys: 4 };
    expect(Buffer.byteLength(good)).toBeLessThan(1024);
    expect(parseJwks(pad(1024), opts, ALL)).not.toBeNull();
    expect(parseJwks(pad(1025), opts, ALL)).toBeNull();
    expect(parseJwks(new Uint8Array(Buffer.from(pad(1024))), opts, ALL)).not.toBeNull();
    expect(parseJwks(new Uint8Array(Buffer.from(pad(1025))), opts, ALL)).toBeNull();
  });

  it('counts bytes, not characters', () => {
    const body = JSON.stringify({ keys: [K.ed.jwk], note: 'é'.repeat(600) }); // ~ 1200 bytes more than its length suggests
    const chars = body.length;
    expect(Buffer.byteLength(body)).toBeGreaterThan(chars);
    expect(parseJwks(body, { maxBytes: chars, maxKeys: 4 }, ALL)).toBeNull();
    expect(parseJwks(body, { maxBytes: Buffer.byteLength(body), maxKeys: 4 }, ALL)).not.toBeNull();
  });

  it('bounds the key count, exactly: maxKeys passes, one more is refused', () => {
    const list = Array.from({ length: 5 }, (_, i) => edKey(`k${i}`).jwk);
    expect(parseJwks(jwksDocument(list.slice(0, 4)), { maxBytes: 65_536, maxKeys: 4 }, ALL)?.size).toBe(4);
    expect(parseJwks(jwksDocument(list), { maxBytes: 65_536, maxKeys: 4 }, ALL)).toBeNull();
  });

  it('skips unusable keys individually but keeps the usable ones', async () => {
    const mixed = jwksDocument([
      { ...K.other.jwk, use: 'enc' },
      { ...K.ec.jwk, key_ops: ['sign'] },
      { kty: 'oct', kid: 'sym', k: 'c2VjcmV0' },
      { ...K.ed.jwk },
      { ...K.rsa.jwk, alg: 'RS512' },
    ]);
    const { cache, jwks } = setup([K.ed], { maxKeys: 8 });
    jwks.setBody(mixed);
    expect((await cache.getKey('ed-1')).kid).toBe('ed-1');
    for (const kid of ['other-1', 'ec-1', 'sym', 'rsa-1']) await expect(code(cache.getKey(kid))).resolves.toBe('unknown_kid');
  });

  it('ignores entries without a kid rather than guessing', () => {
    const noKid: Record<string, unknown> = { ...K.ed.jwk };
    delete noKid.kid;
    const m = parseJwks(jwksDocument([noKid, K.other.jwk]), { maxBytes: 65_536, maxKeys: 4 }, ALL);
    expect([...(m?.keys() ?? [])]).toEqual(['other-1']);
  });

  it('never replaces a good set with a document that has duplicate kids, even a later one', async () => {
    const { cache, jwks, clock } = setup([K.ed, K.other]);
    await cache.getKey('ed-1');
    jwks.setBody(dup(K.other, K.ed));
    clock.t = NOW + 600;
    expect((await cache.getKey('ed-1')).kid).toBe('ed-1');
    expect((await cache.getKey('other-1')).kid).toBe('other-1');
  });
});

describe('deadline and fetch seam failures', () => {
  it('abandons a fetch that never settles when its signal aborts, then recovers', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const jwks = new FakeJwks([K.ed]);
    const clock = { t: NOW };
    const cache = new JwksCache(JWKS_URI, ALL, OPTS, {
      fetchJwks: (url, o) => {
        attempts += 1;
        return attempts === 1 ? new Promise<string>(() => undefined) : jwks.fetch(url, o);
      },
      clock: () => clock.t,
      createSignal: () => (attempts === 0 ? controller.signal : new AbortController().signal),
    });
    const pending = code(cache.getKey('ed-1'));
    await flush();
    controller.abort();
    await expect(pending).resolves.toBe('jwks_unavailable');
    clock.t = NOW + 30;
    expect((await cache.getKey('ed-1')).kid).toBe('ed-1');
    expect(attempts).toBe(2);
  });

  it('treats an already-aborted signal as a failed fetch, even if the fetcher throws synchronously', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const cache = new JwksCache(JWKS_URI, ALL, OPTS, {
      fetchJwks: () => {
        throw new Error('sync boom');
      },
      clock: () => NOW,
      createSignal: () => aborted.signal,
    });
    await expect(code(cache.getKey('ed-1'))).resolves.toBe('jwks_unavailable');
  });

  it('passes the deadline signal and the byte bound to the fetcher', async () => {
    let seen: { maxBytes: number; signal: AbortSignal } | undefined;
    const signal = new AbortController().signal;
    const cache = new JwksCache(JWKS_URI, ALL, OPTS, {
      fetchJwks: async (_u, o) => {
        seen = o;
        return jwksDocument([K.ed.jwk]);
      },
      clock: () => NOW,
      createSignal: (ms) => (ms === OPTS.fetchTimeoutMs ? signal : new AbortController().signal),
    });
    await cache.getKey('ed-1');
    expect(seen?.maxBytes).toBe(OPTS.maxBytes);
    expect(seen?.signal).toBe(signal);
  });

  it('rejects missing or mistyped dependencies at construction', () => {
    const mk = (deps: unknown) => () => new JwksCache(JWKS_URI, ALL, OPTS, deps as JwksCacheDeps);
    for (const deps of [undefined, null, {}, { fetchJwks: 5 }, { fetchJwks: async () => '', clock: 5 }, { fetchJwks: async () => '', createSignal: 'x' }]) {
      expect(mk(deps)).toThrow(OidcError);
    }
    expect(mk({ fetchJwks: async () => '' })).not.toThrow();
  });

  it('uses the wall clock and a real timeout signal by default', async () => {
    const cache = new JwksCache(JWKS_URI, ALL, OPTS, { fetchJwks: async () => jwksDocument([K.ed.jwk]) });
    expect((await cache.getKey('ed-1')).kid).toBe('ed-1');
  });
});

describe('through the verifier: rotation, outage and floods', () => {
  const ctx = (t: number) => ({ now: t + 5 });

  it('verifies a token under a newly rotated key once the cooldown allows, and refuses the retired key after refresh', async () => {
    const hh = harness([K.ed]);
    const t1 = makeToken(K.ed);
    await expect(hh.verify(t1, ctx(NOW))).resolves.toBeTruthy();
    hh.jwks.setKeys([K.other]); // provider rotates: ed-1 retired, other-1 live
    const t2 = makeToken(K.other);
    hh.clock.t = NOW + 10;
    await expect(codeOf(hh.verify(t2, ctx(NOW + 10)))).resolves.toBe('unknown_kid'); // cooldown still running
    hh.clock.t = NOW + 31;
    await expect(hh.verify(t2, ctx(NOW + 31))).resolves.toBeTruthy();
    hh.clock.t = NOW + 31 + 600; // the old key is gone from the refreshed set
    await expect(codeOf(hh.verify(t1, { now: NOW + 100 }))).resolves.toBe('unknown_kid');
  });

  it('keeps authenticating known keys through a provider outage, then fails closed past the ceiling', async () => {
    const hh = harness([K.ed]);
    const t = makeToken(K.ed, { claims: { exp: NOW + 3600 } });
    await hh.verify(t, ctx(NOW));
    hh.jwks.setFailure();
    hh.clock.t = NOW + 1000;
    await expect(hh.verify(t, { now: NOW + 1000 })).resolves.toBeTruthy(); // stale, within the ceiling
    hh.clock.t = NOW + 4201;
    await expect(codeOf(hh.verify(t, { now: NOW + 100 }))).resolves.toBe('jwks_unavailable');
  });

  it('a flood of tokens with random kids costs the provider one extra fetch', async () => {
    const hh = harness([K.ed]);
    await hh.verify(makeToken(K.ed), ctx(NOW));
    hh.clock.t = NOW + 100;
    for (let i = 0; i < 200; i += 1) await codeOf(hh.verify(makeToken(K.ed, { header: { kid: `junk-${i}` } }), { now: NOW + 5 }));
    expect(hh.jwks.calls).toHaveLength(2);
  });

  it('concurrent verifications that miss the cache share one fetch', async () => {
    const hh = harness([K.ed]);
    hh.jwks.hold();
    const all = Array.from({ length: 40 }, () => hh.verify(makeToken(K.ed)));
    await flush();
    expect(hh.jwks.calls).toHaveLength(1);
    hh.jwks.release();
    expect((await Promise.all(all)).every((p) => p.role === 'finops_lead')).toBe(true);
    expect(hh.jwks.calls).toHaveLength(1);
  });

  it('does not fetch at all for tokens that fail the header rules', async () => {
    const hh = harness([K.ed]);
    for (const alg of ['none', 'HS256', 'ES384']) await codeOf(hh.verify(makeToken(K.ed, { header: { alg } })));
    await codeOf(hh.verify(makeToken(K.ed, { header: { jku: 'https://evil.test/' } })));
    await codeOf(hh.verify('x.y.z'));
    expect(hh.jwks.calls).toHaveLength(0);
  });

  it('only ever fetches the configured key-set URL', async () => {
    const hh = harness([K.ed]);
    await hh.verify(makeToken(K.ed));
    await codeOf(hh.verify(makeToken(K.ed, { header: { kid: 'nobody' } }), { now: NOW + 5 }));
    expect(hh.jwks.calls.every((c) => c.url === JWKS_URI)).toBe(true);
  });
});

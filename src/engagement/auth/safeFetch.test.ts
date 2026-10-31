// R2 B: the server-side fetch the OIDC client uses for discovery, JWKS and the
// token request. Resolve-time SSRF protection with a pinned address, https
// only, no redirects, a timeout and a size cap. A fake transport stands in for
// node:https: no network in tests.
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { guardedFetch, isPublicAddress, type Lookup } from './safeFetch';

type Rec = { url: string; opts: Record<string, any>; body?: string; pinned?: unknown }; // eslint-disable-line @typescript-eslint/no-explicit-any
function transport(reply: { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; never?: boolean }, rec: Rec[]) {
  return ((url: URL, opts: Record<string, any>, cb: (res: unknown) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r: Rec = { url: url.href, opts };
    rec.push(r);
    const req = new EventEmitter() as EventEmitter & { end(b?: string): void; destroy(e?: Error): void };
    req.destroy = (e?: Error) => { setImmediate(() => req.emit('error', e ?? new Error('destroyed'))); };
    req.end = (b?: string) => {
      r.body = b;
      opts.lookup(url.hostname, { all: true }, (_e: unknown, a: unknown) => { r.pinned = a; });
      if (reply.never) return;
      setImmediate(() => {
        const res = Readable.from(reply.chunks ?? [Buffer.from('{"ok":true}')]) as Readable & { statusCode: number; headers: Record<string, string> };
        res.statusCode = reply.status ?? 200;
        res.headers = reply.headers ?? { 'content-type': 'application/json' };
        cb(res);
      });
    };
    return req;
  }) as never;
}
const lookupOf = (map: Record<string, string[]>): Lookup => async (h) => (map[h] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const OPTS = { method: 'GET', headers: { accept: 'application/json' }, body: undefined, redirect: 'manual' as const };

describe('isPublicAddress', () => {
  it('refuses loopback, private, link-local (metadata), CGNAT, multicast, unspecified, broadcast, documentation and their IPv6 / v4-mapped / NAT64 forms', () => {
    for (const ip of ['127.0.0.1', '127.255.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.254', '0.0.0.0', '0.1.2.3',
      '224.0.0.1', '239.1.1.1', '255.255.255.255', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '192.0.0.1', '240.0.0.1',
      '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2001:db8::1', 'not-an-ip', '']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '64:ff9b::808:808']) expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe('guardedFetch', () => {
  it('pins the checked address for the connection and sends SNI for the host name', async () => {
    const rec: Rec[] = [];
    const f = guardedFetch({ lookup: lookupOf({ 'idp.example.test': ['93.184.216.34'] }), request: transport({}, rec) });
    const res = await f('https://idp.example.test/.well-known/openid-configuration', OPTS);
    expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
    expect(rec[0].opts.servername).toBe('idp.example.test');
    expect(rec[0].pinned).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuses a name that resolves to any private address (rebinding-style answers too), an IP literal host, http, and no answer', async () => {
    const rec: Rec[] = [];
    const lookup = lookupOf({ '1.2.3.4.nip.io': ['127.0.0.1'], 'localhost.localdomain': ['::1'], 'mixed.example.test': ['93.184.216.34', '10.0.0.5'], '0x7f000001.test': ['127.0.0.1'], 'meta.example.test': ['169.254.169.254'] });
    const f = guardedFetch({ lookup, request: transport({}, rec) });
    for (const url of ['https://1.2.3.4.nip.io/x', 'https://localhost.localdomain/x', 'https://mixed.example.test/x', 'https://0x7f000001.test/x', 'https://meta.example.test/x',
      'https://10.0.0.1/x', 'https://[::1]/x', 'http://idp.example.test/x', 'https://unresolvable.example.test/x']) {
      await expect(f(url, OPTS), url).rejects.toThrow(/refused/);
    }
    expect(rec).toEqual([]); // nothing was ever connected
  });

  it('never follows a redirect, caps the body size and times out', async () => {
    const lookup = lookupOf({ 'idp.example.test': ['93.184.216.34'] });
    await expect(guardedFetch({ lookup, request: transport({ status: 302, headers: { location: 'https://10.0.0.1/' } }, []) })('https://idp.example.test/x', OPTS)).rejects.toThrow(/redirect/);
    await expect(guardedFetch({ lookup, maxBytes: 1000, request: transport({ chunks: [Buffer.alloc(600), Buffer.alloc(600)] }, []) })('https://idp.example.test/x', OPTS)).rejects.toThrow(/too large/);
    await expect(guardedFetch({ lookup, timeoutMs: 30, request: transport({ never: true }, []) })('https://idp.example.test/x', OPTS)).rejects.toThrow(/timed out/);
  });

  it('sends the method, headers and a form body (token request)', async () => {
    const rec: Rec[] = [];
    const f = guardedFetch({ lookup: lookupOf({ 'idp.example.test': ['93.184.216.34'] }), request: transport({}, rec) });
    await f('https://idp.example.test/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ a: '1' }), redirect: 'manual' });
    expect([rec[0].opts.method, rec[0].opts.headers['content-type'], rec[0].body]).toEqual(['POST', 'application/x-www-form-urlencoded', 'a=1']);
  });
});

// R2 B: the only way the OIDC client reaches an IdP (discovery, JWKS, token
// request), from the server. Resolve-time SSRF protection: the host is resolved
// here, EVERY answer must be a public unicast address (no loopback, private,
// link-local/metadata, CGNAT, multicast, documentation or reserved space, in
// IPv4, IPv6, v4-mapped or NAT64 form), and the connection is pinned to the
// checked address (no DNS rebinding between check and connect) while TLS still
// verifies the host name (SNI). https only, redirects refused, a timeout and a
// response size cap. SERVER-ONLY.
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
export interface GuardOptions { lookup?: Lookup; request?: typeof httpsRequest; timeoutMs?: number; lookupTimeoutMs?: number; maxBytes?: number }
interface FetchInit { method: string; headers: Record<string, string>; body?: unknown; redirect?: 'manual'; signal?: AbortSignal }

const v4 = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
function publicV4(ip: string): boolean {
  const n = v4(ip);
  return !V4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4(base) / 2 ** (32 - bits)));
}
/** The eight 16-bit groups of an IPv6 address (an embedded dotted IPv4 tail included). */
function groups(ip: string): number[] {
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
  const s = tail ? ip.slice(0, -tail.length) + ((v4(tail) >>> 16).toString(16) + ':' + (v4(tail) & 0xffff).toString(16)) : ip;
  const [h, t] = s.split('::');
  const part = (x: string | undefined) => (x ? x.split(':').map((g) => parseInt(g, 16)) : []);
  const head = part(h);
  const rest = part(t);
  return t === undefined ? head : [...head, ...Array(8 - head.length - rest.length).fill(0), ...rest];
}

/** True only for a public unicast address. Anything unparsable is not public. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return publicV4(ip);
  if (kind !== 6) return false;
  const g = groups(ip.toLowerCase());
  const embedded = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return publicV4(embedded()); // v4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return publicV4(embedded()); // NAT64
  if (g[0] === 0x2001 && (g[1] === 0xdb8 || g[1] === 0)) return false; // documentation 2001:db8::/32, Teredo 2001::/32
  if (g[0] === 0x2001 && g[1] === 2 && g[2] === 0) return false; // benchmarking 2001:2::/48
  if (g[0] === 0x2002 || (g[0] === 0x3fff && g[1] < 0x1000)) return false; // 6to4 2002::/16 (embeds IPv4), documentation 3fff::/20
  // Global unicast 2000::/3 only: this excludes ::, ::1, ULA fc00::/7, link-local fe80::/10 and multicast ff00::/8.
  return (g[0] & 0xe000) === 0x2000;
}

const refuse = (why: string) => new Error(`refused: ${why}`);

export function guardedFetch(opts: GuardOptions = {}) {
  const lookup: Lookup = opts.lookup ?? ((h) => dnsLookup(h, { all: true, verbatim: true }));
  const send = opts.request ?? httpsRequest;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const lookupTimeoutMs = opts.lookupTimeoutMs ?? 2000;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  return async (input: string, init: FetchInit): Promise<Response> => {
    const url = new URL(input);
    if (url.protocol !== 'https:') throw refuse('https only');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<[]>((r) => { timer = setTimeout(() => r([]), lookupTimeoutMs); });
    const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([lookup(host).catch(() => [] as []), late]).finally(() => clearTimeout(timer));
    if (answers.length === 0 || !answers.every((a) => isPublicAddress(a.address))) throw refuse('address not public');
    const pinned = answers[0];
    const body = init.body == null ? undefined : typeof init.body === 'string' ? init.body : init.body instanceof Uint8Array ? Buffer.from(init.body).toString() : String(init.body);
    return new Promise<Response>((resolve, reject) => {
      const req = send(url, {
        method: init.method, headers: init.headers, servername: isIP(host) ? undefined : host,
        lookup: (_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family)),
      } as never, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) { req.destroy(); return reject(refuse('redirect')); }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) { req.destroy(); reject(refuse('response too large')); } else chunks.push(c);
        });
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status, headers: Object.entries(res.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])) as [string, string][] })));
        res.on('error', reject);
      });
      const timer = setTimeout(() => { reject(refuse('timed out')); req.destroy(); }, timeoutMs);
      req.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
      req.on('close', () => clearTimeout(timer));
      init.signal?.addEventListener('abort', () => { reject(refuse('aborted')); req.destroy(); });
      req.end(body);
    });
  };
}

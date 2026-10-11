// IP address parsing and classification for the outbound SSRF guard.
//
// TRUST BOUNDARY: inputs are host strings taken from tenant-configured URLs or
// from a DNS resolver answer, so both are untrusted. Classification is
// deny-by-default: an address is allowed only when it parses cleanly AND falls
// outside every special-purpose range below. IPv6 is allowed only inside the
// global-unicast block 2000::/3, minus its reserved sub-ranges; IPv4-mapped,
// 6to4 and NAT64 forms are classified by the IPv4 address they embed.
//
// Pure functions; no I/O.

export type IpBlockReason =
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'metadata'
  | 'unique_local'
  | 'multicast'
  | 'carrier_nat'
  | 'documentation'
  | 'reserved'
  | 'unparseable';

export type IpVerdict =
  | { readonly allowed: true; readonly family: 4 | 6; readonly canonical: string }
  | { readonly allowed: false; readonly reason: IpBlockReason };

const BLOCK = (reason: IpBlockReason): IpVerdict => ({ allowed: false, reason });

// --- IPv4 ---------------------------------------------------------------------

/**
 * Strict dotted quad: exactly four decimal parts, 0-255, no leading zeros
 * (a leading zero is octal to some parsers and decimal to others, so it is
 * refused rather than guessed). Returns an unsigned 32-bit value or null.
 */
export function parseIpv4Strict(s: string): number | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/**
 * Lenient inet_aton-style parse used as defense in depth: 1 to 4 parts, each
 * decimal, octal (leading 0) or hex (0x), the last part filling the remaining
 * bytes. `2130706433`, `0x7f.1` and `017700000001` all parse to 127.0.0.1.
 * Returns an unsigned 32-bit value or null when the string is not an IPv4
 * spelling in that grammar.
 */
export function parseIpv4Lenient(s: string): number | null {
  const parts = s.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    if (part.length === 0 || part.length > 12) return null;
    let n: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) n = parseInt(part.slice(2), 16);
    else if (/^0[0-7]*$/.test(part)) n = part.length === 1 ? 0 : parseInt(part, 8);
    else if (/^[1-9][0-9]*$/.test(part)) n = parseInt(part, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    values.push(n);
  }
  const last = values[values.length - 1];
  const lastLimit = Math.pow(256, 5 - values.length) - 1;
  if (last > lastLimit) return null;
  let result = last;
  for (let i = 0; i < values.length - 1; i += 1) {
    if (values[i] > 255) return null;
    result += values[i] * Math.pow(256, 3 - i);
  }
  return result >= 0 && result <= 0xffffffff ? result : null;
}

export function formatIpv4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

type Ipv4Rule = readonly [base: string, prefix: number, reason: IpBlockReason];

/** Explicit single addresses that are cloud metadata or platform endpoints. */
const METADATA_V4 = new Set([
  '169.254.169.254', // AWS, GCP, Azure, DigitalOcean, OpenStack instance metadata
  '169.254.170.2', // AWS ECS task metadata
  '100.100.100.200', // Alibaba Cloud metadata
  '192.0.0.192', // Oracle Cloud metadata
  '168.63.129.16', // Azure wire server (a public-range address, so listed explicitly)
]);

const IPV4_RULES: readonly Ipv4Rule[] = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier_nat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link_local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'reserved'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const COMPILED_V4 = IPV4_RULES.map(([base, prefix, reason]) => {
  const b = parseIpv4Strict(base) as number;
  const size = Math.pow(2, 32 - prefix);
  return { start: b, end: b + size - 1, reason };
});

export function classifyIpv4(n: number): IpVerdict {
  const text = formatIpv4(n);
  if (METADATA_V4.has(text)) return BLOCK('metadata');
  for (const rule of COMPILED_V4) {
    if (n >= rule.start && n <= rule.end) return BLOCK(rule.reason);
  }
  return { allowed: true, family: 4, canonical: text };
}

// --- IPv6 ---------------------------------------------------------------------

/** Parse an IPv6 literal (no brackets, no zone id) into eight 16-bit groups, or null. */
export function parseIpv6(s: string): number[] | null {
  if (s.length === 0 || s.length > 45) return null;
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null; // also refuses '%' zone ids and brackets
  let text = s;
  let tail: number[] = [];
  // Embedded IPv4 in the last 32 bits (e.g. ::ffff:127.0.0.1).
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.')) {
    if (lastColon === -1) return null;
    const v4 = parseIpv4Strict(text.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    text = text.slice(0, lastColon + 1) + '0:0';
    // The placeholder keeps the group count right; the tail replaces its last two groups below.
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  let groups: number[];
  if (halves.length === 2) {
    const head = parseGroups(halves[0]);
    const rest = parseGroups(halves[1]);
    if (head === null || rest === null) return null;
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    const all = parseGroups(halves[0]);
    if (all === null || all.length !== 8) return null;
    groups = all;
  }
  if (groups.length !== 8) return null;
  if (tail.length === 2) {
    groups[6] = tail[0];
    groups[7] = tail[1];
  }
  return groups;
}

export function formatIpv6(groups: readonly number[]): string {
  // RFC 5952: compress the longest run of two or more zero groups.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; i += 1) {
    if (groups[i] !== 0) continue;
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  const head = hex.slice(0, bestStart).join(':');
  const rest = hex.slice(bestStart + bestLen).join(':');
  return `${head}::${rest}`;
}

function embeddedV4(hi: number, lo: number): number {
  return ((hi << 16) | lo) >>> 0;
}

export function classifyIpv6(g: readonly number[]): IpVerdict {
  if (g.every((x) => x === 0)) return BLOCK('unspecified');
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return BLOCK('loopback');

  // IPv4-mapped ::ffff:a.b.c.d is classified as the embedded IPv4 address, and
  // is never "allowed" in mapped form: callers connect to the dotted address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const v = classifyIpv4(embeddedV4(g[6], g[7]));
    return v.allowed ? BLOCK('reserved') : v;
  }
  // 64:ff9b::/96 NAT64 well-known prefix: classify the embedded IPv4 address.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    const v = classifyIpv4(embeddedV4(g[6], g[7]));
    return v.allowed ? { allowed: true, family: 6, canonical: formatIpv6(g) } : v;
  }

  if (g[0] === 0xfd00 && g[1] === 0x0ec2 && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x254) {
    return BLOCK('metadata'); // AWS IMDS over IPv6
  }
  if ((g[0] & 0xfe00) === 0xfc00) return BLOCK('unique_local'); // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return BLOCK('link_local'); // fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return BLOCK('reserved'); // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return BLOCK('multicast'); // ff00::/8

  // Deny by default: only global unicast 2000::/3 can be allowed.
  if ((g[0] & 0xe000) !== 0x2000) return BLOCK('reserved');
  if (g[0] === 0x2001 && g[1] === 0x0db8) return BLOCK('documentation'); // 2001:db8::/32
  if (g[0] === 0x2001 && g[1] < 0x0200) return BLOCK('reserved'); // 2001::/23 IETF protocol (Teredo etc.)
  if (g[0] === 0x3fff && g[1] < 0x1000) return BLOCK('documentation'); // 3fff::/20 (RFC 9637)
  if (g[0] === 0x2002) {
    // 6to4: the embedded IPv4 address must itself be allowed.
    const v = classifyIpv4(embeddedV4(g[1], g[2]));
    if (!v.allowed) return v;
  }
  return { allowed: true, family: 6, canonical: formatIpv6(g) };
}

// --- entry points ---------------------------------------------------------------

/**
 * Classify a resolver answer or other canonical IP literal (IPv4 dotted quad or
 * IPv6, no brackets). Anything that does not parse strictly is blocked.
 */
export function classifyIp(ip: string): IpVerdict {
  if (typeof ip !== 'string') return BLOCK('unparseable');
  const v4 = parseIpv4Strict(ip);
  if (v4 !== null) return classifyIpv4(v4);
  const v6 = parseIpv6(ip);
  if (v6 !== null) return classifyIpv6(v6);
  return BLOCK('unparseable');
}

/**
 * Classify a URL hostname that may be an IP literal in any spelling. Returns
 * `null` when the host is an ordinary name (the caller then resolves it).
 * Handles `[v6]` brackets, a trailing dot, and the decimal / octal / hex /
 * short IPv4 spellings. A host whose last label is numeric or `0x…` but does
 * not parse is treated as a malformed IP literal and blocked (WHATWG rule).
 */
export function classifyHostLiteral(host: string): IpVerdict | null {
  let h = host;
  if (h.startsWith('[') && h.endsWith(']')) {
    const v6 = parseIpv6(h.slice(1, -1));
    return v6 === null ? BLOCK('unparseable') : classifyIpv6(v6);
  }
  if (h.endsWith('.')) h = h.slice(0, -1);
  const lenient = parseIpv4Lenient(h);
  if (lenient !== null) return classifyIpv4(lenient);
  const lastLabel = h.slice(h.lastIndexOf('.') + 1);
  if (/^(0[xX][0-9a-fA-F]*|[0-9]+)$/.test(lastLabel)) return BLOCK('unparseable');
  if (h.includes(':')) return BLOCK('unparseable'); // an unbracketed IPv6-looking host
  return null;
}

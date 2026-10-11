// IP classification: every blocked class, boundary addresses, alternate
// spellings, IPv4-mapped IPv6, and public addresses that must stay allowed.

import { describe, it, expect } from 'vitest';
import {
  classifyHostLiteral,
  classifyIp,
  formatIpv4,
  formatIpv6,
  parseIpv4Lenient,
  parseIpv4Strict,
  parseIpv6,
  type IpBlockReason,
} from './ip';

function reason(ip: string): IpBlockReason | 'allowed' {
  const v = classifyIp(ip);
  return v.allowed ? 'allowed' : v.reason;
}

describe('parseIpv4Strict', () => {
  it.each([
    ['0.0.0.0', 0],
    ['127.0.0.1', 0x7f000001],
    ['255.255.255.255', 0xffffffff],
    ['10.20.30.40', 0x0a141e28],
  ])('parses %s', (text, n) => {
    expect(parseIpv4Strict(text)).toBe(n);
    expect(formatIpv4(n)).toBe(text);
  });

  it.each(['', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.-4', '01.2.3.4', '1.2.3.04', '0x7f.0.0.1', '1.2.3.a', ' 1.2.3.4', '1.2.3.4 ', '1..3.4', '2130706433'])(
    'refuses %j',
    (text) => {
      expect(parseIpv4Strict(text)).toBeNull();
    },
  );
});

describe('parseIpv4Lenient (alternate spellings)', () => {
  it.each([
    ['2130706433', 0x7f000001], // decimal
    ['0x7f000001', 0x7f000001], // hex, whole
    ['0x7f.1', 0x7f000001], // hex first octet, short form
    ['017700000001', 0x7f000001], // octal, whole
    ['0177.0.0.1', 0x7f000001], // octal first octet
    ['127.1', 0x7f000001], // short form
    ['127.0.1', 0x7f000001],
    ['0', 0],
    ['4294967295', 0xffffffff],
    ['0xA9FEA9FE', 0xa9fea9fe], // 169.254.169.254
    ['3232235521', 0xc0a80001], // 192.168.0.1
  ])('parses %s', (text, n) => {
    expect(parseIpv4Lenient(text)).toBe(n);
  });

  it.each(['', '.', '1..2', '1.2.3.4.5', '256.1.1.1', '4294967296', '0x', '08', '09.1', '1.0x100.1.1', '0xzz', 'a.b.c.d', '1.2.3.4a', '999999999999'])(
    'refuses %j',
    (text) => {
      expect(parseIpv4Lenient(text)).toBeNull();
    },
  );
});

describe('classifyIp: IPv4 blocked ranges', () => {
  it.each<[string, IpBlockReason]>([
    ['0.0.0.0', 'unspecified'],
    ['0.255.255.255', 'unspecified'],
    ['10.0.0.0', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.0', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.0.0', 'private'],
    ['192.168.255.255', 'private'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback'],
    ['169.254.0.1', 'link_local'],
    ['169.254.169.254', 'metadata'],
    ['169.254.170.2', 'metadata'],
    ['100.100.100.200', 'metadata'],
    ['192.0.0.192', 'metadata'],
    ['168.63.129.16', 'metadata'],
    ['100.64.0.0', 'carrier_nat'],
    ['100.127.255.255', 'carrier_nat'],
    ['192.0.0.1', 'reserved'],
    ['192.0.2.7', 'documentation'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.7', 'documentation'],
    ['198.18.0.1', 'reserved'],
    ['198.19.255.255', 'reserved'],
    ['192.88.99.1', 'reserved'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
  ])('%s is blocked (%s)', (ip, why) => {
    expect(reason(ip)).toBe(why);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '11.0.0.0', '192.169.0.0', '169.253.255.255', '169.255.0.0', '198.17.255.255', '198.20.0.0', '223.255.255.255', '9.255.255.255'])(
    '%s is allowed (range boundary)',
    (ip) => {
      expect(reason(ip)).toBe('allowed');
    },
  );
});

describe('classifyIp: IPv6', () => {
  it.each<[string, IpBlockReason]>([
    ['::', 'unspecified'],
    ['0:0:0:0:0:0:0:0', 'unspecified'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['fc00::', 'unique_local'],
    ['fc00::1', 'unique_local'],
    ['fd12:3456:789a::1', 'unique_local'],
    ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'unique_local'],
    ['fd00:ec2::254', 'metadata'],
    ['fe80::1', 'link_local'],
    ['fe80::dead:beef', 'link_local'],
    ['febf::1', 'link_local'],
    ['fec0::1', 'reserved'],
    ['ff02::1', 'multicast'],
    ['ff00::', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2001:db8:ffff::1', 'documentation'],
    ['3fff::1', 'documentation'],
    ['2001::1', 'reserved'], // Teredo / IETF protocol block
    ['2001:1ff::1', 'reserved'],
    ['100::1', 'reserved'], // discard-only
    ['64:ff9b:1::1', 'reserved'], // local-use NAT64
    ['::127.0.0.1', 'reserved'], // deprecated IPv4-compatible
    ['::7f00:1', 'reserved'],
    ['4000::1', 'reserved'], // outside 2000::/3
    ['8000::1', 'reserved'],
    ['e000::1', 'reserved'],
  ])('%s is blocked (%s)', (ip, why) => {
    expect(reason(ip)).toBe(why);
  });

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '2001:200::1', '2a00:1450:4001:81b::200e', '2002:0808:0808::1', '64:ff9b::0808:0808', '3ffe:ffff::1', '2000::1', '3fff:1000::1'])(
    '%s is allowed',
    (ip) => {
      expect(reason(ip)).toBe('allowed');
    },
  );

  it('compresses allowed addresses to the RFC 5952 form', () => {
    const v = classifyIp('2606:4700:4700:0:0:0:0:1111');
    expect(v.allowed && v.canonical).toBe('2606:4700:4700::1111');
    const w = classifyIp('2001:4860:0:0:0:0:0:8888');
    expect(w.allowed && w.canonical).toBe('2001:4860::8888');
  });
});

describe('classifyIp: IPv4-mapped, 6to4 and NAT64 forms follow the embedded IPv4 address', () => {
  it.each<[string, IpBlockReason]>([
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['0:0:0:0:0:ffff:7f00:0001', 'loopback'],
    ['0:0:0:0:0:FFFF:127.0.0.1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:a00:1', 'private'],
    ['::ffff:192.168.1.1', 'private'],
    ['::ffff:172.16.0.1', 'private'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['::ffff:a9fe:a9fe', 'metadata'],
    ['::ffff:0.0.0.0', 'unspecified'],
    ['::ffff:224.0.0.1', 'multicast'],
    ['2002:7f00:0001::1', 'loopback'], // 6to4 of 127.0.0.1
    ['2002:0a00:0001::1', 'private'], // 6to4 of 10.0.0.1
    ['2002:a9fe:a9fe::1', 'metadata'], // 6to4 of 169.254.169.254
    ['64:ff9b::7f00:1', 'loopback'], // NAT64 of 127.0.0.1
    ['64:ff9b::a9fe:a9fe', 'metadata'], // NAT64 of 169.254.169.254
    ['64:ff9b::10.0.0.1', 'private'],
  ])('%s is blocked (%s)', (ip, why) => {
    expect(reason(ip)).toBe(why);
  });

  it('blocks a mapped PUBLIC address too (deny by default: callers connect to the dotted form)', () => {
    expect(reason('::ffff:8.8.8.8')).toBe('reserved');
  });
});

describe('classifyIp: malformed input is blocked as unparseable', () => {
  it.each([
    '',
    'localhost',
    '1.2.3',
    '999.1.1.1',
    '::1::2',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7',
    'g::1',
    '12345::1',
    '[::1]',
    'fe80::1%eth0',
    'fe80::1%25eth0',
    '::ffff:1.2.3',
    '1.2.3.4::',
    ':::',
    '2001:db8:::1',
    'http://127.0.0.1',
    '127.0.0.1/8',
    '0x7f.0.0.1',
    '2130706433',
  ])('%j', (ip) => {
    expect(reason(ip)).toBe('unparseable');
  });

  it('refuses non-string input', () => {
    expect(classifyIp(undefined as unknown as string)).toEqual({ allowed: false, reason: 'unparseable' });
    expect(classifyIp(127 as unknown as string)).toEqual({ allowed: false, reason: 'unparseable' });
  });
});

describe('parseIpv6 and formatIpv6', () => {
  it('parses the full, compressed and embedded-IPv4 forms to the same groups', () => {
    const full = parseIpv6('2001:0db8:0000:0000:0000:0000:0000:0001');
    expect(full).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('2001:db8::1')).toEqual(full);
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIpv6('1:2:3:4:5:6:1.2.3.4')).toEqual([1, 2, 3, 4, 5, 6, 0x0102, 0x0304]);
    expect(parseIpv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('formats with the longest zero run compressed and a single zero left alone', () => {
    expect(formatIpv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])).toBe('2001:db8::1');
    expect(formatIpv6([1, 0, 2, 0, 0, 3, 0, 4])).toBe('1:0:2::3:0:4');
    expect(formatIpv6([1, 2, 3, 4, 5, 6, 7, 8])).toBe('1:2:3:4:5:6:7:8');
    expect(formatIpv6([0, 0, 0, 0, 0, 0, 0, 0])).toBe('::');
  });
});

describe('classifyHostLiteral: URL host spellings', () => {
  it.each<[string, IpBlockReason]>([
    ['127.0.0.1', 'loopback'],
    ['2130706433', 'loopback'],
    ['0x7f.1', 'loopback'],
    ['0x7f000001', 'loopback'],
    ['017700000001', 'loopback'],
    ['0177.0.0.1', 'loopback'],
    ['127.1', 'loopback'],
    ['127.0.0.1.', 'loopback'],
    ['169.254.169.254', 'metadata'],
    ['2852039166', 'metadata'], // 169.254.169.254 in decimal
    ['0xa9fea9fe', 'metadata'],
    ['10.0.0.1', 'private'],
    ['167772161', 'private'], // 10.0.0.1 in decimal
    ['[::1]', 'loopback'],
    ['[::ffff:127.0.0.1]', 'loopback'],
    ['[::ffff:7f00:1]', 'loopback'],
    ['[fe80::1]', 'link_local'],
    ['[fc00::1]', 'unique_local'],
    ['1', 'unspecified'],
  ])('%s -> %s', (host, why) => {
    const v = classifyHostLiteral(host);
    expect(v).not.toBeNull();
    expect(v && !v.allowed && v.reason).toBe(why);
  });

  it('returns an allowed verdict for a public literal (the guard still refuses IP literals)', () => {
    expect(classifyHostLiteral('8.8.8.8')).toMatchObject({ allowed: true });
    expect(classifyHostLiteral('[2606:4700:4700::1111]')).toMatchObject({ allowed: true });
  });

  it('returns null for ordinary names', () => {
    expect(classifyHostLiteral('hooks.slack.com')).toBeNull();
    expect(classifyHostLiteral('example.com.')).toBeNull();
    expect(classifyHostLiteral('127.0.0.1.nip.io')).toBeNull(); // a name: the DNS re-check catches it
    expect(classifyHostLiteral('0x7f.example.com')).toBeNull();
  });

  it('blocks a host whose last label is numeric or 0x-prefixed but not a valid address', () => {
    for (const h of ['1.2.3.4.5', 'example.123', 'a.0x', '256.256.256.256', '[not-an-address]', 'a:b']) {
      const v = classifyHostLiteral(h);
      expect(v).toEqual({ allowed: false, reason: 'unparseable' });
    }
  });
});

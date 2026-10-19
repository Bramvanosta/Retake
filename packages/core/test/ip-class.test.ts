/**
 * L3.5 the address classifier of site extractions (R-MCP-12): every special-purpose IPv4 range refused, IPv6 allowed
 * only in global unicast 2000::/3 minus its special blocks, IPv4-mapped and NAT64 addresses classified by the IPv4
 * address they carry, zones and non-addresses refused.
 */
import { describe, expect, it } from 'vitest';
import { classifyAddress, ipv6Hextets, isPublicAddress } from '../src/index.js';

describe('classifyAddress', () => {
  it.each([
    ['0.0.0.0', /this network/],
    ['10.1.2.3', /private \(10\/8\)/],
    ['100.64.0.1', /carrier-grade NAT/],
    ['100.127.255.254', /carrier-grade NAT/],
    ['127.0.0.1', /loopback/],
    ['127.255.255.254', /loopback/],
    ['169.254.169.254', /link-local/],
    ['172.16.0.1', /private \(172\.16\/12\)/],
    ['172.31.255.255', /private \(172\.16\/12\)/],
    ['192.0.0.8', /IETF protocol/],
    ['192.0.2.10', /documentation/],
    ['192.88.99.1', /6to4 relay/],
    ['192.168.1.1', /private \(192\.168\/16\)/],
    ['198.18.0.1', /benchmarking/],
    ['198.19.255.1', /benchmarking/],
    ['198.51.100.7', /documentation/],
    ['203.0.113.9', /documentation/],
    ['224.0.0.251', /multicast/],
    ['239.255.255.250', /multicast/],
    ['240.0.0.1', /reserved/],
    ['255.255.255.255', /reserved/],
  ])('IPv4 %s is refused (%s)', (a, why) => {
    const c = classifyAddress(a);
    expect(c.public).toBe(false);
    expect(!c.public && c.reason).toMatch(why);
  });

  it.each([
    ['::', /unspecified/],
    ['::1', /loopback/],
    ['::127.0.0.1', /IPv4-compatible/],
    ['::7f00:1', /IPv4-compatible/],
    ['::ffff:127.0.0.1', /IPv4-mapped loopback/],
    ['::ffff:7f00:1', /IPv4-mapped loopback/],
    ['::ffff:169.254.169.254', /IPv4-mapped link-local/],
    ['::ffff:10.0.0.1', /IPv4-mapped private/],
    ['64:ff9b::7f00:1', /NAT64 of loopback/],
    ['64:ff9b::a9fe:a9fe', /NAT64 of link-local/],
    ['64:ff9b:1::1', /local-use NAT64/],
    ['100::1', /discard/],
    ['2001::1', /IETF protocol assignments/],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', /IETF protocol assignments/],
    ['2001:10::1', /IETF protocol assignments/],
    ['2001:20::1', /IETF protocol assignments/],
    ['2001:db8::1', /documentation/],
    ['2002:7f00:1::1', /6to4/],
    ['3fff::1', /documentation \(3fff/],
    ['fc00::1', /unique local/],
    ['fd12:3456::1', /unique local/],
    ['fe80::1', /link-local/],
    ['fec0::1', /site-local/],
    ['ff02::1', /multicast/],
    ['4000::1', /outside global unicast/],
    ['1::1', /outside global unicast/],
  ])('IPv6 %s is refused (%s)', (a, why) => {
    const c = classifyAddress(a);
    expect(c.public).toBe(false);
    expect(!c.public && c.reason).toMatch(why);
  });

  it.each(['93.184.215.14', '1.1.1.1', '8.8.4.4', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '192.88.98.1', '198.20.0.1', '223.255.255.254'])('IPv4 %s is public', (a) => {
    expect(classifyAddress(a)).toEqual({ public: true, family: 4 });
  });

  it.each(['2606:4700::1111', '2a00:1450:4007::64', '2001:4860:4860::8888', '2400:cb00::1', '3ffe::1', '2001:200::1'])('IPv6 %s is public', (a) => {
    expect(classifyAddress(a)).toEqual({ public: true, family: 6 });
  });

  it('IPv4-mapped and NAT64 forms of a public address are public (DNS64 networks give every site one)', () => {
    expect(isPublicAddress('::ffff:1.1.1.1')).toBe(true);
    expect(isPublicAddress('::ffff:101:101')).toBe(true);
    expect(isPublicAddress('64:ff9b::101:101')).toBe(true);
    expect(isPublicAddress('64:ff9b::1.1.1.1')).toBe(true);
  });

  it('brackets are tolerated; zones, names and garbage are refused', () => {
    expect(isPublicAddress('[2606:4700::1111]')).toBe(true);
    expect(classifyAddress('fe80::1%en0')).toEqual({ public: false, reason: 'a scoped (zone) address' });
    for (const a of ['localhost', 'brand.example', '', '1.2.3', '256.1.1.1', '::g', '1.1.1.1.']) expect(isPublicAddress(a), a).toBe(false);
  });

  it('ipv6Hextets expands :: and an embedded dotted IPv4', () => {
    expect(ipv6Hextets('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ipv6Hextets('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(ipv6Hextets('2001:db8::8:800:200c:417a')).toEqual([0x2001, 0xdb8, 0, 0, 8, 0x800, 0x200c, 0x417a]);
    expect(ipv6Hextets('1.2.3.4')).toBeNull();
  });
});

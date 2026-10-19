/**
 * Public or not (L3.5, R-MCP-12): the classifier of the addresses a site extraction may connect to. Pure: the CONNECT
 * proxy of the worker (runner-web site/proxy.ts) asks it for EVERY address a name resolves to and refuses the name
 * unless all of them are public unicast — an address that is loopback, private, link-local (169.254.169.254, the cloud
 * metadata service), carrier-grade NAT, documentation, benchmarking, multicast, reserved or any IPv6 special block.
 *
 * IPv4 is a block list of the special-purpose ranges (RFC 6890 and its updates). IPv6 is an ALLOW list: only global
 * unicast 2000::/3, minus its special blocks (2001::/23 — Teredo, ORCHID…, 2001:db8::/32 documentation, 2002::/16
 * 6to4, 3fff::/20 documentation) — so ::/96 (IPv4-compatible), fec0::/10 (site-local), fc00::/7, fe80::/10, ff00::/8,
 * 64:ff9b:1::/48 (local-use NAT64) and anything unassigned are refused. Two forms carry an IPv4 address and are
 * classified by it: IPv4-mapped ::ffff:a.b.c.d, and NAT64 64:ff9b::/96 (DNS64 networks give every site such an
 * address: refusing them outright would make the tool unusable there).
 *
 * "Public" is a property of the address, not of the route: a VPN or split-horizon DNS can still route a public range
 * to a private network (documented, not detectable here).
 */
import { BlockList, isIP } from 'node:net';

/** Special-purpose IPv4 ranges, with why each one is refused. */
const IPV4_SPECIAL: ReadonlyArray<[string, number, string]> = [
  ['0.0.0.0', 8, 'this network (0/8)'],
  ['10.0.0.0', 8, 'private (10/8)'],
  ['100.64.0.0', 10, 'carrier-grade NAT (100.64/10)'],
  ['127.0.0.0', 8, 'loopback (127/8)'],
  ['169.254.0.0', 16, 'link-local (169.254/16, cloud metadata)'],
  ['172.16.0.0', 12, 'private (172.16/12)'],
  ['192.0.0.0', 24, 'IETF protocol assignments (192.0.0/24)'],
  ['192.0.2.0', 24, 'documentation (192.0.2/24)'],
  ['192.88.99.0', 24, '6to4 relay anycast (192.88.99/24)'],
  ['192.168.0.0', 16, 'private (192.168/16)'],
  ['198.18.0.0', 15, 'benchmarking (198.18/15)'],
  ['198.51.100.0', 24, 'documentation (198.51.100/24)'],
  ['203.0.113.0', 24, 'documentation (203.0.113/24)'],
  ['224.0.0.0', 4, 'multicast (224/4)'],
  ['240.0.0.0', 4, 'reserved (240/4, broadcast)'],
];

/** Special blocks inside 2000::/3 (global unicast), refused. */
const IPV6_SPECIAL_GLOBAL: ReadonlyArray<[string, number, string]> = [
  ['2001::', 23, 'IETF protocol assignments (2001::/23: Teredo, ORCHID…)'],
  ['2001:db8::', 32, 'documentation (2001:db8::/32)'],
  ['2002::', 16, '6to4 (2002::/16)'],
  ['3fff::', 20, 'documentation (3fff::/20)'],
];

/** Names of the IPv6 blocks outside 2000::/3, for the message only (everything outside it is refused). */
const IPV6_NAMED: ReadonlyArray<[string, number, string]> = [
  ['::', 128, 'unspecified (::)'],
  ['::1', 128, 'loopback (::1)'],
  ['::', 96, 'IPv4-compatible (::/96)'],
  ['64:ff9b:1::', 48, 'local-use NAT64 (64:ff9b:1::/48)'],
  ['100::', 64, 'discard (100::/64)'],
  ['fc00::', 7, 'unique local (fc00::/7)'],
  ['fe80::', 10, 'link-local (fe80::/10)'],
  ['fec0::', 10, 'site-local (fec0::/10)'],
  ['ff00::', 8, 'multicast (ff00::/8)'],
];

function list(entries: ReadonlyArray<[string, number, string]>, family: 'ipv4' | 'ipv6'): Array<{ bl: BlockList; why: string }> {
  return entries.map(([a, p, why]) => {
    const bl = new BlockList();
    bl.addSubnet(a, p, family);
    return { bl, why };
  });
}

const V4 = list(IPV4_SPECIAL, 'ipv4');
const V6_GLOBAL_SPECIAL = list(IPV6_SPECIAL_GLOBAL, 'ipv6');
const V6_NAMED = list(IPV6_NAMED, 'ipv6');
const GLOBAL_UNICAST = (() => {
  const bl = new BlockList();
  bl.addSubnet('2000::', 3, 'ipv6');
  return bl;
})();

export type AddressClass = { public: true; family: 4 | 6 } | { public: false; reason: string };

/** The 8 hextets of an IPv6 address (an embedded dotted IPv4 accepted), or null. */
export function ipv6Hextets(addr: string): number[] | null {
  if (isIP(addr) !== 6) return null;
  let s = addr.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    s = `${s.slice(0, -v4[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t].map((x) => parseInt(x, 16));
  return parts.length === 8 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? parts : null;
}

function embeddedV4(hx: number[]): string {
  return [hx[6] >> 8, hx[6] & 0xff, hx[7] >> 8, hx[7] & 0xff].join('.');
}

function classifyV4(a: string): AddressClass {
  const hit = V4.find((r) => r.bl.check(a, 'ipv4'));
  return hit ? { public: false, reason: hit.why } : { public: true, family: 4 };
}

/**
 * Whether an address is public unicast (see the module comment). Brackets and one trailing dot are tolerated; a zone
 * id (`fe80::1%en0`) or anything that is not an IP address is refused.
 */
export function classifyAddress(address: string): AddressClass {
  const a = address.trim().replace(/^\[(.*)\]$/, '$1');
  if (a.includes('%')) return { public: false, reason: 'a scoped (zone) address' };
  const family = isIP(a);
  if (family === 4) return classifyV4(a);
  if (family !== 6) return { public: false, reason: 'not an IP address' };
  const hx = ipv6Hextets(a);
  if (!hx) return { public: false, reason: 'not an IP address' };
  // IPv4-mapped ::ffff:0:0/96 and NAT64 64:ff9b::/96: the IPv4 address they carry decides.
  if (hx.slice(0, 5).every((x) => x === 0) && hx[5] === 0xffff) {
    const r = classifyV4(embeddedV4(hx));
    return r.public ? { public: true, family: 6 } : { public: false, reason: `IPv4-mapped ${r.reason}` };
  }
  if (hx[0] === 0x64 && hx[1] === 0xff9b && hx.slice(2, 6).every((x) => x === 0)) {
    const r = classifyV4(embeddedV4(hx));
    return r.public ? { public: true, family: 6 } : { public: false, reason: `NAT64 of ${r.reason}` };
  }
  const canonical = hx.map((x) => x.toString(16)).join(':');
  if (!GLOBAL_UNICAST.check(canonical, 'ipv6')) {
    const named = V6_NAMED.find((r) => r.bl.check(canonical, 'ipv6'));
    return { public: false, reason: named ? named.why : 'outside global unicast (2000::/3)' };
  }
  const hit = V6_GLOBAL_SPECIAL.find((r) => r.bl.check(canonical, 'ipv6'));
  return hit ? { public: false, reason: hit.why } : { public: true, family: 6 };
}

export function isPublicAddress(address: string): boolean {
  return classifyAddress(address).public;
}

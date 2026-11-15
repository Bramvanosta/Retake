/** The host resolver port and the product's adapter: how the protected-hosts check resolves a name (protected-hosts.ts). */
import { lookup } from 'node:dns/promises';

/** Resolves a name to its addresses (the system resolver, /etc/hosts included). */
export type HostLookup = (name: string) => Promise<readonly string[]>;

/**
 * How names are resolved next to an IP literal (ports.ts EnginePorts `hosts`): a lookup and its deadline per name. The
 * product's is the system resolver, at most 2 s a name (systemHosts); a test hands one of its own (no real DNS).
 */
export interface HostResolver {
  lookup: HostLookup;
  timeoutMs: number;
}

/** The system resolver, at most 2 s a name: the product's HostResolver (the ports bag's default). */
export function systemHosts(): HostResolver {
  return { lookup: async (name) => (await lookup(name, { all: true, verbatim: true })).map((a) => a.address), timeoutMs: 2000 };
}

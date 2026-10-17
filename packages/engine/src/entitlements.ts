/**
 * Entitlements (L3.1 guard-rail, a parked commercial hook — docs/BACKLOG.md): what this installation may do. Today
 * everything, with no limit: Demo Studio is a local tool for its own users. The one place a licence check would answer
 * from later; the usage it would compare against is the job history (history.ts).
 */
export interface Entitlements {
  tier: 'internal';
  /** Every feature of this version. */
  features: 'all';
  /** No limit on captures or renders. */
  limits: null;
}

export function entitlements(): Entitlements {
  return { tier: 'internal', features: 'all', limits: null };
}

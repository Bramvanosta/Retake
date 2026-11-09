/** The per-call memo of an inspection. */
// ─────────────────────── per-call memo (L3.3) ───────────────────────
// An inspection (`inventory`, `checkTargets`) runs many resolver lookups in one synchronous call: the DOM cannot change
// during it, so the trees, selector queries, visibility, names, label pairs, texts and rows are computed once each.
// Set only for the length of such a call (null otherwise: every other kit call sees the live DOM).
interface Memo {
  trees: Map<Element, { list: Array<Element | ShadowRoot>; cross: number }>;
  qsa: Map<string, Map<Element, Element[]>>;
  vis: Map<Element, boolean>;
  names: Map<Element, string>;
  labels: Map<Element, Array<{ control: Element; text: string }>>;
  low: Map<Node, string>;
  rows: Map<string, Element | null>;
}
export let memo: Memo | null = null;
export function withMemo<T>(fn: () => T): T {
  if (memo) return fn();
  memo = { trees: new Map(), qsa: new Map(), vis: new Map(), names: new Map(), labels: new Map(), low: new Map(), rows: new Map() };
  try {
    return fn();
  } finally {
    memo = null;
  }
}

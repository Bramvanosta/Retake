/**
 * Compact results (L5.8, R-FLD-34): what review / review_get and page_inspect return by default — the findings, the
 * paths to read — and, with `detail: "full"`, everything as before. The field measured ≈ 15,000 tokens per
 * page_inspect and over 25,000 for a review (cut by the client). Nothing the summary says is dropped: the files keep the
 * rest (inspect.json, report.json). The `detail` argument, the run status's compact (L7.13) and the review's (L7.14)
 * are the engine's operations' (@retake/engine/contract), re-exported here.
 *
 * Trust is unchanged: what the filmed site or the scenario wrote stays under `untrusted` (capUntrusted still applies).
 */
import { cutMessage as cut } from '@retake/engine/contract';

export { COMPACT_FINDINGS_MAX, COMPACT_MESSAGE_MAX, COMPACT_WARNINGS_MAX, compactReview, compactRunStatus, detail } from '@retake/engine/contract';
export type { Detail } from '@retake/engine/contract';

/** One inspected element, compact: its mark, where it is, its action and the step hint to copy; flags only when set. */
export interface CompactElement {
  mark: number;
  in: string;
  action: string;
  /** Visible matches of its target without `nth`, when not 1. */
  matches?: number;
  fragile?: string[];
  /** Its state flags that are set: disabled, expanded, checked, selected, covered. */
  state?: string[];
  /** Out of view (listed because it is in a dialog, a menu or a popover). */
  out_of_view?: true;
  untrusted: { role: string | null; name: string; hint?: string; target?: string | null; href_path?: string };
}

const STATE_FLAGS = ['disabled', 'expanded', 'checked', 'selected', 'covered'] as const;

/** Elements of an inspection, compact: those in view or in a dialog, menu, listbox or popover. */
export function compactElements(elements: ReadonlyArray<Record<string, unknown>>): { elements: CompactElement[]; left_out: number } {
  const out: CompactElement[] = [];
  let left = 0;
  for (const e of elements) {
    const inView = e.in_view === true;
    const floating = e.in !== 'page' && e.in !== 'row';
    if (!inView && !floating) {
      left++;
      continue;
    }
    const u = (e.untrusted ?? {}) as Record<string, unknown>;
    const st = (e.state ?? {}) as Record<string, unknown>;
    const flags = STATE_FLAGS.filter((k) => st[k] === true);
    const fragile = Array.isArray(e.fragile) ? (e.fragile as string[]) : [];
    const hint = (u.hint as { yaml?: string } | null | undefined)?.yaml;
    const name = typeof u.name === 'string' ? cut(u.name, 120) : '';
    out.push({
      mark: e.mark as number,
      in: String(e.in),
      action: String(e.action),
      ...(typeof e.matches === 'number' && e.matches !== 1 ? { matches: e.matches } : {}),
      ...(fragile.length ? { fragile } : {}),
      ...(flags.length ? { state: [...flags] } : {}),
      ...(!inView ? { out_of_view: true as const } : {}),
      untrusted: {
        role: (u.role as string | null) ?? null,
        name,
        ...(hint ? { hint } : { target: (u.target_yaml as string | null) ?? null }),
        ...(typeof u.href_path === 'string' && u.role === 'link' ? { href_path: u.href_path } : {}),
      },
    });
  }
  return { elements: out, left_out: left };
}

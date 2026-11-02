/**
 * L5.9: the segmented control — `Segmented` picks one value (a `fieldset` of native radios: one tab stop, the arrows
 * move, Space checks), `SegmentedLinks` goes to one of a few places (a `nav` of links, the current one
 * `aria-current="page"`; a link without a place is a disabled button with the reason beside it). Each radio covers its
 * segment (appearance none, nothing painted) so the click, the focus ring and the label are one box; the current
 * segment is a raised fill and weight 600 (more than colour: the checker's `selected` rule).
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import { hrefTo } from '../route.js';
import type { Route } from '../route.js';
import { shown } from '../bits.js';

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  /** L5.12b: a test id on the option's radio (the comments filters keep theirs). */
  testId?: string;
}

export function Segmented<V extends string>({ label, value, options, onChange, size = 'md' }: { label: string; value: V; options: Array<SegmentOption<V>>; onChange: (v: V) => void; size?: 'sm' | 'md' }) {
  const name = useId();
  return (
    <fieldset className={`k-seg k-seg-${size}`}>
      <legend className="k-sr">{shown(label)}</legend>
      {options.map((o) => (
        <label key={o.value} className={o.value === value ? 'k-seg-item is-current' : 'k-seg-item'}>
          <input type="radio" className="k-seg-input" name={name} value={o.value} checked={o.value === value} disabled={o.disabled} onChange={() => onChange(o.value)} data-testid={o.testId} />
          <span className="k-seg-label">{shown(o.label)}</span>
        </label>
      ))}
    </fieldset>
  );
}

export interface SegmentLink {
  key: string;
  label: ReactNode;
  /** The place; none: the segment is shown disabled. */
  to: Route | null;
  current: boolean;
  /** L5.12a: a test id kept from an older screen (Review's Comments: `comments-tab`). */
  testId?: string;
}

export function SegmentedLinks({ label, items, hint }: { label: string; items: SegmentLink[]; hint?: ReactNode }) {
  const hintId = useId();
  // The reason is there whenever a segment is off (review A-L4: a disabled segment never points at a missing id).
  const off = items.some((i) => !i.to);
  return (
    <nav className="k-seg k-seg-md k-seg-links" aria-label={label}>
      {items.map((i) =>
        i.to ? (
          <a key={i.key} href={hrefTo(i.to)} className={i.current ? 'k-seg-item is-current' : 'k-seg-item'} aria-current={i.current ? 'page' : undefined} data-testid={i.testId}>
            <span className="k-seg-label">{shown(i.label)}</span>
          </a>
        ) : (
          <button key={i.key} type="button" className="k-seg-item" disabled aria-describedby={hint ? hintId : undefined}>
            <span className="k-seg-label">{shown(i.label)}</span>
          </button>
        ),
      )}
      {hint && off && (
        <span id={hintId} className="k-sr">
          {shown(hint)}
        </span>
      )}
    </nav>
  );
}

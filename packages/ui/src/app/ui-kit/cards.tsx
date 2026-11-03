/**
 * L5.9: cards — `FrameCard` (a scene's frame: 16:9 picture, its number, a title and a meta line) and `PosterCard` (a
 * production's poster, larger, the title under it). The picture comes from Thumb.tsx (the app's one image source); the
 * card is ONE control — a `<button aria-pressed>` when it selects, an `<a href>` when it goes somewhere. Selected: the
 * selection fill and a 2 px ring (more than colour).
 * L5.10a: `PosterGrid` — the productions as ONE listbox (critique M6: one tab stop, `aria-activedescendant`): the arrows
 * move the selection (← → one, ↑ ↓ a row), Home / End, Enter opens the selected one, Space selects, Escape clears the
 * selection; a click selects, a double-click opens. Nothing is selected until the person picks (the inspector then
 * shows the project). Selected: the selection fill and a 2 px ring.
 * L5.10a fixes (review B-M2): the grid has as many columns as fit (CSS auto-fill); ↑ ↓ move by the row the browser laid
 * out (its computed columns). Nothing selected: no `aria-activedescendant` at all (review A-L6: never an empty one).
 * L5.12c fixes: a selecting card can be one stop of a roving grid (`tabIndex`) and be named by its title alone
 * (`labelledBy` / `describedBy`: the picture's alt is not said before the name — the Library, review A-L7).
 */
import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { hrefTo } from '../route.js';
import type { Route } from '../route.js';
import { shown } from '../bits.js';

interface CardProps {
  picture: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  number?: ReactNode;
  selected?: boolean;
  /** Selects (a button) … */
  onSelect?: () => void;
  /** … or goes to a place (a link). */
  to?: Route;
  /** L5.12c: a roving grid's stop (0) or not (-1). */
  tabIndex?: number;
  /** L5.12c: the ids naming and describing the selecting button (its title, its meta). */
  labelledBy?: string;
  describedBy?: string;
}

function Card({ kind, picture, title, meta, number, selected, onSelect, to, tabIndex, labelledBy, describedBy }: CardProps & { kind: 'frame' | 'poster' }) {
  const body = (
    <>
      <span className={`k-card-picture k-card-picture-${kind}`}>
        {shown(picture)}
        {number !== undefined && <span className="k-card-number k-mono">{shown(number)}</span>}
      </span>
      <span className="k-card-title">{shown(title)}</span>
      {meta && <span className="k-card-meta">{shown(meta)}</span>}
    </>
  );
  const cls = `k-card k-card-${kind}${selected ? ' is-selected' : ''}`;
  if (to) {
    return (
      <a href={hrefTo(to)} className={cls} aria-current={selected ? 'page' : undefined}>
        {shown(body)}
      </a>
    );
  }
  return (
    <button type="button" className={cls} aria-pressed={selected ?? false} onClick={onSelect} tabIndex={tabIndex} aria-labelledby={labelledBy} aria-describedby={describedBy}>
      {shown(body)}
    </button>
  );
}

export const FrameCard = (p: CardProps) => <Card kind="frame" {...p} />;
export const PosterCard = (p: CardProps) => <Card kind="poster" {...p} />;

export interface PosterItem {
  id: string;
  picture: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
}

/** The columns a grid's layout has now (1 when it cannot tell). */
export function gridColumns(el: HTMLElement | null): number {
  if (!el || typeof getComputedStyle !== 'function') return 1;
  const cols = getComputedStyle(el).gridTemplateColumns.split(' ').filter((t) => t && t !== 'none').length;
  return Math.max(1, cols);
}

export function PosterGrid({ label, items, selected, onSelect, onOpen, describedBy }: { label: string; items: PosterItem[]; selected: string | null; onSelect: (id: string | null) => void; onOpen: (id: string) => void; describedBy?: string }) {
  const base = useId();
  const list = useRef<HTMLUListElement>(null);
  const optionId = (id: string) => `${base}-${items.findIndex((i) => i.id === id)}`;
  const at = selected === null ? -1 : items.findIndex((i) => i.id === selected);
  // The selected option stays in view (inside the centre pane: `nearest`).
  useEffect(() => {
    if (at >= 0) list.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
  }, [at]);
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || items.length === 0) return;
    const last = items.length - 1;
    const columns = e.key === 'ArrowDown' || e.key === 'ArrowUp' ? gridColumns(list.current) : 1;
    let next = -2;
    if (e.key === 'ArrowRight') next = at < 0 ? 0 : Math.min(last, at + 1);
    else if (e.key === 'ArrowLeft') next = at < 0 ? 0 : Math.max(0, at - 1);
    else if (e.key === 'ArrowDown') next = at < 0 ? 0 : Math.min(last, at + columns);
    else if (e.key === 'ArrowUp') next = at < 0 ? 0 : Math.max(0, at - columns);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === ' ') next = at < 0 ? 0 : at;
    else if (e.key === 'Enter') {
      if (at >= 0) {
        e.preventDefault();
        onOpen(items[at].id);
      }
      return;
    } else if (e.key === 'Escape') {
      if (at >= 0) {
        e.preventDefault();
        onSelect(null);
      }
      return;
    }
    if (next < -1) return;
    e.preventDefault();
    if (next !== at) onSelect(items[next].id);
  };
  return (
    <ul
      ref={list}
      className="k-posters"
      role="listbox"
      aria-label={label}
      aria-describedby={describedBy}
      tabIndex={0}
      aria-activedescendant={at >= 0 ? optionId(items[at].id) : undefined}
      onKeyDown={onKeyDown}
      // A click on the grid's empty space clears the selection (the inspector shows the project again).
      onClick={(e) => e.target === e.currentTarget && onSelect(null)}
    >
      {items.map((i, n) => (
        <li
          key={i.id}
          id={`${base}-${n}`}
          data-index={n}
          data-id={i.id}
          role="option"
          aria-selected={n === at}
          className={`k-card k-card-poster k-poster${n === at ? ' is-selected' : ''}`}
          onClick={() => onSelect(i.id)}
          onDoubleClick={() => onOpen(i.id)}
        >
          <span className="k-card-picture k-card-picture-poster">{shown(i.picture)}</span>
          <span className="k-card-title">{shown(i.title)}</span>
          {i.meta && <span className="k-card-meta">{shown(i.meta)}</span>}
        </li>
      ))}
    </ul>
  );
}

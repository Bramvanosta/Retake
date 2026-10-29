/**
 * L5.9: cards — `FrameCard` (a scene's frame: 16:9 picture, its number, a title and a meta line) and `PosterCard` (a
 * production's poster, larger, the title under it). The picture comes from Thumb.tsx (the app's one image source); the
 * card is ONE control — a `<button aria-pressed>` when it selects, an `<a href>` when it goes somewhere. Selected: the
 * selection fill and a 2 px ring (more than colour).
 */
import type { ReactNode } from 'react';
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
}

function Card({ kind, picture, title, meta, number, selected, onSelect, to }: CardProps & { kind: 'frame' | 'poster' }) {
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
    <button type="button" className={cls} aria-pressed={selected ?? false} onClick={onSelect}>
      {shown(body)}
    </button>
  );
}

export const FrameCard = (p: CardProps) => <Card kind="frame" {...p} />;
export const PosterCard = (p: CardProps) => <Card kind="poster" {...p} />;

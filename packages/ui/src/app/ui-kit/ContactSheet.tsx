/**
 * L5.12a: `ContactSheet` (R4-Review) — labelled rows of pictures (a review's contact sheets: the whole video, each scene,
 * key frames), each a figure: its picture inside a toggle button that shows it larger in place (`aria-pressed`), or a
 * line of words while it loads or when it cannot be read; its label (and a meta line: a time) as the caption. The
 * pictures are the caller's (Thumb.tsx's one image source); `Tag` — a non-interactive label (a source, "Built-in", an
 * anchor's chip): text, never a state (a state is a StatusMark).
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { shown, visibleControls } from '../bits.js';

export interface ContactSheetItem {
  key: string;
  /** Its name in words (the toggle's name: "<name>, larger" — one name; aria-pressed says whether it is: review A-L4). */
  name: string;
  label: ReactNode;
  meta?: ReactNode;
  /** The picture once loaded, else null (then `words` say why). */
  picture: ReactNode | null;
  state: 'waiting' | 'ok' | 'error';
  words?: ReactNode;
  testId?: string;
}

function SheetFigure({ item }: { item: ContactSheetItem }) {
  const [large, setLarge] = useState(false);
  return (
    <figure className={`k-contact-item${large ? ' is-large' : ''}`} data-testid={item.testId} data-state={item.state}>
      {item.picture !== null ? (
        <button type="button" className="k-contact-button" aria-pressed={large} aria-label={visibleControls(`${item.name}, larger`)} onClick={() => setLarge(!large)}>
          {shown(item.picture)}
        </button>
      ) : (
        <p className="k-contact-words">{shown(item.words ?? '')}</p>
      )}
      <figcaption className="k-contact-caption">
        <span className="k-contact-label">{shown(item.label)}</span>
        {item.meta !== undefined && <span className="k-contact-meta k-mono">{shown(item.meta)}</span>}
      </figcaption>
    </figure>
  );
}

export function ContactSheet({ labelledBy, items, testId }: { labelledBy?: string; items: ContactSheetItem[]; testId?: string }) {
  return (
    <div className="k-contact" role="group" aria-labelledby={labelledBy} data-testid={testId}>
      {items.map((i) => (
        <SheetFigure key={i.key} item={i} />
      ))}
    </div>
  );
}

export function Tag({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span className="k-tag" data-testid={testId}>
      {shown(children)}
    </span>
  );
}

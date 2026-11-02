/**
 * L5.10b: the storyboard's pieces — `FrameGrid` (a scene's frames as ONE listbox laid out in a grid: the caller holds
 * the selection and its keys; the list holds the tab stop through `aria-activedescendant`), `FrameOption` (a frame: its
 * picture with the step's number over it, a title line, a meta line; selected: the selection fill and a 2 px ring; a
 * drop targeting it: a 3 px insertion bar on its left or right; dragged: a dashed outline and a dimmed picture) and
 * `RowCard` (a one-line card between scenes — a card, Before / After filming: a `<button aria-pressed>` that selects).
 *
 * Drag & drop (critique M7): the list takes `dragover` / `drop` itself, so the 24 px gaps between frames belong to it;
 * the slot comes from the pointer (`slotFromPointer`: the nearest row by Y, then the frame's half by X; past the last
 * frame of the last row — the trailing empty cells — the end of the scene). The caller says whether it accepts a slot
 * (a drag that started in this document, a scene that is not locked): nothing else is ever read from the drag.
 */
import type { DragEvent, FocusEvent, KeyboardEvent, ReactNode, Ref } from 'react';
import { shown, visibleControls } from '../bits.js';

/** A frame's box on screen (getBoundingClientRect's four sides). */
export interface FrameRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * The gap a pointer at (x, y) means among frames laid out in rows (in order): 0 … rects.length. The row is the one whose
 * vertical span holds y, else the nearest; inside it, the frame under x (or the nearest) and its half: the left half is
 * that frame's index, the right half the next one. Pure (unit-tested): what the insertion bar and the drop agree on.
 */
export function slotFromPointer(rects: readonly FrameRect[], x: number, y: number): number {
  if (rects.length === 0) return 0;
  // Rows: runs of frames that share a top (a new row starts where a frame sits lower than the one before).
  const rows: number[][] = [];
  rects.forEach((r, i) => {
    const last = rows[rows.length - 1];
    if (last && Math.abs(rects[last[0]].top - r.top) < 1) last.push(i);
    else rows.push([i]);
  });
  let row = rows[0];
  let best = Infinity;
  for (const cand of rows) {
    const top = Math.min(...cand.map((i) => rects[i].top));
    const bottom = Math.max(...cand.map((i) => rects[i].bottom));
    const d = y < top ? top - y : y > bottom ? y - bottom : 0;
    if (d < best) {
      best = d;
      row = cand;
    }
  }
  let at = row[0];
  let near = Infinity;
  for (const i of row) {
    const r = rects[i];
    const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    if (d < near) {
      near = d;
      at = i;
    }
  }
  const r = rects[at];
  return x < (r.left + r.right) / 2 ? at : at + 1;
}

/** The insertion bar for a gap, drawn on ONE side (critique M7): after the frame before it, before the first frame. */
export function dropSide(gap: number, index: number): 'before' | 'after' | null {
  if (gap === 0) return index === 0 ? 'before' : null;
  return index === gap - 1 ? 'after' : null;
}

export interface FrameDrag {
  /** A slot is under the pointer: true when the caller accepts a drop there (the bar is the caller's state). */
  over: (slot: number) => boolean;
  /** Dropped: true when the caller took it. */
  drop: () => boolean;
}

export function FrameGrid({
  label,
  activeId,
  tabbable,
  describedBy,
  listRef,
  onKeyDown,
  onFocus,
  drag,
  empty,
  emptyTarget,
  children,
}: {
  label: string;
  /** The selected option's id (only on the list holding the selection: never an empty reference). */
  activeId?: string;
  /** The list holds the tab stop (one list of all the scenes' lists). */
  tabbable: boolean;
  describedBy?: string;
  listRef?: Ref<HTMLUListElement>;
  onKeyDown?: (e: KeyboardEvent<HTMLUListElement>) => void;
  /** The list took the focus (the caller gives it an active option when the selection is elsewhere). */
  onFocus?: (e: FocusEvent<HTMLUListElement>) => void;
  drag?: FrameDrag;
  /** Shown instead of the list when there is no frame (the scene's drop zone). */
  empty?: ReactNode;
  /** A drop targets the empty scene (its zone is outlined). */
  emptyTarget?: boolean;
  children: ReactNode[];
}) {
  const over = (e: DragEvent<HTMLElement>) => {
    if (!drag) return;
    const list = e.currentTarget;
    const rects = [...list.querySelectorAll<HTMLElement>(':scope > [role="option"]')].map((el) => el.getBoundingClientRect());
    if (!drag.over(slotFromPointer(rects, e.clientX, e.clientY))) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
  };
  const dropped = (e: DragEvent<HTMLElement>) => {
    if (drag?.drop()) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  if (children.length === 0) {
    return (
      <p className={emptyTarget ? 'k-frames-empty is-target' : 'k-frames-empty'} data-testid="drop-empty" onDragOver={over} onDrop={dropped}>
        {shown(empty)}
      </p>
    );
  }
  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label={visibleControls(label)}
      aria-orientation="horizontal"
      aria-activedescendant={activeId}
      aria-describedby={describedBy}
      tabIndex={tabbable ? 0 : -1}
      className="k-frames"
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onDragOver={over}
      onDrop={dropped}
    >
      {shown(children)}
    </ul>
  );
}

export function FrameOption({
  id,
  dataKey,
  testId,
  label,
  selected,
  picture,
  number,
  title,
  meta,
  draggable,
  drop,
  dragging,
  onPick,
  onPress,
  onDragStart,
  onDragEnd,
}: {
  id: string;
  dataKey: string;
  testId?: string;
  /** Its name (scene, number, verb, target and state words: direction controls made visible). */
  label: string;
  selected: boolean;
  picture: ReactNode;
  number: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  draggable: boolean;
  drop: 'before' | 'after' | null;
  dragging: boolean;
  onPick: () => void;
  /** The primary button went down on it (before a click or a drag): the caller makes it the active option. */
  onPress?: () => void;
  onDragStart?: (e: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
}) {
  const cls = ['k-frame', selected ? 'is-selected' : '', draggable ? 'is-draggable' : '', drop ? `is-drop-${drop}` : '', dragging ? 'is-dragging' : ''].filter(Boolean).join(' ');
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={visibleControls(label)}
      className={cls}
      data-key={dataKey}
      data-testid={testId}
      onClick={onPick}
      onMouseDown={onPress ? (e) => e.button === 0 && onPress() : undefined}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={onDragEnd}
    >
      <span className="k-frame-picture">
        {shown(picture)}
        <span className="k-frame-number k-mono">{shown(number)}</span>
      </span>
      <span className="k-frame-title">{shown(title)}</span>
      {meta && <span className="k-frame-meta">{shown(meta)}</span>}
    </li>
  );
}

/**
 * A one-line card (B32's row between scenes): a tile (a word on the video tone, or a picture), a title and a meta line;
 * a `<button aria-pressed>` that selects it into the inspector.
 */
export function RowCard({ tile, title, meta, selected, onSelect, testId, quiet }: { tile: ReactNode; title: ReactNode; meta?: ReactNode; selected: boolean; onSelect: () => void; testId?: string; quiet?: boolean }) {
  return (
    <button type="button" className={`k-rowcard${selected ? ' is-selected' : ''}${quiet ? ' is-quiet' : ''}`} aria-pressed={selected} onClick={onSelect} data-testid={testId}>
      <span className="k-rowcard-tile">{shown(tile)}</span>
      <span className="k-rowcard-text">
        <span className="k-rowcard-title">{shown(title)}</span>
        {meta && <span className="k-rowcard-meta">{shown(meta)}</span>}
      </span>
    </button>
  );
}

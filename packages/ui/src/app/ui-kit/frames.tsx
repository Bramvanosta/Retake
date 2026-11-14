/**
 * L5.10b: the storyboard's pieces — `FrameGrid` (a scene's frames as ONE listbox laid out in a grid: the caller holds
 * the selection and its keys; the list holds the tab stop through `aria-activedescendant`), `FrameOption` (a frame: its
 * picture with the step's number over it, a title line, a meta line; selected: the selection fill and a 2 px ring; a
 * drop targeting it: a 3 px insertion bar on its left or right; dragged: a dashed outline and a dimmed picture) and
 * `RowCard` (a one-line card between scenes — a card, Before / After filming: a `<button aria-pressed>` that selects).
 * L5.11b fixes (review A-M2): `RowList` / `RowListItem` — a list of compact rows (the Record screen's draft), a listbox
 * when the caller holds its keys (one tab stop, `aria-activedescendant`; its items `role="none"` around a RowCard option
 * or the caller's own group between options).
 *
 * Drag & drop (critique M7): the list takes `dragover` / `drop` itself, so the 24 px gaps between frames belong to it;
 * the slot comes from the pointer (`slotFromPointer`: the nearest row by Y, then the frame's half by X; past the last
 * frame of the last row — the trailing empty cells — the end of the scene). The caller says whether it accepts a slot
 * (a drag that started in this document, a scene that is not locked): nothing else is ever read from the drag.
 */
import { createContext, useContext } from 'react';
import type { DragEvent, FocusEvent, KeyboardEvent, ReactNode, Ref } from 'react';
import { shown, visibleControls } from '../bits.js';
import { hrefTo } from '../route.js';
import type { Route } from '../route.js';

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
 * a `<button aria-pressed>` that selects it into the inspector. L5.11b: `compact` — a list row (the Record screen's draft):
 * the tile a narrow lead column (a step number), a word on the right (`aside`: under the text in a narrow list), the title
 * at the body size; `option` — an option of the caller's listbox instead of a button (review A-M2).
 */
export function RowCard({
  tile,
  title,
  meta,
  aside,
  selected,
  onSelect,
  testId,
  quiet,
  compact,
  option,
  to,
}: {
  tile: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
  selected: boolean;
  /** Its action (a row that selects); a link row (`to`) needs none. */
  onSelect?: () => void;
  testId?: string;
  quiet?: boolean;
  compact?: boolean;
  /**
   * L5.11b fixes (review A-M2): an option of a listbox the caller holds (one tab stop, `aria-activedescendant`, its keys):
   * its id, whether it is the active one (the list's focus ring marks it) — never a tab stop of its own.
   */
  option?: { id: string; active: boolean };
  /**
   * L5.12a fixes (review A-L5): a row that opens another screen (a render's report) is a link — `aria-current` marks the
   * row of the screen shown — never a toggle that says "not pressed".
   */
  to?: Route;
}) {
  const cls = `k-rowcard${selected ? ' is-selected' : ''}${quiet ? ' is-quiet' : ''}${compact ? ' is-compact' : ''}${option?.active ? ' is-active' : ''}`;
  const body = (
    <>
      <span className="k-rowcard-tile">{shown(tile)}</span>
      <span className="k-rowcard-text">
        <span className="k-rowcard-title">{shown(title)}</span>
        {meta && <span className="k-rowcard-meta">{shown(meta)}</span>}
      </span>
      {aside !== undefined && aside !== null && <span className="k-rowcard-aside">{shown(aside)}</span>}
    </>
  );
  if (to) {
    return (
      <a href={hrefTo(to)} className={cls} aria-current={selected ? 'page' : undefined} data-testid={testId}>
        {shown(body)}
      </a>
    );
  }
  if (option) {
    return (
      <div id={option.id} role="option" aria-selected={selected} className={cls} onClick={onSelect} data-testid={testId}>
        {shown(body)}
      </div>
    );
  }
  return (
    <button type="button" className={cls} aria-pressed={selected} onClick={onSelect} data-testid={testId}>
      {shown(body)}
    </button>
  );
}

const InListbox = createContext(false);

/**
 * A list of compact rows (its own size container: a narrow one puts a row's aside under its text). `listbox`: the caller
 * holds the active option (`activeId`, the tab stop on the list holding it — one stop for several lists — and the keys);
 * without it, a plain ordered list.
 */
export function RowList({
  labelledBy,
  listbox,
  className,
  testId,
  children,
}: {
  labelledBy?: string;
  listbox?: { activeId?: string; tabbable: boolean; onKeyDown: (e: KeyboardEvent<HTMLOListElement>) => void; onFocus: (e: FocusEvent<HTMLOListElement>) => void };
  /** The screen's own class (its gaps). */
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  const cls = `k-rowlist${className ? ` ${className}` : ''}`;
  if (!listbox) {
    return (
      <ol className={cls} aria-labelledby={labelledBy} data-testid={testId}>
        {shown(children)}
      </ol>
    );
  }
  return (
    <InListbox.Provider value={true}>
      <ol
        className={cls}
        role="listbox"
        aria-labelledby={labelledBy}
        aria-activedescendant={listbox.activeId}
        tabIndex={listbox.tabbable ? 0 : -1}
        onKeyDown={listbox.onKeyDown}
        onFocus={listbox.onFocus}
        data-testid={testId}
      >
        {shown(children)}
      </ol>
    </InListbox.Provider>
  );
}

/** An item of a RowList (in a listbox: `role="none"`, so its option or the caller's group is what the list owns). `data`: the row's identities (tests, styles). */
export function RowListItem({
  className,
  testId,
  data,
  children,
}: {
  className?: string;
  testId?: string;
  data?: {
    key?: string;
    row?: string;
    role?: string;
    helper?: string;
    /** L5.12a: a render row's id and its review's state, a job's state (tests). */
    id?: string;
    review?: string;
    state?: string;
    /** L5.12b: a thread's status. */
    status?: string;
  };
  children: ReactNode;
}) {
  const inListbox = useContext(InListbox);
  return (
    <li
      role={inListbox ? 'none' : undefined}
      className={className}
      data-testid={testId}
      data-key={data?.key}
      data-row={data?.row}
      data-role={data?.role}
      data-helper={data?.helper}
      data-id={data?.id}
      data-review={data?.review}
      data-state={data?.state}
      data-status={data?.status}
    >
      {shown(children)}
    </li>
  );
}

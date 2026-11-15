/**
 * The storyboard's state: its selection, its index of the steps, its keys, the focus after an edit, the drag & drop and
 * the measured layout (the hooks Storyboard.tsx calls, in its order; see its header for the keyboard and the drag).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MutableRefObject } from 'react';
import type { SceneBlock, StepBlock } from '@retake/core/scenario';
import type { StepEditor } from './StepEditing.js';
import { dropMove } from './step-edit.js';
import type { StepRef } from './step-edit.js';
import { FRAME_ROW_PX, GRID_KEYS, gridMove } from './board-keys.js';
import type { View } from '../words/scenario-words.js';
import { gridColumns } from '../ui-kit/index.js';
import type { FrameDrag } from '../ui-kit/index.js';

/** What the board's selection is. */
export type Subject = { kind: 'step'; key: string } | { kind: 'scene'; id: string } | { kind: 'entry'; index: number } | { kind: 'video' } | { kind: 'before' } | { kind: 'after' };

/** The MIME type a step's drag carries (its key only: drop handlers never read it — they use the drag state). */
const STEP_DRAG_TYPE = 'application/x-retake-step';

/** The step moves the keys ask for (the screen's: the same as the inspector's buttons). */
export interface BoardMoves {
  move: (key: string, dir: -1 | 1) => void;
  act: (key: string, kind: 'delete_step' | 'duplicate_step') => void;
}

/** The board's scenes and its steps in order: each step's place, its option id, each scene's number and step count. */
export function useBoardIndex(v: View) {
  const scenes = useMemo(() => v.blocks.entries.filter((e): e is SceneBlock => e.type === 'scene'), [v.blocks]);
  const sceneNo = useMemo(() => new Map(scenes.map((s, i) => [s.index, i + 1])), [scenes]);
  const order = useMemo(() => scenes.flatMap((s, si) => s.steps.map((st) => ({ key: st.key, scene: s.id, si, index: st.index }))), [scenes]);
  const index = useMemo(() => new Map(order.map((o, i) => [o.key, i])), [order]);
  const optIds = useMemo(() => new Map(order.map((o, i) => [o.key, `step-opt-${i}`])), [order]);
  const counts = useMemo(() => scenes.map((s) => s.steps.length), [scenes]);
  return { scenes, sceneNo, order, index, optIds, counts };
}
export type BoardIndex = ReturnType<typeof useBoardIndex>;

/** The selection in the frames: the lists, go (select, focus, scroll), a pick, a press, a list taking the focus. */
export function useBoardSelection(ix: BoardIndex, selected: string | null, onSelect: (s: Subject) => void) {
  const { scenes, order, index, optIds } = ix;
  const lists = useRef(new Map<string, HTMLUListElement>());
  const listRef = useCallback(
    (scene: string) => (el: HTMLUListElement | null) => {
      if (el) lists.current.set(scene, el);
      else lists.current.delete(scene);
    },
    [],
  );
  const selRef = useRef(selected);
  selRef.current = selected;
  const go = useCallback(
    (i: number, focus: boolean, scroll = true) => {
      const o = order[Math.max(0, Math.min(order.length - 1, i))];
      if (!o) return;
      onSelect({ kind: 'step', key: o.key });
      // Known at once (before the next render): a focus this call causes finds the selection in its list.
      selRef.current = o.key;
      if (focus) lists.current.get(o.scene)?.focus({ preventScroll: true });
      if (scroll) document.getElementById(optIds.get(o.key)!)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    },
    [order, optIds, onSelect],
  );
  const onPick = useCallback(
    (key: string) => {
      const i = index.get(key);
      if (i !== undefined) go(i, true);
    },
    [index, go],
  );
  const onPress = useCallback(
    (key: string) => {
      const i = index.get(key);
      if (i !== undefined && selRef.current !== key) go(i, true, false);
    },
    [index, go],
  );
  /** The scene a frames list belongs to. */
  // Stable (reads the lists ref only): the callbacks below keep their identity.
  const sceneOfList = useCallback((el: HTMLElement): string | undefined => [...lists.current].find(([, l]) => l === el)?.[0], []);
  /** The list's first step, when the selection is not in it (entering the frames). */
  const firstOfList = useCallback(
    (scene: string | undefined): number | undefined => {
      const key = selRef.current;
      const at = key !== null ? order[index.get(key) ?? -1] : undefined;
      if (scene === undefined || at?.scene === scene) return undefined;
      const first = scenes.find((s) => s.id === scene)?.steps[0];
      return first ? index.get(first.key) : undefined;
    },
    [order, index, scenes],
  );
  // A list that takes the focus with no selection in it (Tab with a scene, a card, the hooks or the video selected; a
  // click in its gaps) selects its first step: the focus is never on a listbox with no active option.
  const onListFocus = useCallback(
    (ev: { target: EventTarget; currentTarget: HTMLElement }) => {
      if (ev.target !== ev.currentTarget) return;
      const i = firstOfList(sceneOfList(ev.currentTarget));
      if (i !== undefined) go(i, false);
    },
    [firstOfList, go, sceneOfList],
  );
  return { lists, listRef, selRef, go, onPick, onPress, sceneOfList, firstOfList, onListFocus };
}
export type BoardSelection = ReturnType<typeof useBoardSelection>;

/** The frames' keys: Alt+arrows move the selected step, Delete deletes it, the grid keys move the selection. */
export function useBoardKeys(ix: BoardIndex, sel: BoardSelection, ed: StepEditor, moves: BoardMoves, editFrom: MutableRefObject<string | null>) {
  const { scenes, order, index, counts } = ix;
  const { selRef, go, firstOfList, sceneOfList } = sel;
  const edRef = useRef(ed);
  edRef.current = ed;
  const movesRef = useRef(moves);
  movesRef.current = moves;
  const editFromRef = useRef(editFrom);
  editFromRef.current = editFrom;
  const onKey = useCallback(
    (ev: KeyboardEvent<HTMLUListElement>) => {
      const key = selRef.current;
      const editable = !ev.repeat && edRef.current.enabled && !edRef.current.busy;
      // Alt+arrows move the selected step one place (Alt+← is Back in some browsers: the default is prevented here).
      if (ev.altKey && ev.key.startsWith('Arrow')) {
        ev.preventDefault();
        editFromRef.current.current = null;
        if (key && editable) movesRef.current.move(key, ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && !ev.altKey && !ev.metaKey && !ev.ctrlKey) {
        ev.preventDefault();
        editFromRef.current.current = null;
        if (key && editable) movesRef.current.act(key, 'delete_step');
        return;
      }
      if (ev.metaKey || ev.ctrlKey) return;
      // No selection in this list: a grid key lands on its first step (End: the last step of all).
      const first = firstOfList(sceneOfList(ev.currentTarget));
      if (first !== undefined && (GRID_KEYS as readonly string[]).includes(ev.key)) {
        ev.preventDefault();
        go(ev.key === 'End' ? order.length - 1 : first, true);
        return;
      }
      const o = key === null ? undefined : order[index.get(key) ?? -1];
      if (!o) return;
      const to = gridMove(counts, { scene: o.si, index: o.index }, ev.key, gridColumns(ev.currentTarget));
      if (!to) return;
      ev.preventDefault();
      const target = scenes[to.scene]?.steps[to.index];
      if (target) go(index.get(target.key) ?? 0, true);
    },
    [order, index, counts, scenes, go, firstOfList, sceneOfList, selRef],
  );
  return { edRef, editFromRef, onKey };
}

/** Where the selection and the focus go after an edit (the step its view selects; the inspector's button it came from). */
export function useEditFocus(ix: BoardIndex, sel: BoardSelection, ed: StepEditor, hash: View['hash'], editFrom: MutableRefObject<string | null>) {
  const { order, index } = ix;
  const { lists, selRef, go } = sel;
  // After an edit, its view selects the moved step / the copy / the neighbour, and the focus stays in the frames — once:
  // the same version read again (a file event, a run ending) never takes the selection back from a step picked since.
  const selectFor = ed.select;
  const selectedFor = useRef<typeof selectFor>(null);
  useEffect(() => {
    if (!selectFor || selectFor.hash !== hash || selectedFor.current === selectFor) return;
    const i = index.get(selectFor.key);
    if (i === undefined) return;
    selectedFor.current = selectFor;
    const active = document.activeElement as HTMLElement | null;
    // An edit from an inspector button: the focus is that button's once editing is back on (the effect below).
    const fromButton = editFrom.current !== null;
    go(i, !fromButton && (active === null || active === document.body || !!active.closest?.('.k-frames, [data-testid="inspector"], [data-testid="edit-bar"]')));
  }, [selectFor, hash, index, go, editFrom]);
  // After an edit from the inspector's Move up / Move down / Duplicate / Delete, the focus stays on that button
  // while it is there and enabled (a second Enter moves the step again); else it goes to the frames.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (ed.busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    const from = editFrom.current;
    editFrom.current = null;
    if (from === null) return;
    const btn = document.querySelector<HTMLButtonElement>(`[data-testid="inspector"] [data-step-action="${from}"]`);
    if (btn && !btn.disabled) {
      btn.focus();
      return;
    }
    const key = selRef.current;
    const at = key !== null ? order[index.get(key) ?? -1] : undefined;
    if (at) lists.current.get(at.scene)?.focus({ preventScroll: true });
  }, [ed.busy, editFrom, order, index, selRef, lists]);
}

/** Drag & drop: the drag state lives here (see the header); anything dragged from elsewhere is refused. */
export function useStepDrag(scenes: SceneBlock[], edRef: MutableRefObject<StepEditor>, editFromRef: MutableRefObject<MutableRefObject<string | null>>) {
  const dragState = useRef<StepRef | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ scene: string; gap: number } | null>(null);
  const dropRef = useRef(dropAt);
  dropRef.current = dropAt;
  const lockedScenes = useMemo(() => new Set(scenes.filter((s) => s.steps_locked !== undefined).map((s) => s.id)), [scenes]);
  const onDragStart = useCallback(
    (ev: DragEvent<HTMLElement>, step: StepBlock, scene: string) => {
      if (!edRef.current.enabled || edRef.current.busy || step.guard === undefined || step.locked !== undefined) {
        ev.preventDefault();
        return;
      }
      dragState.current = { scene, index: step.index, guard: step.guard };
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData(STEP_DRAG_TYPE, step.key);
      setDragKey(step.key);
    },
    [edRef],
  );
  const onDragEnd = useCallback(() => {
    dragState.current = null;
    setDragKey(null);
    setDropAt(null);
  }, []);
  const dragFor = useCallback(
    (scene: string): FrameDrag => ({
      over: (slot) => {
        if (!dragState.current || lockedScenes.has(scene)) return false;
        const cur = dropRef.current;
        if (!cur || cur.scene !== scene || cur.gap !== slot) setDropAt({ scene, gap: slot });
        return true;
      },
      drop: () => {
        const from = dragState.current;
        const at = dropRef.current;
        if (!from) return false;
        editFromRef.current.current = null;
        dragState.current = null;
        setDragKey(null);
        setDropAt(null);
        if (at) {
          const to = dropMove(from, { scene: at.scene, index: at.gap });
          if (to) edRef.current.send({ kind: 'move_step', from, to });
        }
        return true;
      },
    }),
    [lockedScenes, editFromRef, edRef],
  );
  useEffect(() => {
    const over = (e: globalThis.DragEvent) => {
      if (dragState.current) {
        // Over anything but a scene's frames (they stop the event), the insertion bar goes away.
        if (dropRef.current) setDropAt(null);
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    const dropped = (e: globalThis.DragEvent) => {
      if (!dragState.current) e.preventDefault();
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', dropped);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', dropped);
    };
  }, []);
  return { dragKey, dropAt, onDragStart, onDragEnd, dragFor };
}

/** The source run every frame shares (one object), and the board's columns and row height for a skipped scene. */
export function useBoardLayout(v: View) {
  // One object per source run: a prop of every memoised frame, so a selection re-renders two frames, not all.
  const sourceRun = v.source?.run;
  const sourceMode = v.source?.mode;
  const source = useMemo(() => (sourceRun !== undefined && sourceMode !== undefined ? { run: sourceRun, mode: sourceMode } : null), [sourceRun, sourceMode]);
  // A skipped scene's height from the board's own columns and row height, measured on a rendered scene.
  const boardRef = useRef<HTMLDivElement>(null);
  const [grid, setGrid] = useState<{ cols: number; rowPx: number }>({ cols: 3, rowPx: FRAME_ROW_PX });
  useEffect(() => {
    const el = boardRef.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const measure = () => {
      const list = el.querySelector<HTMLElement>('.k-frames');
      const frame = list?.querySelector<HTMLElement>(':scope > [role="option"]');
      if (!list || !frame) return;
      const h = frame.getBoundingClientRect().height;
      if (h <= 0) return;
      const rowPx = Math.round(h + (parseFloat(getComputedStyle(list).rowGap) || 0));
      const cols = gridColumns(list);
      setGrid((g) => (g.cols === cols && g.rowPx === rowPx ? g : { cols, rowPx }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  return { source, boardRef, grid };
}

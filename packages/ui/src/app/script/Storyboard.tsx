/**
 * L5.10b: the storyboard (B32-Scenario) — the scenario's entries in file order: a "Before filming" row card (the setup
 * hooks), the filmed scenes (numbered 1, 2, 3 among the filmed scenes), the cards and interstitials as row cards between
 * them, an "After filming" row card (the teardown hooks). A scene: its title (the caption's kicker, else its id) and
 * caption, its flags in words, "Scene 1 · shop, / · 9.3 s" (selects the scene into the inspector) and Add step; then its
 * frames — each step's picture from the source run (Thumb.tsx, asked for the frames on screen only) or why there is
 * none, its number, its verb and target, its length, its state in that run as a shape and words, its modifiers in words,
 * what it types or scrolls (`summary`) and its issues.
 *
 * Keyboard (plan §4.2, critique L3): each scene's frames are a `listbox` (one tab stop for all the scenes: the list
 * holding the selection, `aria-activedescendant`); ← / → the step before / after, ↑ / ↓ the frame above / below (across
 * scenes), Home / End, Page Up / Page Down three rows; Alt+↑ / Alt+← move the selected step one place earlier, Alt+↓ /
 * Alt+→ later; Delete / Backspace delete it (undoable); a held key repeats no edit. The inspector follows.
 *
 * Drag & drop (critique B11, M7): the drag state lives in this document — a drop is acted on only for a drag that
 * started here (never from dataTransfer contents); the slot comes from the pointer over a scene's whole list (its gaps
 * included); anything else dragged over the board (a file from the Finder) is refused, so the page never navigates away.
 * Every move goes through `dropMove` / `keyboardMove` → `scenario_edit` (StepEditing.tsx): the verified write path.
 *
 * Huge scenarios (the 1,200-step budget): no virtualization — each scene is `content-visibility: auto` with its own
 * intrinsic height (rows × the row height: critique L1), frames are memoised, pictures load only on screen.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MutableRefObject } from 'react';
import type { EntryBlock, SceneBlock, StepBlock } from '@retake/core/scenario';
import type { StepBinding } from '@retake/engine';
import { Txt, plural, shown } from '../bits.js';
import { IssueLines } from './StepEditing.js';
import type { StepEditor } from './StepEditing.js';
import { SceneFlags, StepPicture } from './ScenarioInspector.js';
import { dropMove } from './step-edit.js';
import type { StepRef } from './step-edit.js';
import { FRAME_ROW_PX, GRID_KEYS, frameTitle, gridMove, sceneIntrinsicPx, sceneLengthWords } from './board-keys.js';
import { bindingMark, bindingWords, seconds } from '../words/scenario-words.js';
import type { View } from '../words/scenario-words.js';
import { Button, FrameGrid, FrameOption, RowCard, StatusMark, dropSide, gridColumns } from '../ui-kit/index.js';
import type { FrameDrag } from '../ui-kit/index.js';

/** What the board's selection is. */
export type Subject = { kind: 'step'; key: string } | { kind: 'scene'; id: string } | { kind: 'entry'; index: number } | { kind: 'video' } | { kind: 'before' } | { kind: 'after' };

/** The MIME type a step's drag carries (its key only: drop handlers never read it — they use the drag state). */
const STEP_DRAG_TYPE = 'application/x-retake-step';

interface FrameProps {
  step: StepBlock;
  scene: string;
  optId: string;
  binding: StepBinding | undefined;
  source: { run: string; mode: string } | null;
  cannotTell: boolean;
  selected: boolean;
  onPick: (key: string) => void;
  /** A mouse-down on the frame (a click or the start of a drag): it becomes the active option at once (review A M2). */
  onPress: (key: string) => void;
  canDrag: boolean;
  drop: 'before' | 'after' | null;
  dragging: boolean;
  onDragStart: (ev: DragEvent<HTMLElement>, step: StepBlock, scene: string) => void;
  onDragEnd: () => void;
}

/** A step's frame (memoised: a 1,200-step board re-renders only the frames whose props changed). */
const StepFrame = memo(function StepFrame({ step, scene, optId, binding, source, cannotTell, selected, onPick, onPress, canDrag, drop, dragging, onDragStart, onDragEnd }: FrameProps) {
  const words = bindingWords(binding, source !== null);
  const bound = binding && !('missing' in binding) ? binding : undefined;
  const { verb, rest, note } = frameTitle(step);
  return (
    <FrameOption
      id={optId}
      dataKey={step.key}
      testId="step"
      label={`Step ${step.index + 1}: ${step.label}${step.target ? ` ${step.target}` : ''}. ${words}`}
      selected={selected}
      picture={<StepPicture binding={binding} source={source} step={step} scene={scene} size="frame" />}
      number={String(step.index + 1)}
      title={
        <>
          <span className="sb-verb" data-testid="action-badge">
            {shown(verb)}
          </span>
          {rest !== undefined && (
            <>
              {' '}
              <Txt text={rest} />
            </>
          )}
        </>
      }
      meta={
        <>
          {source && (
            <span className="sb-state" data-testid="step-state">
              <StatusMark state={bindingMark(binding, true)} word={words} />
              {bound?.ms !== undefined && <span className="k-mono">{shown(` · took ${seconds(bound.ms)}`)}</span>}
              {bound && cannotTell && shown(' · matched by position: cannot tell whether it changed')}
            </span>
          )}
          {step.chips.map((c, i) => (
            <span key={i} className="sb-chip" data-chip={c.kind}>
              <Txt text={c.label} />
            </span>
          ))}
          {note !== undefined && <Txt className="sb-note" text={note} />}
          {step.issues.length > 0 && <StatusMark state="attention" word={plural(step.issues.length, 'issue')} />}
        </>
      }
      draggable={canDrag}
      drop={drop}
      dragging={dragging}
      onPick={() => onPick(step.key)}
      onPress={() => onPress(step.key)}
      onDragStart={(ev) => onDragStart(ev, step, scene)}
      onDragEnd={onDragEnd}
    />
  );
});

/** The step moves the keys ask for (the screen's: the same as the inspector's buttons). */
export interface BoardMoves {
  move: (key: string, dir: -1 | 1) => void;
  act: (key: string, kind: 'delete_step' | 'duplicate_step') => void;
}

/** A scene's length in the source run ("9.3 s"), or undefined. */
export function sceneLength(v: View, id: string): string | undefined {
  const s = v.scenes[id]?.captured_s;
  return s === undefined ? undefined : `${s.toFixed(1)} s`;
}

/** "3 hooks · reset, prepare-proposal" — a phase's hooks in a line. */
export function hooksLine(n: number, names: string[]): string {
  return `${plural(n, 'hook')}${names.length ? ` · ${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}` : ''}`;
}

/** A card's or an interstitial's title (its slots' title, its kicker or text), else its id. */
export function entryTitle(e: Exclude<EntryBlock, SceneBlock>): string {
  if (e.type === 'unknown') return `Unreadable entry ${e.index + 1}`;
  if (e.type === 'card') return e.slots?.title ?? e.slots?.kicker ?? Object.values(e.slots ?? {})[0] ?? e.id;
  return e.kicker ?? e.text ?? e.id;
}

export function Storyboard({
  v,
  subject,
  onSelect,
  ed,
  moves,
  canAdd,
  onAddStep,
  editFrom,
}: {
  v: View;
  /** The screen's resolved selection (review B M2: the inspector shows the same; never a step it does not show). */
  subject: Subject | null;
  onSelect: (s: Subject) => void;
  ed: StepEditor;
  moves: BoardMoves;
  /** The palette is there (forms read, edits on): each scene shows Add step. */
  canAdd: boolean;
  onAddStep: (scene: string) => void;
  /** The inspector's button an edit came from (`data-step-action`), or null: it keeps the focus after the edit (review A L1). */
  editFrom: MutableRefObject<string | null>;
}) {
  const scenes = useMemo(() => v.blocks.entries.filter((e): e is SceneBlock => e.type === 'scene'), [v.blocks]);
  const sceneNo = useMemo(() => new Map(scenes.map((s, i) => [s.index, i + 1])), [scenes]);
  const order = useMemo(() => scenes.flatMap((s, si) => s.steps.map((st) => ({ key: st.key, scene: s.id, si, index: st.index }))), [scenes]);
  const index = useMemo(() => new Map(order.map((o, i) => [o.key, i])), [order]);
  const optIds = useMemo(() => new Map(order.map((o, i) => [o.key, `step-opt-${i}`])), [order]);
  const counts = useMemo(() => scenes.map((s) => s.steps.length), [scenes]);
  const selected = subject?.kind === 'step' && index.has(subject.key) ? subject.key : null;
  const lists = useRef(new Map<string, HTMLUListElement>());
  const listRef = useCallback((scene: string) => (el: HTMLUListElement | null) => {
    if (el) lists.current.set(scene, el);
    else lists.current.delete(scene);
  }, []);
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
  const sceneOfList = (el: HTMLElement): string | undefined => [...lists.current].find(([, l]) => l === el)?.[0];
  /** The list's first step, when the selection is not in it (entering the frames: review A M2). */
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
    [firstOfList, go],
  );
  const edRef = useRef(ed);
  edRef.current = ed;
  const movesRef = useRef(moves);
  movesRef.current = moves;
  const editFromRef = useRef(editFrom);
  editFromRef.current = editFrom;
  const canEdit = ed.enabled && !ed.busy;
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
      // No selection in this list (review A M2): a grid key lands on its first step (End: the last step of all).
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
    [order, index, counts, scenes, go, firstOfList],
  );
  // After an edit, its view selects the moved step / the copy / the neighbour, and the focus stays in the frames — once:
  // the same version read again (a file event, a run ending) never takes the selection back from a step picked since.
  const selectFor = ed.select;
  const selectedFor = useRef<typeof selectFor>(null);
  useEffect(() => {
    if (!selectFor || selectFor.hash !== v.hash || selectedFor.current === selectFor) return;
    const i = index.get(selectFor.key);
    if (i === undefined) return;
    selectedFor.current = selectFor;
    const active = document.activeElement as HTMLElement | null;
    // An edit from an inspector button: the focus is that button's once editing is back on (the effect below).
    const fromButton = editFrom.current !== null;
    go(i, !fromButton && (active === null || active === document.body || !!active.closest?.('.k-frames, [data-testid="inspector"], [data-testid="edit-bar"]')));
  }, [selectFor, v.hash, index, go, editFrom]);
  // Review A L1: after an edit from the inspector's Move up / Move down / Duplicate / Delete, the focus stays on that button
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
  }, [ed.busy, editFrom, order, index]);

  // Drag & drop: the drag state lives here (see the header).
  const dragState = useRef<StepRef | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ scene: string; gap: number } | null>(null);
  const dropRef = useRef(dropAt);
  dropRef.current = dropAt;
  const lockedScenes = useMemo(() => new Set(scenes.filter((s) => s.steps_locked !== undefined).map((s) => s.id)), [scenes]);
  const onDragStart = useCallback((ev: DragEvent<HTMLElement>, step: StepBlock, scene: string) => {
    if (!edRef.current.enabled || edRef.current.busy || step.guard === undefined || step.locked !== undefined) {
      ev.preventDefault();
      return;
    }
    dragState.current = { scene, index: step.index, guard: step.guard };
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData(STEP_DRAG_TYPE, step.key);
    setDragKey(step.key);
  }, []);
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
    [lockedScenes],
  );
  useEffect(() => {
    const over = (e: globalThis.DragEvent) => {
      if (dragState.current) {
        // Over anything but a scene's frames (they stop the event), the insertion bar goes away (review B L5).
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

  // One object per source run (review A L3): a prop of every memoised frame, so a selection re-renders two frames, not all.
  const sourceRun = v.source?.run;
  const sourceMode = v.source?.mode;
  const source = useMemo(() => (sourceRun !== undefined && sourceMode !== undefined ? { run: sourceRun, mode: sourceMode } : null), [sourceRun, sourceMode]);
  // Review A L4: a skipped scene's height from the board's own columns and row height, measured on a rendered scene.
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
  const cannotTell = v.source?.notice === 'cannot_tell';
  const { setup, teardown, named } = v.blocks.hooks;
  const firstScene = scenes.find((s) => s.steps.length > 0)?.id ?? null;
  const selScene = selected !== null ? order[index.get(selected)!]?.scene : null;
  // The one tab stop (review A M2): the list holding the selection, else the selected scene's, else the first scene's.
  const tabScene = selScene ?? (subject?.kind === 'scene' && scenes.some((s) => s.id === subject.id && s.steps.length > 0) ? subject.id : firstScene);
  const names = (hs: typeof setup) => hs.map((h) => h.name ?? h.kind ?? 'hook');
  return (
    <div className="sb-board" data-testid="blocks" aria-busy={ed.busy} ref={boardRef}>
      {/* Review B L8: the step count and the file, on the board. */}
      <p className="sc-quiet sb-count" data-testid="board-count">
        {shown(`${plural(v.blocks.step_count, 'step')} in ${plural(scenes.length, 'scene')} · `)}
        <Txt className="k-mono" text={v.file} />
      </p>
      <p id="steps-keys" className="sc-quiet sb-keys">
        {canEdit
          ? 'Arrows move through the frames (↑ ↓ by row); Alt+arrows move the selected step one place, or drag a frame; Delete removes it; ⌘Z / Ctrl+Z undoes.'
          : 'Arrows move through the frames (↑ ↓ by row); Home and End go to the first and last step.'}
      </p>
      {(setup.length > 0 || named.length > 0) && (
        <div id="entry-before" className="sb-entry">
          <RowCard tile="Before" quiet title="Before filming" meta={hooksLine(setup.length, names(setup)) + (named.length ? ` · ${plural(named.length, 'named hook')} during the take` : '')} selected={subject?.kind === 'before'} onSelect={() => onSelect({ kind: 'before' })} testId="before-filming" />
        </div>
      )}
      {v.blocks.entries.map((e) => {
        if (e.type !== 'scene') {
          const len = e.type === 'unknown' ? (e.range ? `line ${e.range.line}` : '') : e.duration !== undefined ? `${e.duration} s` : 'default length';
          const what = e.type === 'card' ? `Card · ${e.component ?? "the theme's card"}` : e.type === 'interstitial' ? 'Text between scenes' : 'Cannot be read';
          return (
            <div key={`${e.type}-${e.index}`} id={`entry-${e.index}`} className="sb-entry">
              <RowCard
                tile={e.type === 'card' ? 'Card' : e.type === 'interstitial' ? 'Text' : '?'}
                title={entryTitle(e)}
                meta={`${what}${len ? ` · ${len}` : ''}${e.issues.length ? ` · ${plural(e.issues.length, 'issue')}` : ''}`}
                selected={subject?.kind === 'entry' && subject.index === e.index}
                onSelect={() => onSelect({ kind: 'entry', index: e.index })}
                testId={e.type === 'unknown' ? 'unknown-entry' : e.type}
              />
            </div>
          );
        }
        const n = sceneNo.get(e.index);
        const headId = `scene-h-${e.index}`;
        const hasSel = selScene === e.id;
        const length = sceneLengthWords(v.scenes[e.id]?.captured_s, v.source?.mode);
        const where = e.pages ? plural(e.pages.length, 'page') : `${e.page ?? '—'}, ${e.continues ? 'continues' : (e.open ?? '/')}`;
        const sceneSelected = subject?.kind === 'scene' && subject.id === e.id;
        return (
          <section
            key={`scene-${e.index}`}
            id={`entry-${e.index}`}
            className="sb-scene"
            aria-labelledby={headId}
            data-testid="scene"
            data-scene={e.id}
            // Off screen, a scene is laid out at its own height and not painted (critique L1); its width is the board's.
            style={{ contentVisibility: 'auto', containIntrinsicBlockSize: `auto ${sceneIntrinsicPx(e.steps.length, grid.cols, grid.rowPx)}px` }}
          >
            <div className="sb-scene-head">
              <div className="sb-scene-titles">
                <h2 id={headId} className="sb-scene-title">
                  <Txt text={e.caption?.kicker ?? e.id} />
                </h2>
                {e.caption && (
                  <p className="sb-caption" data-testid="caption">
                    <Txt text={e.caption.text} />
                  </p>
                )}
                {(e.skip || e.offscreen || e.irreversible) && (
                  <p className="sb-flags">
                    <SceneFlags e={e} />
                  </p>
                )}
              </div>
              <div className="sb-scene-tools">
                <Button variant="ghost" size="sm" aria-pressed={sceneSelected} onClick={() => onSelect({ kind: 'scene', id: e.id })} data-testid="scene-meta">
                  {shown(`Scene ${n} · ${where} · ${length}`)}
                </Button>
                {canAdd && e.steps_locked === undefined && (
                  <Button size="sm" icon="plus" onClick={() => onAddStep(e.id)} data-testid="scene-add">
                    Add step
                  </Button>
                )}
              </div>
            </div>
            {e.comment && <Txt className="sb-pre sc-quiet" text={e.comment} />}
            {e.note !== undefined && <Txt className="sc-quiet" text={`Note: ${e.note}`} />}
            <IssueLines issues={e.issues} />
            <FrameGrid
              label={`Steps of scene ${e.id}`}
              activeId={hasSel && selected ? optIds.get(selected) : undefined}
              tabbable={e.id === tabScene}
              describedBy="steps-keys"
              listRef={listRef(e.id)}
              onKeyDown={onKey}
              onFocus={onListFocus}
              drag={dragFor(e.id)}
              empty={`No steps.${canEdit && !e.steps_locked ? ' Drop a step here to move it into this scene.' : ''}`}
              emptyTarget={dropAt?.scene === e.id}
            >
              {e.steps.map((s) => (
                <StepFrame
                  key={s.key}
                  step={s}
                  scene={e.id}
                  optId={optIds.get(s.key)!}
                  binding={v.steps[s.key]}
                  source={source}
                  cannotTell={cannotTell}
                  selected={s.key === selected}
                  onPick={onPick}
                  onPress={onPress}
                  canDrag={canEdit && s.locked === undefined && s.guard !== undefined}
                  drop={dropAt?.scene === e.id ? dropSide(dropAt.gap, s.index) : null}
                  dragging={dragKey === s.key}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                />
              ))}
            </FrameGrid>
          </section>
        );
      })}
      {teardown.length > 0 && (
        <div id="entry-after" className="sb-entry">
          <RowCard tile="After" quiet title="After filming" meta={hooksLine(teardown.length, names(teardown))} selected={subject?.kind === 'after'} onSelect={() => onSelect({ kind: 'after' })} testId="after-filming" />
        </div>
      )}
    </div>
  );
}

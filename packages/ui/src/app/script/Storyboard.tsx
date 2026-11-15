/**
 * The storyboard (B32-Scenario) — the scenario's entries in file order: a "Before filming" row card (the setup
 * hooks), the filmed scenes (numbered 1, 2, 3 among the filmed scenes), the cards and interstitials as row cards between
 * them, an "After filming" row card (the teardown hooks). A scene: its title (the caption's kicker, else its id) and
 * caption, its flags in words, "Scene 1 · shop, / · 9.3 s" (selects the scene into the inspector) and Add step; then its
 * frames — each step's picture from the source run (Thumb.tsx, asked for the frames on screen only) or why there is
 * none, its number, its verb and target, its length, its state in that run as a shape and words, its modifiers in words,
 * what it types or scrolls (`summary`) and its issues.
 *
 * Keyboard: each scene's frames are a `listbox` (one tab stop for all the scenes: the list
 * holding the selection, `aria-activedescendant`); ← / → the step before / after, ↑ / ↓ the frame above / below (across
 * scenes), Home / End, Page Up / Page Down three rows; Alt+↑ / Alt+← move the selected step one place earlier, Alt+↓ /
 * Alt+→ later; Delete / Backspace delete it (undoable); a held key repeats no edit. The inspector follows.
 *
 * Drag & drop: the drag state lives in this document — a drop is acted on only for a drag that
 * started here (never from dataTransfer contents); the slot comes from the pointer over a scene's whole list (its gaps
 * included); anything else dragged over the board (a file from the Finder) is refused, so the page never navigates away.
 * Every move goes through `dropMove` / `keyboardMove` → `scenario_edit` (StepEditing.tsx): the verified write path.
 *
 * Huge scenarios (the 1,200-step budget): no virtualization — each scene is `content-visibility: auto` with its own
 * intrinsic height (rows × the row height), frames are memoised, pictures load only on screen.
 */
import { memo } from 'react';
import type { DragEvent, KeyboardEvent, MutableRefObject } from 'react';
import type { EntryBlock, SceneBlock, StepBlock } from '@retake/core/scenario';
import type { StepBinding } from '@retake/engine';
import { Txt, plural, shown } from '../bits.js';
import { IssueLines } from './StepEditing.js';
import type { StepEditor } from './StepEditing.js';
import { SceneFlags, StepPicture } from './ScenarioInspector.js';
import { frameTitle, sceneIntrinsicPx, sceneLengthWords } from './board-keys.js';
import { bindingMark, bindingWords, seconds } from '../words/scenario-words.js';
import type { View } from '../words/scenario-words.js';
import { Button, FrameGrid, FrameOption, RowCard, StatusMark, dropSide } from '../ui-kit/index.js';
import type { FrameDrag } from '../ui-kit/index.js';
import { useBoardIndex, useBoardKeys, useBoardLayout, useBoardSelection, useEditFocus, useStepDrag } from './board-state.js';
import type { BoardMoves, Subject } from './board-state.js';

export type { BoardMoves, Subject } from './board-state.js';

interface FrameProps {
  step: StepBlock;
  scene: string;
  optId: string;
  binding: StepBinding | undefined;
  source: { run: string; mode: string } | null;
  cannotTell: boolean;
  selected: boolean;
  onPick: (key: string) => void;
  /** A mouse-down on the frame (a click or the start of a drag): it becomes the active option at once. */
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
            // biome-ignore lint/suspicious/noArrayIndexKey: a step's chips in the view's order, replaced whole with the step, no state: the index is the identity
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
  /** The screen's resolved selection (the inspector shows the same; never a step it does not show). */
  subject: Subject | null;
  onSelect: (s: Subject) => void;
  ed: StepEditor;
  moves: BoardMoves;
  /** The palette is there (forms read, edits on): each scene shows Add step. */
  canAdd: boolean;
  onAddStep: (scene: string) => void;
  /** The inspector's button an edit came from (`data-step-action`), or null: it keeps the focus after the edit. */
  editFrom: MutableRefObject<string | null>;
}) {
  const ix = useBoardIndex(v);
  const { scenes, sceneNo, order, index, optIds } = ix;
  const selected = subject?.kind === 'step' && index.has(subject.key) ? subject.key : null;
  const sel = useBoardSelection(ix, selected, onSelect);
  const { listRef, onPick, onPress, onListFocus } = sel;
  const { edRef, editFromRef, onKey } = useBoardKeys(ix, sel, ed, moves, editFrom);
  const canEdit = ed.enabled && !ed.busy;
  useEditFocus(ix, sel, ed, v.hash, editFrom);
  const { dragKey, dropAt, onDragStart, onDragEnd, dragFor } = useStepDrag(scenes, edRef, editFromRef);
  const { source, boardRef, grid } = useBoardLayout(v);
  const cannotTell = v.source?.notice === 'cannot_tell';
  const { setup, teardown, named } = v.blocks.hooks;
  const firstScene = scenes.find((s) => s.steps.length > 0)?.id ?? null;
  const selScene = selected !== null ? order[index.get(selected)!]?.scene : null;
  // The one tab stop: the list holding the selection, else the selected scene's, else the first scene's.
  const tabScene = selScene ?? (subject?.kind === 'scene' && scenes.some((s) => s.id === subject.id && s.steps.length > 0) ? subject.id : firstScene);
  const names = (hs: typeof setup) => hs.map((h) => h.name ?? h.kind ?? 'hook');
  const frames: BoardFrames = { selected, optIds, canEdit, dropAt, dragKey, source, cannotTell, onPick, onPress, onDragStart, onDragEnd };
  return (
    <div className="sb-board" data-testid="blocks" aria-busy={ed.busy} ref={boardRef}>
      <BoardHead v={v} scenes={scenes.length} canEdit={canEdit} />
      {(setup.length > 0 || named.length > 0) && (
        <div id="entry-before" className="sb-entry">
          <RowCard
            tile="Before"
            quiet
            title="Before filming"
            meta={hooksLine(setup.length, names(setup)) + (named.length ? ` · ${plural(named.length, 'named hook')} during the take` : '')}
            selected={subject?.kind === 'before'}
            onSelect={() => onSelect({ kind: 'before' })}
            testId="before-filming"
          />
        </div>
      )}
      {v.blocks.entries.map((e) =>
        e.type !== 'scene' ? (
          <EntryRow key={`${e.type}-${e.index}`} e={e} subject={subject} onSelect={onSelect} />
        ) : (
          <SceneSection
            key={`scene-${e.index}`}
            e={e}
            n={sceneNo.get(e.index)}
            v={v}
            subject={subject}
            onSelect={onSelect}
            canAdd={canAdd}
            onAddStep={onAddStep}
            hasSel={selScene === e.id}
            tabbable={e.id === tabScene}
            grid={grid}
            listRef={listRef(e.id)}
            onKey={onKey}
            onListFocus={onListFocus}
            drag={dragFor(e.id)}
            frames={frames}
          />
        ),
      )}
      {teardown.length > 0 && (
        <div id="entry-after" className="sb-entry">
          <RowCard
            tile="After"
            quiet
            title="After filming"
            meta={hooksLine(teardown.length, names(teardown))}
            selected={subject?.kind === 'after'}
            onSelect={() => onSelect({ kind: 'after' })}
            testId="after-filming"
          />
        </div>
      )}
    </div>
  );
}

/** A card, an interstitial or an unreadable entry: a row card between the scenes. */
function EntryRow({ e, subject, onSelect }: { e: Exclude<EntryBlock, SceneBlock>; subject: Subject | null; onSelect: (s: Subject) => void }) {
  const len = e.type === 'unknown' ? (e.range ? `line ${e.range.line}` : '') : e.duration !== undefined ? `${e.duration} s` : 'default length';
  const what = e.type === 'card' ? `Card · ${e.component ?? "the theme's card"}` : e.type === 'interstitial' ? 'Text between scenes' : 'Cannot be read';
  return (
    <div id={`entry-${e.index}`} className="sb-entry">
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

/** The step count and the file, and the frames' keys in words. */
function BoardHead({ v, scenes, canEdit }: { v: View; scenes: number; canEdit: boolean }) {
  return (
    <>
      {/* The step count and the file, on the board. */}
      <p className="sc-quiet sb-count" data-testid="board-count">
        {shown(`${plural(v.blocks.step_count, 'step')} in ${plural(scenes, 'scene')} · `)}
        <Txt className="k-mono" text={v.file} />
      </p>
      <p id="steps-keys" className="sc-quiet sb-keys">
        {canEdit
          ? 'Arrows move through the frames (↑ ↓ by row); Alt+arrows move the selected step one place, or drag a frame; Delete removes it; ⌘Z / Ctrl+Z undoes.'
          : 'Arrows move through the frames (↑ ↓ by row); Home and End go to the first and last step.'}
      </p>
    </>
  );
}

/** What every scene's frames share: the selection, the source run, the drag and the frame callbacks. */
interface BoardFrames {
  selected: string | null;
  optIds: Map<string, string>;
  canEdit: boolean;
  dropAt: { scene: string; gap: number } | null;
  dragKey: string | null;
  source: { run: string; mode: string } | null;
  cannotTell: boolean;
  onPick: (key: string) => void;
  onPress: (key: string) => void;
  onDragStart: FrameProps['onDragStart'];
  onDragEnd: () => void;
}

/** A scene's head: its title, caption and flags, its meta (selects the scene) and Add step. */
function SceneHead({
  e,
  n,
  v,
  subject,
  onSelect,
  canAdd,
  onAddStep,
}: {
  e: SceneBlock;
  n: number | undefined;
  v: View;
  subject: Subject | null;
  onSelect: (s: Subject) => void;
  canAdd: boolean;
  onAddStep: (scene: string) => void;
}) {
  const length = sceneLengthWords(v.scenes[e.id]?.captured_s, v.source?.mode);
  const where = e.pages ? plural(e.pages.length, 'page') : `${e.page ?? '—'}, ${e.continues ? 'continues' : (e.open ?? '/')}`;
  const sceneSelected = subject?.kind === 'scene' && subject.id === e.id;
  return (
    <div className="sb-scene-head">
      <div className="sb-scene-titles">
        <h2 id={`scene-h-${e.index}`} className="sb-scene-title">
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
  );
}

/** A filmed scene: its head, its notes and issues, and its frames. */
function SceneSection({
  e,
  n,
  v,
  subject,
  onSelect,
  canAdd,
  onAddStep,
  hasSel,
  tabbable,
  grid,
  listRef,
  onKey,
  onListFocus,
  drag,
  frames,
}: {
  e: SceneBlock;
  n: number | undefined;
  v: View;
  subject: Subject | null;
  onSelect: (s: Subject) => void;
  canAdd: boolean;
  onAddStep: (scene: string) => void;
  hasSel: boolean;
  tabbable: boolean;
  grid: { cols: number; rowPx: number };
  listRef: (el: HTMLUListElement | null) => void;
  onKey: (ev: KeyboardEvent<HTMLUListElement>) => void;
  onListFocus: (ev: { target: EventTarget; currentTarget: HTMLElement }) => void;
  drag: FrameDrag;
  frames: BoardFrames;
}) {
  const { selected, optIds, canEdit, dropAt, dragKey, source, cannotTell, onPick, onPress, onDragStart, onDragEnd } = frames;
  return (
    <section
      id={`entry-${e.index}`}
      className="sb-scene"
      aria-labelledby={`scene-h-${e.index}`}
      data-testid="scene"
      data-scene={e.id}
      // Off screen, a scene is laid out at its own height and not painted; its width is the board's.
      style={{ contentVisibility: 'auto', containIntrinsicBlockSize: `auto ${sceneIntrinsicPx(e.steps.length, grid.cols, grid.rowPx)}px` }}
    >
      <SceneHead e={e} n={n} v={v} subject={subject} onSelect={onSelect} canAdd={canAdd} onAddStep={onAddStep} />
      {e.comment && <Txt className="sb-pre sc-quiet" text={e.comment} />}
      {e.note !== undefined && <Txt className="sc-quiet" text={`Note: ${e.note}`} />}
      <IssueLines issues={e.issues} />
      <FrameGrid
        label={`Steps of scene ${e.id}`}
        activeId={hasSel && selected ? optIds.get(selected) : undefined}
        tabbable={tabbable}
        describedBy="steps-keys"
        listRef={listRef}
        onKeyDown={onKey}
        onFocus={onListFocus}
        drag={drag}
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
}

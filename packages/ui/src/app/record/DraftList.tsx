/** The draft's step rows, scene by scene: the listbox, the cursor block, a row's alternatives and its inserts. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, KeyboardEvent, ReactNode } from 'react';
import type { RecordInsert } from '@retake/core';
import type { RecordViewAnswer } from '../../server/record-ops.js';
import { Txt, plural, shown, visibleControls } from '../bits.js';
import { stepWords } from '../scenario-words.js';
import { gridMove } from '../board-keys.js';
import { Button, RadioGroup, RowCard, RowList, RowListItem, StatusMark } from '../ui-kit/index.js';
import { INSERT_KIND_WORDS, LIVE_STATES, fragileWords, insertText, insertWords } from '../record-words.js';
import { Inserts } from './Inserts.js';
import type { InsertFormState } from './Inserts.js';
import { draftRows, cursorRow, chosenOf } from './draft.js';
import type { Cursor, DraftRow, RecordingActions } from './draft.js';

function InsertChip({ i, can, onRemove, where }: { i: RecordInsert; can: boolean; onRemove: (id: string) => void; where: string }) {
  const text = insertText(i);
  return (
    <span className="rc-chip" data-testid="record-insert-chip" data-kind={i.kind}>
      <span className="rc-chip-text">
        <span className="rc-by">added by you</span> {shown(insertWords(i))}
        {text !== null && (
          <>
            {': '}
            <Txt text={text} />
          </>
        )}
      </span>
      {can && (
        <Button size="sm" variant="ghost" aria-label={visibleControls(`Remove the ${INSERT_KIND_WORDS[i.kind].toLowerCase()} ${where}`)} data-testid="record-insert-remove" onClick={() => onRemove(i.id)}>
          Remove
        </Button>
      )}
    </span>
  );
}

/** A row's words: the step's own label and target, what made it, its alternatives. */
function rowParts(r: DraftRow, can: boolean): { title: ReactNode; meta: ReactNode; aside: ReactNode } {
  const role = r.source?.role;
  const title = (
    <>
      <Txt className="rc-row-label" text={r.step.label} />
      {r.step.target && (
        <>
          {' '}
          <Txt className="rc-row-target" text={r.step.target} />
        </>
      )}
    </>
  );
  const notes: ReactNode[] = [];
  if (role === 'helper') notes.push(<span key="by">added by the recorder</span>);
  if (role === 'insert') notes.push(<span key="by">added by you</span>);
  if (r.step.summary) notes.push(<Txt key="sum" text={r.step.summary} />);
  for (const [i, c] of r.step.chips.entries()) notes.push(<Txt key={`c${i}`} text={c.label} />);
  const meta = notes.length ? notes.flatMap((n, i) => (i ? [<span key={`s${i}`}>{' · '}</span>, n] : [n])) : null;
  let aside: ReactNode = null;
  if (can && r.alt && r.alt.options.length > 1) {
    const c = chosenOf(r);
    aside = c.picked ? 'Target picked by you' : plural(r.alt.options.length - 1, 'alternative');
  }
  return { title, meta, aside };
}

/**
 * The selected row's verified target alternatives as a radio group (index 0: the recorder's suggestion). L5.11b fixes
 * (review A-M1): the radio shows the choice asked for at once (`want`) while it is saved — an arrow press checks the
 * radio it lands on, and the screen sends the newest pick when the one in flight ends (never two in flight, never
 * refused) —, then the view's choice again once it says the same or nothing is pending any more (a refusal).
 */
function Alternatives({ row, n, onChoose, pending }: { row: DraftRow; n: number; onChoose: (seq: number, index: number) => void; pending: boolean }) {
  const alt = row.alt!;
  const c = chosenOf(row);
  const [want, setWant] = useState<number | null>(null);
  useEffect(() => {
    if (want !== null && (c.checked === want || !pending)) setWant(null);
  }, [want, c.checked, pending]);
  return (
    <div className="rc-alts" data-testid="record-alternatives">
      <p className="rc-alts-state" data-testid="record-alt-state">
        {shown(c.picked ? 'Target picked by you' : `The recorder’s suggestion · ${plural(alt.options.length - 1, 'other target')} verified on the page`)}
      </p>
      <RadioGroup
        legend={`Ways to find step ${n}`}
        value={String(want ?? c.checked)}
        onChange={(v) => {
          setWant(Number(v));
          onChoose(alt.seq, Number(v));
        }}
        options={alt.options.map((o) => ({
          value: String(o.index),
          label: <Txt className="rc-alt-words" text={o.words} />,
          ...(o.index === 0 ? { aside: 'Suggested' } : {}),
          ...(o.fragile.length > 0 ? { detail: fragileWords(o.fragile).join('; ') } : {}),
          testId: 'record-alternative',
        }))}
      />
      {c.checked === -1 && want === null && <p className="sc-quiet">Picked on an earlier press of this target; choose here to change it.</p>}
    </div>
  );
}

/** The words of a row's modifiers (a caption, a mark, a zoom on it): text in the row; their Remove is in the cursor block. */
function modifierChips(r: DraftRow): ReactNode[] {
  return r.modifiers.map((m) => <InsertChip key={m.id} i={m} can={false} onRemove={() => undefined} where="" />);
}

/**
 * One draft row. Editable (L5.11b fixes, review A-M2): an option of its scene's listbox — the list holds the tab stop and
 * the keys; pressing a row (a click, Enter or Space on the active one) puts the cursor after it. Read-only: a list item.
 */
function Row({ r, n, here, option, onPress }: { r: DraftRow; n: number; here: boolean; option: { id: string; active: boolean } | null; onPress: () => void }) {
  const role = r.source?.role;
  const parts = rowParts(r, option !== null);
  const chips = modifierChips(r);
  const meta = chips.length ? (
    <>
      {shown(parts.meta)}
      {parts.meta ? ' · ' : null}
      {shown(chips)}
    </>
  ) : (
    parts.meta
  );
  return (
    <RowListItem className={['rc-row', role === 'insert' ? 'is-insert' : '', role === 'helper' ? 'is-helper' : ''].filter(Boolean).join(' ')} testId="record-step" data={{ key: r.key, row: r.id, role: role ?? '', helper: r.source?.helper ?? '' }}>
      {option ? (
        <RowCard compact option={option} tile={String(n)} title={parts.title} meta={meta} aside={parts.aside} selected={here} onSelect={onPress} testId="record-insert-after" />
      ) : (
        <div className="rc-row-static">
          <span className="rc-row-n">{shown(String(n))}</span>
          <span className="rc-row-text">
            <span className="rc-row-title">{shown(parts.title)}</span>
            {meta && <span className="rc-row-meta">{shown(meta)}</span>}
          </span>
        </div>
      )}
    </RowListItem>
  );
}

/** The selected row's own inserts, each with its Remove (an insert row, the modifiers on a row). */
function RowRemoves({ r, where, onRemove }: { r: DraftRow; where: string; onRemove: (id: string) => void }) {
  if (!r.insert && r.modifiers.length === 0) return null;
  return (
    <p className="rc-chips rc-removes" data-testid="record-removes">
      {r.insert && (
        <Button size="sm" variant="ghost" aria-label={visibleControls(`Remove the ${INSERT_KIND_WORDS[r.insert.kind].toLowerCase()} at ${where}`)} data-testid="record-insert-remove" onClick={() => onRemove(r.insert!.id)}>
          {shown(`Remove the ${INSERT_KIND_WORDS[r.insert.kind].toLowerCase()}`)}
        </Button>
      )}
      {r.modifiers.map((m) => (
        <InsertChip key={m.id} i={m} can onRemove={onRemove} where={`on ${where}`} />
      ))}
    </p>
  );
}

/** The flat order of the draft's rows (the listboxes' keys walk it across scenes). */
interface FlatRow {
  r: DraftRow;
  si: number;
  ri: number;
}

/**
 * The draft's step rows with the cursor block (the selected row's inserts, alternatives and Insert toolbar) among them.
 * L5.11b fixes (review A-M2 / A-L3 / A-L7): editable, each scene's rows are a listbox and the draft is ONE tab stop (the
 * list holding the active row; `aria-activedescendant`): ↑ / ↓ the row before / after (across scenes), Home / End the
 * first / last, Page Up / Page Down three rows (board-keys' `gridMove`, one column), Enter / Space selects the active row
 * (= moves the cursor after it; again: back to the end). The cursor block is not an option (a group inside the list,
 * after its row); at the end it is after every scene, in one place — new rows never move it.
 */
export function DraftList({
  v,
  cursor,
  setCursor,
  act,
  busy,
  form,
  setForm,
}: {
  v: RecordViewAnswer;
  cursor: Cursor;
  setCursor: (c: Cursor) => void;
  act: RecordingActions;
  busy: boolean;
  form: InsertFormState;
  setForm: (f: (was: InsertFormState) => InsertFormState) => void;
}) {
  const u = v.untrusted!;
  const scenes = draftRows(u);
  const can = v.can.annotate;
  const live = LIVE_STATES.has(v.state);
  const inserts = new Map(u.inserts.map((i) => [i.id, i]));
  const remove = (id: string) => act.annotate({ op: 'remove', id });
  const choose = (seq: number, index: number) => act.annotate({ op: 'choose', seq, index });
  const where = cursorRow(u, cursor);
  const flat: FlatRow[] = scenes.flatMap((s, si) => s.rows.map((r, ri) => ({ r, si, ri })));
  const selected = cursor.at === 'after' ? cursor.row : null;
  const [activeId, setActiveId] = useState<string | null>(null);
  const found = (id: string | null) => (id === null ? -1 : flat.findIndex((f) => f.r.id === id));
  const activeAt = found(activeId) >= 0 ? found(activeId) : found(selected) >= 0 ? found(selected) : flat.length ? 0 : -1;
  const active = activeAt >= 0 ? flat[activeAt] : undefined;
  const optId = (i: number) => `rec-opt-${i}`;
  // A key moved the active row: its list takes the focus (it may be another scene's) and the row shows.
  const follow = useRef(false);
  useLayoutEffect(() => {
    if (!follow.current) return;
    follow.current = false;
    const opt = document.getElementById(optId(activeAt));
    const list = opt?.closest<HTMLElement>('[role="listbox"]');
    if (list && document.activeElement !== list) list.focus({ preventScroll: true });
    opt?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
  });
  const press = (r: DraftRow) => {
    if (!r.source) return;
    setActiveId(r.id);
    setCursor(selected === r.id ? { at: 'end' } : { at: 'after', row: r.id });
  };
  const counts = scenes.map((s) => s.rows.length);
  const onKey = (e: KeyboardEvent<HTMLOListElement>) => {
    // Keys of the cursor block's own controls (inside the list) are theirs.
    if (e.target !== e.currentTarget || e.altKey || e.metaKey || e.ctrlKey || !active) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) press(active.r);
      return;
    }
    const to = gridMove(counts, { scene: active.si, index: active.ri }, e.key, 1);
    if (!to) return;
    e.preventDefault();
    const next = scenes[to.scene]?.rows[to.index];
    if (!next) return;
    follow.current = true;
    setActiveId(next.id);
  };
  // A list taking the focus with the active row elsewhere (a click in its gaps): its first row is the active one.
  const onListFocus = (e: ReactFocusEvent<HTMLOListElement>, si: number) => {
    if (e.target !== e.currentTarget || !active || active.si === si) return;
    const first = scenes[si]?.rows[0];
    if (first) setActiveId(first.id);
  };
  const block = (row: DraftRow | null, n: number, scene: string) => (
    <div className="rc-here" role="group" aria-label={row ? `Inserts go after step ${n}` : 'Inserts go here: at the end'} data-testid="record-cursor">
      {row && <RowRemoves r={row} where={stepWords(scene, row.step.index)} onRemove={remove} />}
      {row && row.alt && row.alt.options.length > 1 && <Alternatives row={row} n={n} onChoose={choose} pending={busy} />}
      <Inserts where={where} zoom={v.zoom} setCursor={setCursor} act={act} live={live} form={form} setForm={setForm} />
    </div>
  );
  const waiting = v.state === 'recording' && (
    <p className="rc-waiting" data-testid="record-waiting">
      <StatusMark state="recording" word="Waiting for your next action in the browser…" />
    </p>
  );
  const empty = flat.length === 0;
  let i = -1;
  return (
    <div className="rc-draft" data-testid={empty ? 'record-draft-empty' : 'record-draft'}>
      {empty && (
        <p className="sc-quiet" data-testid="record-no-steps">
          {shown(live ? 'No step yet: click in the window — each action becomes a step here.' : 'The draft has no step.')}
        </p>
      )}
      {scenes.map((s, si) =>
        s.rows.length === 0 ? null : (
          <section key={`${s.scene}-${si}`} className="rc-scene" aria-labelledby={`rec-scene-${si}`}>
            <h3 id={`rec-scene-${si}`} className="rc-scene-title">
              {shown(`Scene ${si + 1}: `)}
              <Txt className="k-mono" text={s.scene} />
              {s.page && (
                <span className="rc-quiet">
                  {' · '}
                  <Txt text={s.page} />
                  {s.open && (
                    <>
                      {' '}
                      <Txt className="k-mono" text={s.open} />
                    </>
                  )}
                </span>
              )}
            </h3>
            {can ? (
              <RowList
                className="rc-rows"
                labelledBy={`rec-scene-${si}`}
                testId="record-rows"
                listbox={{ ...(active?.si === si ? { activeId: optId(activeAt) } : {}), tabbable: active?.si === si, onKeyDown: onKey, onFocus: (e) => onListFocus(e, si) }}
              >
                {s.rows.map((r) => {
                  i++;
                  const n = r.step.index + 1;
                  const here = selected !== null && !!r.source && selected === r.id;
                  return (
                    <RowPair key={r.id} here={here} block={<RowListItem>{shown(block(r, n, s.scene))}</RowListItem>}>
                      <Row r={r} n={n} here={here} option={{ id: optId(i), active: i === activeAt }} onPress={() => press(r)} />
                    </RowPair>
                  );
                })}
              </RowList>
            ) : (
              <RowList className="rc-rows" labelledBy={`rec-scene-${si}`}>
                {s.rows.map((r) => (
                  <Row key={r.id} r={r} n={r.step.index + 1} here={false} option={null} onPress={() => undefined} />
                ))}
              </RowList>
            )}
          </section>
        ),
      )}
      {can && cursor.at === 'end' && shown(block(null, 0, ''))}
      {u.pending.length > 0 && (
        <div className="rc-pending" data-testid="record-pending">
          <p>Applies to your next action:</p>
          <p className="rc-chips">
            {u.pending.flatMap((id) => (inserts.has(id) ? [inserts.get(id)!] : [])).map((ins) => (
              <InsertChip key={ins.id} i={ins} can={can} onRemove={remove} where="waiting for your next action" />
            ))}
          </p>
        </div>
      )}
      {shown(waiting)}
    </div>
  );
}

function RowPair({ here, block, children }: { here: boolean; block: ReactNode; children: ReactNode }) {
  return (
    <>
      {shown(children)}
      {here && shown(block)}
    </>
  );
}

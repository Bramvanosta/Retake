/** The Insert toolbar at the draft's cursor and its forms (Hold, Wait for…, Caption…, Mark, Zoom…). */
import { useEffect, useRef } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { RecordAnnotationChange, RecordInsertAt } from '@retake/core';
import type { RecordViewAnswer } from '../../server/record-ops.js';
import { Txt, shown, visibleControls } from '../bits.js';
import { Button, RadioGroup, TextField, Toolbar } from '../ui-kit/index.js';
import { CAPTION_MAX, HOLD_DEFAULT_S, KICKER_MAX, WAIT_TEXT_MAX, textProblem } from '../record-words.js';
import type { Cursor, RecordingActions } from './draft.js';

type InsertForm = 'wait' | 'caption' | 'zoom';

/**
 * The open insert form and what is typed in it. L5.11b fixes (review A-L7 / B-L3): held by the recording's body, not by
 * the cursor block — the block moves (the first row arrives, a new scene starts, a row before it changes) and the form
 * keeps its text; the focus keeper puts the focus back on the field by its test id. `focus`: the form was just opened
 * (its first field takes the focus once; a block mounted again never takes it).
 */
export interface InsertFormState {
  open: InsertForm | null;
  until: 'next_target' | 'idle' | 'text';
  waitText: string;
  caption: string;
  kicker: string;
  /** The zoom factor chosen (null: the theme's default). */
  factor: string | null;
  problem: string | null;
  focus: boolean;
}

export const NO_INSERT_FORM: InsertFormState = { open: null, until: 'next_target', waitText: '', caption: '', kicker: '', factor: null, problem: null, focus: false };

/** The Insert toolbar at the cursor (`where`: the cursor's row, null at the end) and the open insert form. */
export function Inserts({
  where,
  zoom,
  setCursor,
  act,
  live,
  form,
  setForm,
}: {
  where: { label: string; at: RecordInsertAt } | null;
  zoom: RecordViewAnswer['zoom'];
  setCursor: (c: Cursor) => void;
  act: RecordingActions;
  live: boolean;
  form: InsertFormState;
  setForm: (f: (was: InsertFormState) => InsertFormState) => void;
}) {
  const at: RecordInsertAt = where ? where.at : 'end';
  const add = (insert: Extract<RecordAnnotationChange, { op: 'insert' }>['insert']) => act.annotate({ op: 'insert', at, insert });
  const open = form.open;
  const set = (patch: Partial<InsertFormState>) => setForm((f) => ({ ...f, ...patch }));
  const formRef = useRef<HTMLFormElement>(null);
  const opener = (f: InsertForm) => document.querySelector<HTMLElement>(`[data-testid="record-insert-${f}"]`);
  const close = () => {
    const was = open;
    set({ open: null, problem: null, focus: false });
    if (was) opener(was)?.focus();
  };
  useEffect(() => {
    if (!open || !form.focus) return;
    formRef.current?.querySelector<HTMLElement>('input:checked, input[type="text"], input, textarea')?.focus();
    set({ focus: false });
  }, [open, form.focus]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  const factor = form.factor ?? String(zoom?.default ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (open === 'wait') {
      const p = form.until === 'text' ? textProblem(form.waitText, WAIT_TEXT_MAX) : null;
      set({ problem: p });
      if (p) return;
      add(form.until === 'text' ? { kind: 'wait_for', until: form.until, text: form.waitText } : { kind: 'wait_for', until: form.until });
      set({ waitText: '' });
    } else if (open === 'caption') {
      const p = textProblem(form.caption, CAPTION_MAX) ?? (form.kicker ? textProblem(form.kicker, KICKER_MAX) : null);
      set({ problem: p });
      if (p) return;
      add({ kind: 'caption', text: form.caption, ...(form.kicker ? { kicker: form.kicker } : {}) });
      set({ caption: '', kicker: '' });
    } else if (open === 'zoom' && zoom) {
      add({ kind: 'camera', zoom: Number(factor), until: 'scene_end' });
    }
    close();
  };
  const label = where ? `Insert after ${where.label}` : 'Insert at the end';
  const toggle = (f: InsertForm) => setForm((was) => ({ ...was, problem: null, open: was.open === f ? null : f, focus: was.open !== f }));
  return (
    <div className="rc-insert" data-testid="record-inserts">
      <p className="rc-insert-where" data-testid="record-cursor-where">
        {where ? (
          <>
            {'Insert after '}
            <Txt text={where.label} />
          </>
        ) : (
          shown(live ? 'Insert at the end — a hold or a wait goes before your next action; a caption, a mark or a zoom goes on it.' : 'Insert at the end — a hold or a wait goes after the last step; a caption, a mark or a zoom goes on it.')
        )}
      </p>
      <Toolbar label={visibleControls(label)}>
        <Button size="sm" data-testid="record-insert-hold" onClick={() => add({ kind: 'hold', seconds: HOLD_DEFAULT_S })}>
          {shown(`Hold ${HOLD_DEFAULT_S} s`)}
        </Button>
        <Button size="sm" data-testid="record-insert-wait" aria-expanded={open === 'wait'} onClick={() => toggle('wait')}>
          Wait for…
        </Button>
        <Button size="sm" data-testid="record-insert-caption" aria-expanded={open === 'caption'} onClick={() => toggle('caption')}>
          Caption…
        </Button>
        <Button size="sm" data-testid="record-insert-mark" onClick={() => add({ kind: 'mark' })}>
          Mark
        </Button>
        {zoom && (
          <Button size="sm" data-testid="record-insert-zoom" aria-expanded={open === 'zoom'} onClick={() => toggle('zoom')}>
            Zoom…
          </Button>
        )}
        {where && (
          <Button size="sm" variant="ghost" data-testid="record-cursor-end" onClick={() => setCursor({ at: 'end' })}>
            Back to the end
          </Button>
        )}
      </Toolbar>
      {open && (
        <form ref={formRef} className="rc-insert-form" onKeyDown={onKey} onSubmit={submit} aria-label={open === 'wait' ? 'Wait for' : open === 'caption' ? 'Caption' : 'Zoom'}>
          {open === 'wait' && (
            <>
              <RadioGroup
                legend="Wait until"
                value={form.until}
                onChange={(v) => set({ until: v as InsertFormState['until'] })}
                options={[
                  { value: 'next_target', label: 'the next target shows', testId: 'record-wait-until' },
                  { value: 'idle', label: 'the page is idle', testId: 'record-wait-until' },
                  { value: 'text', label: 'a text shows', testId: 'record-wait-until' },
                ]}
              />
              {form.until === 'text' && <TextField label="Text" testId="record-wait-text" value={form.waitText} onChange={(t) => set({ waitText: t })} unsaved={null} maxLength={WAIT_TEXT_MAX} />}
            </>
          )}
          {open === 'caption' && (
            <>
              <TextField label="Caption" testId="record-caption-text" value={form.caption} onChange={(t) => set({ caption: t })} unsaved={null} maxLength={CAPTION_MAX} />
              <TextField label="Kicker (optional)" testId="record-caption-kicker" value={form.kicker} onChange={(t) => set({ kicker: t })} unsaved={null} maxLength={KICKER_MAX} />
            </>
          )}
          {open === 'zoom' && zoom && (
            <>
              <RadioGroup
                legend="Zoom factor"
                value={factor}
                onChange={(f) => set({ factor: f })}
                options={zoom.options.map((f) => ({ value: String(f), label: `${f}×`, ...(f === zoom.max ? { aside: 'the theme’s maximum' } : {}), testId: 'record-zoom-factor' }))}
              />
              <p className="sc-quiet">{shown(`Zoom goes up to the theme’s maximum, ${zoom.max}×; it holds until the scene ends.`)}</p>
            </>
          )}
          {form.problem && (
            <p className="rc-error" role="alert">
              {shown(form.problem)}
            </p>
          )}
          <div className="rc-form-act">
            <Button size="sm" variant="primary" submit data-testid={open === 'wait' ? 'record-wait-add' : open === 'caption' ? 'record-caption-add' : 'record-zoom-add'}>
              {open === 'wait' ? 'Add the wait' : open === 'caption' ? 'Add the caption' : 'Add the zoom'}
            </Button>
            <Button size="sm" variant="ghost" data-testid="record-insert-close" onClick={close}>
              Close
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

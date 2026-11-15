/**
 * The theme editor's single-value controls: a one-line text, the largest zoom, the default zoom and a logo / wordmark
 * file. Each sends a plan through `send` (the editor's one write path).
 */
import { useEffect, useState } from 'react';
import type { ThemeEditView } from '@retake/engine';
import { TEXT_MAX, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, fieldEdit, isRemovable, textProblem, written } from '../words/theme-words.js';
import type { ThemeEdit } from '../words/theme-words.js';
import { NumberField, Select, TextField } from '../ui-kit/index.js';

export type Send = (plan: { edit: ThemeEdit } | { why: string } | null) => void;

/** A one-line text value: written on Enter or when the field is left (an empty removable field removes it). */
export function ThemeText({ label, field, view, off, send, hint }: { label: string; field: string; view: ThemeEditView; off: boolean; send: Send; hint?: string }) {
  const w = written(view, field);
  const shown = typeof w === 'string' ? w : w === undefined ? '' : String(w);
  const [text, setText] = useState(shown);
  // A new version read (a write, a refusal, another writer): the field shows what is written.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new file version (a refusal re-read with the same value) is a trigger to show what is written
  useEffect(() => setText(shown), [shown, view.sha256]);
  const problem = text !== shown && text !== '' && field in TEXT_MAX ? textProblem(field, text) : null;
  const commit = () => {
    if (text === shown) return;
    if (text === '' && !isRemovable(field)) return setText(shown);
    send(fieldEdit(view, field, text === '' ? undefined : text));
  };
  return (
    <TextField
      label={label}
      layout="row"
      value={text}
      onChange={setText}
      // Written on Enter or when left (not work kept in the tab).
      unsaved={null}
      disabled={off}
      maxLength={TEXT_MAX[field] ?? 200}
      testId={`text-${field}`}
      error={problem ?? undefined}
      hint={hint}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setText(shown);
      }}
    />
  );
}

/** The largest zoom: written on Enter or when the field is left. */
export function ZoomField({ label, field, view, off, send }: { label: string; field: string; view: ThemeEditView; off: boolean; send: Send }) {
  const w = written(view, field);
  const shown = typeof w === 'number' ? String(w) : '';
  const [text, setText] = useState(shown);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new file version (a refusal re-read with the same value) is a trigger to show what is written
  useEffect(() => setText(shown), [shown, view.sha256]);
  const commit = () => {
    if (text === shown || text === '') return setText(shown);
    send(fieldEdit(view, field, Number(text)));
  };
  return (
    <NumberField
      label={label}
      layout="row"
      min={ZOOM_MIN}
      max={ZOOM_MAX}
      step={ZOOM_STEP}
      value={text}
      disabled={off}
      testId={`number-${field}`}
      onChange={setText}
      onBlur={commit}
      onEnter={commit}
      hint="× (1 to 3, steps of 0.01)"
    />
  );
}

/** The default zoom: none, or a number from 1 to 3 (removable: the theme's default). */
export function DefaultZoom({ view, off, send }: { view: ThemeEditView; off: boolean; send: Send }) {
  const w = written(view, 'motion.default_zoom');
  const [text, setText] = useState(typeof w === 'number' ? String(w) : '');
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new file version (a refusal re-read with the same value) is a trigger to show what is written
  useEffect(() => setText(typeof w === 'number' ? String(w) : ''), [w, view.sha256]);
  const mode = w === undefined ? 'default' : w === 'none' ? 'none' : 'number';
  const commit = () => text !== '' && Number(text) !== w && send(fieldEdit(view, 'motion.default_zoom', Number(text)));
  return (
    <>
      <Select
        label="Default zoom"
        layout="row"
        value={mode}
        disabled={off}
        testId="default-zoom"
        onChange={(m) => {
          if (m === 'none') send(fieldEdit(view, 'motion.default_zoom', 'none'));
          else if (m === 'default') send(fieldEdit(view, 'motion.default_zoom', undefined));
          else send(fieldEdit(view, 'motion.default_zoom', 1.2));
        }}
        options={[
          { value: 'default', label: "The theme's default" },
          { value: 'none', label: 'None' },
          { value: 'number', label: 'A zoom' },
        ]}
      />
      {mode === 'number' && (
        <NumberField label="Default zoom factor" layout="row" min={ZOOM_MIN} max={ZOOM_MAX} step={ZOOM_STEP} value={text} disabled={off} onChange={setText} onBlur={commit} onEnter={commit} />
      )}
    </>
  );
}

/** A logo / wordmark among the theme folder's image files (listed by name, never shown here). */
export function FileSelect({ label, field, view, files, off, send, none }: { label: string; field: string; view: ThemeEditView; files: string[]; off: boolean; send: Send; none?: string }) {
  const w = written(view, field);
  const cur = typeof w === 'string' ? w : '';
  const options = [
    ...(none !== undefined ? [{ value: '', label: none }] : cur === '' ? [{ value: '', label: '(not set)' }] : []),
    ...(cur !== '' && !files.includes(cur) ? [{ value: cur, label: `${cur} (as written; not a usable image)` }] : []),
    ...files.map((f) => ({ value: f, label: f })),
  ];
  return <Select label={label} layout="row" value={cur} disabled={off} testId={`file-${field}`} options={options} onChange={(x) => send(fieldEdit(view, field, x === '' ? undefined : x))} />;
}

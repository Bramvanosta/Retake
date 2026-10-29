/**
 * L5.9: fields — `TextField`, `TextArea`, `Select`, `FieldRow`. Native elements with a visible label (stacked, or in the
 * inspector's row: a right-aligned 96 px label column). The text inputs carry the tab's unsaved mark (L5.2b,
 * drafts.ts): `unsaved` is REQUIRED — the item the desktop app's quit question names while the value differs from its
 * `baseline` — or an explicit `null` for text that is no one's work (a search box); a test parses these two components
 * for the `useUnsavedMark(unsavedFor(…))` call. An error is said in words, starting "Error:" (the red edge is never the only
 * cue: `aria-invalid`, `aria-describedby`).
 */
import { useId } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useUnsavedMark } from '../drafts.js';
import type { UnsavedItem } from '../drafts.js';
import { Icon } from './Icon.js';
import { shown, visibleControls } from '../bits.js';

/** The unsaved mark of a text input: its item while the value differs from the baseline (and an item is given). */
export function unsavedFor(value: string, baseline: string, item: UnsavedItem | null): UnsavedItem | null {
  return item !== null && value !== baseline ? item : null;
}

export type FieldLayout = 'stack' | 'row';

interface TextCommon {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** The saved value (default ''): the field is unsaved while `value` differs from it. */
  baseline?: string;
  /** What the quit question says is unsaved here, or null (no one's work: a search, a filter). Required. */
  unsaved: UnsavedItem | null;
  mono?: boolean;
  error?: ReactNode;
  hint?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  layout?: FieldLayout;
  id?: string;
  name?: string;
}

function Frame({ id, label, hint, error, layout, children }: { id: string; label: ReactNode; hint?: ReactNode; error?: ReactNode; layout: FieldLayout; children: ReactNode }) {
  return (
    <div className={`k-field k-field-${layout}`}>
      <label className="k-field-label" htmlFor={id}>
        {shown(label)}
      </label>
      <div className="k-field-body">
        {shown(children)}
        {hint && (
          <span id={`${id}-hint`} className="k-hint">
            {shown(hint)}
          </span>
        )}
        {error && (
          <span id={`${id}-error`} className="k-error">
            <span className="k-error-word">Error:</span> {shown(error)}
          </span>
        )}
      </div>
    </div>
  );
}

const describedBy = (id: string, hint: ReactNode, error: ReactNode) => [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;

export function TextField({ label, value, onChange, baseline = '', unsaved, mono, error, hint, placeholder, disabled, readOnly, layout = 'stack', id, name, type = 'text', onKeyDown }: TextCommon & { type?: 'text' | 'search' | 'url' | 'email'; onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void }) {
  useUnsavedMark(unsavedFor(value, baseline, unsaved));
  const own = useId();
  const fid = id ?? own;
  return (
    <Frame id={fid} label={label} hint={hint} error={error} layout={layout}>
      <input
        id={fid}
        name={name}
        type={type}
        className={mono ? 'k-input k-mono' : 'k-input'}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fid, hint, error)}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
    </Frame>
  );
}

export function TextArea({ label, value, onChange, baseline = '', unsaved, mono, error, hint, placeholder, disabled, readOnly, layout = 'stack', id, name, rows = 4 }: TextCommon & { rows?: number }) {
  useUnsavedMark(unsavedFor(value, baseline, unsaved));
  const own = useId();
  const fid = id ?? own;
  return (
    <Frame id={fid} label={label} hint={hint} error={error} layout={layout}>
      <textarea
        id={fid}
        name={name}
        rows={rows}
        className={mono ? 'k-input k-textarea k-mono' : 'k-input k-textarea'}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fid, hint, error)}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </Frame>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** A native select (the system draws its menu: nothing to build, nothing to trap). */
export function Select({ label, value, options, onChange, disabled, hint, layout = 'stack', id }: { label: ReactNode; value: string; options: SelectOption[]; onChange: (value: string) => void; disabled?: boolean; hint?: ReactNode; layout?: FieldLayout; id?: string }) {
  const own = useId();
  const fid = id ?? own;
  return (
    <Frame id={fid} label={label} hint={hint} layout={layout}>
      <span className="k-select">
        <select id={fid} className="k-select-input" value={value} disabled={disabled} aria-describedby={describedBy(fid, hint, undefined)} onChange={(e) => onChange(e.currentTarget.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {visibleControls(o.label)}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" className="k-select-chevron" />
      </span>
    </Frame>
  );
}

/** The inspector's row for anything that is not one native field: a group named by its label. */
export function FieldRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <div className="k-field k-field-row" role="group" aria-labelledby={`${id}-label`}>
      <span id={`${id}-label`} className="k-field-label">
        {shown(label)}
      </span>
      <div className="k-field-body">
        {shown(children)}
        {hint && <span className="k-hint">{shown(hint)}</span>}
      </div>
    </div>
  );
}

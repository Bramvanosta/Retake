/**
 * L5.9: fields — `TextField`, `TextArea`, `Select`, `FieldRow` (L5.11b: `RadioGroup`). Native elements with a visible label (stacked, or in the
 * inspector's row: a right-aligned 96 px label column). The text inputs carry the tab's unsaved mark (L5.2b,
 * drafts.ts): `unsaved` is REQUIRED — the item the desktop app's quit question names while the value differs from its
 * `baseline` — or an explicit `null` for text that is no one's work (a search box); a test parses these two components
 * for the `useUnsavedMark(unsavedFor(…))` call. An error is said in words, starting "Error:" (the red edge is never the only
 * cue: `aria-invalid`, `aria-describedby`).
 */
import { useId } from 'react';
import type { HTMLAttributes, KeyboardEvent, ReactNode, Ref } from 'react';
import { useUnsavedMark } from '../drafts.js';
import type { UnsavedItem } from '../drafts.js';
import { Icon } from './Icon.js';
import { shown, visibleControls } from '../bits.js';

/** The unsaved mark of a text input: its item while the value differs from the baseline (and an item is given). */
export function unsavedFor(value: string, baseline: string, item: UnsavedItem | null): UnsavedItem | null {
  return item !== null && value !== baseline ? item : null;
}

export type FieldLayout = 'stack' | 'row' | 'inline';

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
  /** L5.10b: the field's key as a data attribute (a step form's `data-field`: tests and the form find it by it). */
  dataField?: string;
  /** L5.10b: a test id kept from an older screen. */
  testId?: string;
  /** L5.10b: a tooltip (the schema's description of a step field). */
  title?: string;
  /** L5.10b: more ids that describe the input (a counter, a save state), after the hint and the error. */
  describedBy?: string;
  /** L5.10b: the label visually hidden (still the input's name). */
  labelHidden?: boolean;
}

function Frame({ id, label, hint, error, layout, labelHidden, children }: { id: string; label: ReactNode; hint?: ReactNode; error?: ReactNode; layout: FieldLayout; labelHidden?: boolean; children: ReactNode }) {
  return (
    <div className={`k-field k-field-${layout}${labelHidden ? ' k-field-bare' : ''}`}>
      <label className={labelHidden ? 'k-field-label k-sr' : 'k-field-label'} htmlFor={id}>
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

const describedBy = (id: string, hint: ReactNode, error: ReactNode, more?: string) => [hint ? `${id}-hint` : '', error ? `${id}-error` : '', more ?? ''].filter(Boolean).join(' ') || undefined;

/**
 * L5.10a fixes (review B-L4, B-L6): a search keeps its limits (`maxLength`, no autocomplete, no spell check), and its
 * label may be visually hidden (`labelHidden`: still the input's name) with a search icon in the field.
 */
export function TextField({ label, value, onChange, baseline = '', unsaved, mono, error, hint, placeholder, disabled, readOnly, layout = 'stack', id, name, type = 'text', onKeyDown, maxLength, autoComplete, spellCheck, labelHidden, dataField, testId, title, describedBy: more, inputMode }: TextCommon & { type?: 'text' | 'search' | 'url' | 'email'; onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void; maxLength?: number; autoComplete?: string; spellCheck?: boolean; inputMode?: HTMLAttributes<HTMLInputElement>['inputMode'] }) {
  useUnsavedMark(unsavedFor(value, baseline, unsaved));
  const own = useId();
  const fid = id ?? own;
  const icon = labelHidden && type === 'search';
  return (
    <Frame id={fid} label={label} hint={hint} error={error} layout={layout} labelHidden={labelHidden}>
      {icon && <Icon name="search" className="k-input-icon" />}
      <input
        id={fid}
        name={name}
        type={type}
        className={`${mono ? 'k-input k-mono' : 'k-input'}${icon ? ' k-input-with-icon' : ''}`}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        maxLength={maxLength}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
        inputMode={inputMode}
        title={title}
        data-field={dataField}
        data-testid={testId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fid, hint, error, more)}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
    </Frame>
  );
}

/**
 * L5.10b (critique M5): a text area for an editor too — its element (`inputRef`: a caret moved to a line), a cap
 * (`maxLength`), spell check and auto-correction off, more describing ids; `unsaved={null}` when the caller owns the
 * mark (the YAML draft's is drafts.ts's: the quit question never lists it twice).
 */
export function TextArea({ label, value, onChange, baseline = '', unsaved, mono, error, hint, placeholder, disabled, readOnly, layout = 'stack', id, name, rows = 4, inputRef, maxLength, spellCheck, autoCorrect, testId, describedBy: more, labelHidden, tall }: TextCommon & { rows?: number; inputRef?: Ref<HTMLTextAreaElement>; maxLength?: number; spellCheck?: boolean; /** Off: auto-capitalisation and auto-correction off too (code, YAML). */ autoCorrect?: boolean; /** Fills the height its container gives (an editor). */ tall?: boolean }) {
  useUnsavedMark(unsavedFor(value, baseline, unsaved));
  const own = useId();
  const fid = id ?? own;
  return (
    <Frame id={fid} label={label} hint={hint} error={error} layout={layout} labelHidden={labelHidden}>
      <textarea
        id={fid}
        ref={inputRef}
        name={name}
        rows={rows}
        className={`${mono ? 'k-input k-textarea k-mono' : 'k-input k-textarea'}${tall ? ' k-textarea-tall' : ''}`}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        maxLength={maxLength}
        spellCheck={spellCheck}
        autoCapitalize={autoCorrect === false ? 'off' : undefined}
        autoCorrect={autoCorrect === false ? 'off' : undefined}
        data-testid={testId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fid, hint, error, more)}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </Frame>
  );
}

/**
 * L5.12a: a number field (TextField's sibling: `type="number"`, min / max / step, `inputMode` decimal) — a value written
 * on Set (an inspector's speed, a duration), not typed text: no unsaved mark. Enter runs `onEnter`.
 */
export function NumberField({ label, value, onChange, min, max, step, disabled, error, hint, layout = 'inline', id, testId, onEnter }: { label: ReactNode; value: string; onChange: (value: string) => void; min?: number; max?: number; step?: number; disabled?: boolean; error?: ReactNode; hint?: ReactNode; layout?: FieldLayout; id?: string; testId?: string; onEnter?: () => void }) {
  const own = useId();
  const fid = id ?? own;
  return (
    <Frame id={fid} label={label} hint={hint} error={error} layout={layout}>
      <input
        id={fid}
        type="number"
        inputMode="decimal"
        className="k-input k-input-number k-mono"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        data-testid={testId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fid, hint, error)}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
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
export function Select({ label, value, options, onChange, disabled, hint, error, layout = 'stack', id, dataField, testId, title, labelHidden }: { label: ReactNode; value: string; options: SelectOption[]; onChange: (value: string) => void; disabled?: boolean; hint?: ReactNode; /** L5.10b: an error in words ("Error: …"), as the text fields. */ error?: ReactNode; layout?: FieldLayout; id?: string; dataField?: string; testId?: string; title?: string; labelHidden?: boolean }) {
  const own = useId();
  const fid = id ?? own;
  return (
    <Frame id={fid} label={label} hint={hint} error={error} layout={layout} labelHidden={labelHidden}>
      <span className="k-select">
        <select id={fid} className="k-select-input" value={value} disabled={disabled} title={title} data-field={dataField} data-testid={testId} aria-invalid={error ? true : undefined} aria-describedby={describedBy(fid, hint, error)} onChange={(e) => onChange(e.currentTarget.value)}>
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

export interface RadioOption {
  value: string;
  label: ReactNode;
  /** A second line under the label (what the choice means, why it may be fragile): it wraps. */
  detail?: ReactNode;
  /** A word on the right ("Suggested", "the theme's maximum"). */
  aside?: ReactNode;
  disabled?: boolean;
  testId?: string;
}

/**
 * L5.11b: a radio group — a `fieldset` of native radios named by its legend (visible, or hidden and still the group's
 * name); each option a label that covers its row: the label, a second line, a word on the right. One tab stop, the arrows
 * move and check (the platform's); the checked radio is a filled dot inside a ring (a shape, not a colour only). A
 * `value` that matches no option leaves every radio unchecked (a choice made elsewhere).
 */
export function RadioGroup({ legend, legendHidden, value, options, onChange, disabled, testId }: { legend: ReactNode; legendHidden?: boolean; value: string; options: RadioOption[]; onChange: (value: string) => void; disabled?: boolean; testId?: string }) {
  const name = useId();
  return (
    <fieldset className="k-radios" disabled={disabled} data-testid={testId}>
      <legend className={legendHidden ? 'k-sr' : 'k-radios-legend'}>{shown(legend)}</legend>
      {options.map((o) => (
        <label key={o.value} className="k-radio">
          <input type="radio" className="k-radio-input" name={name} value={o.value} checked={o.value === value} disabled={o.disabled} onChange={() => onChange(o.value)} data-testid={o.testId} />
          <span className="k-radio-text">
            <span className="k-radio-label">{shown(o.label)}</span>
            {o.detail !== undefined && <span className="k-radio-detail">{shown(o.detail)}</span>}
          </span>
          {o.aside !== undefined && <span className="k-radio-aside">{shown(o.aside)}</span>}
        </label>
      ))}
    </fieldset>
  );
}

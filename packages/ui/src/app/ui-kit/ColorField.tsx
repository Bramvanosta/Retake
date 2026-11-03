/**
 * L5.12c: `ColorField` (R4-Theme's inspector) — one colour: the native `<input type="color">` (the system's picker: its
 * well is the swatch the person drags from; every move is `onDraft`, the release — the input's native `change`, not
 * React's onChange which fires on every move — is `onCommit`), and the hex typed in a text field beside it (written on
 * Enter or when the field is left; an empty removable field is `onRemove`; anything but a hex goes back to the written
 * value). While a colour is dragged, a small swatch in the hex field shows the WRITTEN colour beside the well's draft
 * ("previewing #…" says it in words); otherwise the well alone is the swatch (review B-L1).
 * L5.12c fixes: `version` (the written file's version, e.g. its sha256) — a new one puts the written value back in the
 * hex field even when the value is the same (a refused write re-read: review A-M1 / B-L5 — leaving the field never
 * sends the refused colour again); `onText` — a form that owns the text (the New theme form) gets every keystroke and
 * the field keeps what was typed (the form says why a value is not a hex: review B-M2); an unset colour says "not set"
 * in words for a screen reader too (review A-L3); the swatch draws only a hex value (review A-L5).
 * The kit holds no colour: the picker's value (a fallback when nothing is written) and the swatch's colour come from the
 * caller as data — theme data, from the theme files (a lint keeps colour literals there). Its label is the picker's
 * `<label>`; the hex field is named by that label and the hidden word "hex" (no copy of the label in an attribute).
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { shown } from '../bits.js';

/** `#rgb` or `#rrggbb` (what the hex field writes). */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function ColorField({
  label,
  hint,
  value,
  picker,
  swatch,
  unset,
  draft,
  disabled,
  removable,
  onDraft,
  onCommit,
  onRemove,
  testId,
  layout = 'row',
  version,
  onText,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** The written value (the hex field's text; '' when nothing is written). */
  value: string;
  /** The picker's value, `#rrggbb` (the draft while one is dragged; the caller's fallback when nothing is written). */
  picker: string;
  /** The written colour's swatch (a hex value only), or nothing. */
  swatch?: string;
  /** Nothing written: the picker's well is drawn hatched (its value is a fallback). */
  unset?: boolean;
  /** A colour being dragged and not written yet (said in words). */
  draft?: string;
  disabled?: boolean;
  /** An empty hex field removes the value (else it goes back to the written one). */
  removable?: boolean;
  onDraft: (hex: string) => void;
  onCommit: (hex: string) => void;
  onRemove?: () => void;
  /** The wrapper's test id; the picker's is `<id>-picker`, the hex field's `<id>-hex`. */
  testId?: string;
  layout?: 'row' | 'stack';
  /** The written file's version: a new one shows the written value again (a refusal re-read with the same value). */
  version?: string;
  /** The text belongs to the caller (a form): every keystroke goes there and the field keeps it as typed. */
  onText?: (text: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [own, setText] = useState(value);
  const text = onText ? value : own;
  // A new written value or version (a write, a refusal, another writer): the field shows what is written.
  useEffect(() => setText(value), [value, version]);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The native change: the picker was released or closed (React's onChange is every move).
    const on = () => commitRef.current(el.value);
    el.addEventListener('change', on);
    return () => el.removeEventListener('change', on);
  }, []);
  const id = useId();
  const commitText = () => {
    if (text === value) return;
    if (text === '' && removable && onRemove) return onRemove();
    if (HEX.test(text)) onCommit(text);
    else setText(value);
  };
  const dot = draft !== undefined && swatch !== undefined && HEX.test(swatch) ? swatch : null;
  const described = [hint ? `${id}-hint` : '', unset ? `${id}-unset` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`k-field k-field-${layout} k-color`} data-testid={testId}>
      <label className="k-field-label" htmlFor={id} id={`${id}-label`}>
        {shown(label)}
      </label>
      <div className="k-field-body">
        <span className="k-color-line">
          <input
            ref={ref}
            type="color"
            id={id}
            className={unset ? 'k-color-well is-unset' : 'k-color-well'}
            value={picker}
            disabled={disabled}
            aria-describedby={described}
            onChange={(e) => onDraft(e.currentTarget.value)}
            data-testid={testId ? `${testId}-picker` : undefined}
          />
          <span className="k-color-hex">
            {dot !== null && <span className="k-color-swatch" style={{ background: dot }} aria-hidden="true" />}
            <input
              className="k-input k-mono k-color-text"
              value={text}
              placeholder={removable ? 'not set' : ''}
              disabled={disabled}
              maxLength={7}
              autoComplete="off"
              spellCheck={false}
              aria-labelledby={`${id}-label ${id}-hexword`}
              aria-describedby={unset ? `${id}-unset` : undefined}
              data-testid={testId ? `${testId}-hex` : undefined}
              onChange={(e) => (onText ? onText(e.currentTarget.value.trim()) : setText(e.currentTarget.value.trim()))}
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitText();
                if (e.key === 'Escape' && !onText) setText(value);
              }}
            />
            <span id={`${id}-hexword`} className="k-sr">
              hex
            </span>
            {unset && (
              <span id={`${id}-unset`} className="k-sr" data-testid={testId ? `${testId}-unset` : undefined}>
                {shown(`not set (the picker starts at ${picker})`)}
              </span>
            )}
          </span>
        </span>
        {draft !== undefined && <span className="k-color-draft">{shown(`previewing ${draft}`)}</span>}
        {hint && (
          <span id={`${id}-hint`} className="k-hint">
            {shown(hint)}
          </span>
        )}
      </div>
    </div>
  );
}

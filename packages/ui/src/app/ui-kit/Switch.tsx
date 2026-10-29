/**
 * L5.9: the switch — a native checkbox with `role="switch"` drawn as the track itself (appearance none: the real element
 * takes the click, the focus ring and Space), the knob a sibling that slides (on: right and the accent fill; off: left
 * on a grey track — position, not only colour). The label row is a `<label>`: a click on the words toggles too. The
 * name is the label alone (`aria-labelledby`), the hint its description (review A-L3: never "NotificationsA notice…").
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import { shown } from '../bits.js';

export function Switch({ label, checked, onChange, hint, disabled }: { label: ReactNode; checked: boolean; onChange: (on: boolean) => void; hint?: ReactNode; disabled?: boolean }) {
  const hintId = useId();
  const labelId = useId();
  return (
    <label className="k-switch-row">
      <span className="k-switch-text">
        <span id={labelId} className="k-switch-label">
          {shown(label)}
        </span>
        {hint && (
          <span id={hintId} className="k-hint">
            {shown(hint)}
          </span>
        )}
      </span>
      <span className="k-switch">
        <input type="checkbox" role="switch" className="k-switch-input" checked={checked} disabled={disabled} aria-labelledby={labelId} aria-describedby={hint ? hintId : undefined} onChange={(e) => onChange(e.currentTarget.checked)} />
        <span className="k-switch-knob" aria-hidden="true" />
      </span>
    </label>
  );
}

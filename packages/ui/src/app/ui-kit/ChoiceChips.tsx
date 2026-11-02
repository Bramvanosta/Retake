/**
 * L5.12a: choice chips (R4-Edit's inspector) — one choice of a few, written at once by a click: a radio group of
 * `<button role="radio">` (the native radios cannot do what this does — L4.5's switch, generalised):
 * - one tab stop (the checked chip, else the first); the arrows, Home and End move the focus only, Space / Enter picks
 *   (a pick writes a file: never one write per arrow press);
 * - a chip that cannot be picked stays focusable with `aria-disabled` and its reason after a dash (read with it, shown
 *   beside its label: never a disabled button that skips the reason);
 * - a value `null` is the empty string in `data-value` (the "default" choice), test ids passed through;
 * - the checked chip is a raised fill, weight 600 and a 2 px ring (more than colour: the checker's selected rule).
 */
import type { KeyboardEvent, ReactNode } from 'react';
import { shown } from '../bits.js';

export interface ChoiceChip {
  /** Its identity in the group (what `onPick` gets back). */
  key: string;
  label: ReactNode;
  /** `data-value`: the value it writes, '' for the default (null). */
  value: string;
  checked: boolean;
  /** Cannot be picked now (still focusable, with `why`). */
  disabled?: boolean;
  /** Why it cannot be picked (shown after " — "). */
  why?: ReactNode;
}

/** Arrows / Home / End move the focus within the group (Space / Enter picks: the chip's own click). */
function rove(e: KeyboardEvent<HTMLDivElement>): void {
  const steps: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  const d = steps[e.key] ?? (e.key === 'Home' ? -Infinity : e.key === 'End' ? Infinity : 0);
  if (!d) return;
  const chips = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  const at = chips.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0 || chips.length === 0) return;
  e.preventDefault();
  const next = d === -Infinity ? 0 : d === Infinity ? chips.length - 1 : (at + d + chips.length) % chips.length;
  chips[next].focus();
}

export function ChoiceChips({
  labelledBy,
  chips,
  onPick,
  off,
  optionTestId,
  whyTestId,
}: {
  /** The id of the group's visible name (a legend, a heading). */
  labelledBy: string;
  chips: ChoiceChip[];
  onPick: (key: string) => void;
  /** The whole group is off (still focusable: its reason is said elsewhere). */
  off?: boolean;
  optionTestId?: string;
  whyTestId?: string;
}) {
  const stop = chips.find((c) => c.checked)?.key ?? chips[0]?.key;
  return (
    <div className="k-chips" role="radiogroup" aria-labelledby={labelledBy} aria-disabled={off || undefined} onKeyDown={rove}>
      {chips.map((c) => {
        const disabled = off || c.disabled;
        return (
          <button
            key={c.key}
            type="button"
            role="radio"
            className={`k-chip${c.checked ? ' is-checked' : ''}${c.why !== undefined ? ' is-unusable' : ''}`}
            aria-checked={c.checked}
            aria-disabled={disabled || undefined}
            tabIndex={c.key === stop ? 0 : -1}
            data-testid={optionTestId}
            data-value={c.value}
            onClick={() => {
              if (disabled || c.checked) return;
              onPick(c.key);
            }}
          >
            <span className="k-chip-label">
              {shown(c.label)}
              {c.why !== undefined && (
                <span className="k-chip-why" data-testid={whyTestId}>
                  {' — '}
                  {shown(c.why)}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

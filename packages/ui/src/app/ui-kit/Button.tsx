/**
 * L5.9: buttons — `Button` (primary, secondary, ghost, destructive, record; three sizes), `LinkButton` (the same look,
 * a link to a route: `hrefTo`), `IconButton` (an icon named by its label, optionally pressed), `Kbd` (key caps).
 * Native elements only: a `<button type="button">` (a disabled one is natively disabled, its reason in `why`, read
 * through `aria-describedby`), an `<a href>`. A destructive action is never a form's default; the record variant's dot is
 * the record symbol (drawn, not a coloured box) beside its word.
 */
import { useId } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { hrefTo } from '../route.js';
import type { Route } from '../route.js';
import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';
import { shown, visibleControls } from '../bits.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'record';
export type ButtonSize = 'sm' | 'md' | 'lg';

const cls = (variant: ButtonVariant, size: ButtonSize, extra?: string) => `k-btn k-btn-${variant} k-btn-${size}${extra ? ` ${extra}` : ''}`;

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'className' | 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** A shortcut shown after the label (key caps; the shortcut itself is bound elsewhere). */
  kbd?: string[];
  /** Working: disabled, with a moving mark (the label says what is happening: "Saving…"). */
  busy?: boolean;
  /** Record variant: a recording is on (the stop symbol, the recording tint). */
  recording?: boolean;
  /** Why it is disabled (read with the button). */
  why?: ReactNode;
  /** `submit` only inside a form whose default it is (never a destructive one). */
  submit?: boolean;
  children: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', icon, kbd, busy, recording, why, submit, disabled, children, ...rest }: ButtonProps) {
  const whyId = useId();
  const mark = variant === 'record' ? (recording ? 'stop' : 'record') : icon;
  return (
    <>
      <button
        {...rest}
        type={submit && variant !== 'destructive' ? 'submit' : 'button'}
        className={cls(variant, size, [recording ? 'is-recording' : '', busy ? 'is-busy' : ''].filter(Boolean).join(' ') || undefined)}
        disabled={disabled || busy}
        aria-describedby={why && (disabled || busy) ? whyId : rest['aria-describedby']}
      >
        {busy ? <span className="k-spinner" aria-hidden="true" /> : mark && <Icon name={mark} className={variant === 'record' ? 'k-record-mark' : undefined} />}
        <span className="k-btn-label">{shown(children)}</span>
        {kbd && <Kbd keys={kbd} />}
      </button>
      {why && (disabled || busy) && (
        <span id={whyId} className="k-why">
          {shown(why)}
        </span>
      )}
    </>
  );
}

export function LinkButton({ to, variant = 'secondary', size = 'md', icon, children, current, testId }: { to: Route; variant?: Exclude<ButtonVariant, 'destructive' | 'record'>; size?: ButtonSize; icon?: IconName; children: ReactNode; current?: boolean; testId?: string }) {
  return (
    <a href={hrefTo(to)} className={cls(variant, size)} aria-current={current ? 'page' : undefined} data-testid={testId}>
      {icon && <Icon name={icon} />}
      <span className="k-btn-label">{shown(children)}</span>
    </a>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'className' | 'children' | 'aria-label' | 'aria-pressed'> {
  icon: IconName;
  /** Its name (the accessibility tree's; the icon is hidden). */
  label: string;
  /** A toggle: pressed or not (the label stays the same: the state says it). */
  pressed?: boolean;
  size?: ButtonSize;
}

export function IconButton({ icon, label, pressed, size = 'md', ...rest }: IconButtonProps) {
  return (
    <button {...rest} type="button" className={`k-iconbtn k-iconbtn-${size}${pressed ? ' is-pressed' : ''}`} aria-label={label} aria-pressed={pressed === undefined ? undefined : pressed}>
      <Icon name={icon} />
    </button>
  );
}

/** Key caps: `['⌘', 'K']`. */
export function Kbd({ keys }: { keys: string[] }) {
  return (
    <span className="k-kbd-group">
      {keys.map((k, i) => (
        <kbd key={`${k}-${i}`} className="k-kbd">
          {visibleControls(k)}
        </kbd>
      ))}
    </span>
  );
}

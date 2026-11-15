/**
 * Buttons — `Button` (primary, secondary, ghost, destructive, record; three sizes), `LinkButton` (the same look,
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

export function LinkButton({
  to,
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  current,
  testId,
  label,
  dataRender,
  onClick,
  id,
  labelledBy,
  tabIndex,
}: {
  to: Route;
  variant?: Exclude<ButtonVariant, 'destructive' | 'record'>;
  size?: ButtonSize;
  icon?: IconName;
  children: ReactNode;
  current?: boolean;
  testId?: string;
  /** A fuller name than the visible label ("Comment frame 12 of render quote-v3"). */
  label?: string;
  /** The render a link opens (Edit's Comment: tests read it). */
  dataRender?: string;
  /** Run as it is followed (a hand-off to the screen it opens: the proposal's focus). */
  onClick?: () => void;
  /** Named by elements (its words and an agent-writable name shown elsewhere: never copied into an attribute). */
  id?: string;
  labelledBy?: string;
  /** Not a stop of a roving grid (-1). */
  tabIndex?: number;
}) {
  return (
    <a
      href={hrefTo(to)}
      id={id}
      className={cls(variant, size)}
      aria-current={current ? 'page' : undefined}
      aria-label={label}
      aria-labelledby={labelledBy}
      tabIndex={tabIndex}
      data-testid={testId}
      data-render={dataRender}
      onClick={onClick}
    >
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
        // biome-ignore lint/suspicious/noArrayIndexKey: a shortcut's key caps in order (a key may repeat): the place is part of the identity
        <kbd key={`${k}-${i}`} className="k-kbd">
          {visibleControls(k)}
        </kbd>
      ))}
    </span>
  );
}

/**
 * The title bar's search: a button that looks like a field ("Search…" and its key caps) and opens the command palette —
 * the one place to find a project, a scenario, a scene, a theme or a command. Its words are the placeholder's tone; the
 * name says what it opens.
 */
export function SearchTrigger({ placeholder, kbd, onOpen }: { placeholder: string; kbd: string[]; onOpen: () => void }) {
  return (
    <button type="button" className="k-search-trigger" aria-label={`${placeholder} (the command palette)`} aria-haspopup="dialog" onClick={onOpen}>
      <Icon name="search" />
      <span className="k-search-trigger-text">{shown(placeholder)}</span>
      <Kbd keys={kbd} />
    </button>
  );
}

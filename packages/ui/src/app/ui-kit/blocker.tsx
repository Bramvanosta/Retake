/**
 * The panes' commands (panes.tsx re-exports them): `TerminalCommands` (the command to type, and the same through node)
 * and `Blocker` (one line: what blocks, and the one action that unblocks it — a button, or Copy with a visible
 * "Copied"; `compact`, the status bar's form — its command in a popover that shows it in full beside its Copy).
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Route } from '../route.js';
import { Txt, shown } from '../bits.js';
import { Button, LinkButton } from './Button.js';
import { Icon } from './Icon.js';
import { StatusMark } from './marks.js';
import type { MarkState } from './marks.js';
import { followTrigger } from './popover.js';

/**
 * The command to type in a terminal (what a blocker or a refusal asks for) and, for a person without `retake` on
 * their PATH, the same command through node — both as text to select.
 */
export function TerminalCommands({ fix, fixNode }: { fix?: string; fixNode?: string }) {
  if (!fix) return null;
  return (
    <div className="k-commands">
      <p className="k-commands-line">
        {'In a terminal: '}
        <code className="k-commands-code k-mono" data-testid="blocker-fix">
          <Txt text={fix} />
        </code>
      </p>
      {fixNode && (
        <p className="k-commands-line k-commands-quiet">
          {'Without '}
          <code className="k-mono">retake</code>
          {' on your PATH: '}
          <code className="k-commands-code k-mono" data-testid="blocker-fix-node">
            <Txt text={fixNode} />
          </code>
        </p>
      )}
    </div>
  );
}

export type BlockerFix = { label: string; onClick: () => void } | { copy: string; label?: string } | { label: string; to: Route };

type Copied = 'copied' | 'refused' | null;

/** Copy `text`; the outcome in a word the person sees ("Copied", or why not) — never a screen-reader-only confirmation. */
function useCopy(): [Copied, (text: string) => void] {
  const [copied, setCopied] = useState<Copied>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = (text: string) => {
    const done = (v: Copied) => {
      setCopied(v);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), 4000);
    };
    if (!navigator.clipboard) return done('refused');
    navigator.clipboard.writeText(text).then(
      () => done('copied'),
      () => done('refused'),
    );
  };
  return [copied, copy];
}

function CopiedWord({ copied }: { copied: Copied }) {
  return (
    <span className="k-copied" role="status">
      {copied === 'copied' ? 'Copied' : copied === 'refused' ? 'Not copied: select the command instead' : ''}
    </span>
  );
}

/**
 * The compact blocker's command — a button that opens a small popover (`popover="auto"`: the
 * top layer, light dismiss, Escape gives the focus back) SHOWING the whole command, wrapped, beside its Copy button: what
 * is copied is what is on screen.
 */
function CommandPopover({ command, testId }: { command: string; testId?: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [copied, copy] = useCopy();
  useEffect(() => {
    const el = pop.current;
    if (!el) return;
    let unfollow: (() => void) | undefined;
    const onToggle = (e: Event) => {
      const now = (e as ToggleEvent).newState === 'open';
      setOpen(now);
      unfollow?.();
      unfollow = undefined;
      if (now && trigger.current) {
        unfollow = followTrigger(trigger.current, el);
        el.querySelector<HTMLElement>('button')?.focus();
      }
    };
    el.addEventListener('toggle', onToggle);
    return () => {
      el.removeEventListener('toggle', onToggle);
      unfollow?.();
    };
  }, []);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="k-btn k-btn-ghost k-btn-sm k-blocker-command"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
        data-testid={testId ? `${testId}-action` : undefined}
      >
        <Icon name="copy" />
        <span className="k-btn-label">Command…</span>
      </button>
      <div ref={pop} id={id} popover="auto" role="dialog" aria-label="The command to run in a terminal" className="k-popover" data-testid={testId ? `${testId}-popover` : undefined}>
        <p className="k-popover-title">In a terminal:</p>
        <Txt className="k-blocker-code k-mono" text={command} />
        <div className="k-popover-actions">
          <Button size="sm" icon="copy" data-testid={testId ? `${testId}-copy` : undefined} onClick={() => copy(command)}>
            Copy command
          </Button>
          <CopiedWord copied={copied} />
        </div>
      </div>
    </>
  );
}

/**
 * One line: what blocks (a state word and a sentence), and the one action that unblocks it. Without `word`, the
 * same line with no state mark — a command to copy that nothing waits on (Welcome's New project, Claude's set-up). The
 * command is shown in full (it wraps: what is copied is what is shown).
 */
export function Blocker({
  state = 'attention',
  word,
  children,
  fix,
  compact,
  testId,
}: {
  state?: MarkState;
  word?: string;
  children?: ReactNode;
  /** Optional only in the compact form (nothing to do here: the words alone). */
  fix?: BlockerFix;
  /** The status bar's one line — the command behind a "Command…" popover that shows it with its Copy. */
  compact?: boolean;
  testId?: string;
}) {
  const [copied, copy] = useCopy();
  const run = () => {
    if (!fix) return;
    if ('copy' in fix) copy(fix.copy);
    else if ('onClick' in fix) fix.onClick();
  };
  if (compact) {
    return (
      <span className="k-blocker is-compact" data-testid={testId}>
        <StatusMark state={state} word={<span className="k-blocker-text">{shown(word ?? '')}</span>} />
        {children !== undefined && children !== null && <span className="k-blocker-text">{shown(children)}</span>}
        {!fix ? null : 'to' in fix ? (
          <LinkButton size="sm" variant="ghost" to={fix.to}>
            {shown(fix.label)}
          </LinkButton>
        ) : 'copy' in fix ? (
          <CommandPopover command={fix.copy} {...(testId ? { testId } : {})} />
        ) : (
          <Button size="sm" variant="ghost" data-testid={testId ? `${testId}-action` : undefined} onClick={run}>
            {shown(fix.label)}
          </Button>
        )}
      </span>
    );
  }
  if (!fix) return null;
  return (
    <div className="k-blocker" data-testid={testId}>
      {word !== undefined && <StatusMark state={state} word={word} />}
      <span className="k-blocker-text">{shown(children)}</span>
      {'copy' in fix && <Txt className="k-blocker-code k-mono" text={fix.copy} />}
      {'to' in fix ? (
        <LinkButton size="sm" to={fix.to}>
          {shown(fix.label)}
        </LinkButton>
      ) : (
        <Button size="sm" icon={'copy' in fix ? 'copy' : undefined} data-testid={testId ? `${testId}-action` : undefined} onClick={run}>
          {shown('copy' in fix ? (fix.label ?? 'Copy command') : fix.label)}
        </Button>
      )}
      <CopiedWord copied={copied} />
    </div>
  );
}

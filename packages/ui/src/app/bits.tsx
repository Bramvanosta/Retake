/**
 * Small pieces shared by the screens. Every value from the server is a React text node; names, slugs, paths, URLs and
 * errors go through `Txt`: a `<bdi>` (bidirectional isolation — a right-to-left override cannot reorder the text around
 * it) whose explicit direction controls are shown as visible marks, so a name holding U+202E then "gnp.exe" never reads as "exe.png".
 * L5.12d: the legacy Badge, Notice and Loading are gone — every screen shows states with the kit (StatusMark, Tag,
 * Callout, EmptyState, Progress), always with a word: colour is never the only cue.
 */
import type { ReactNode } from 'react';

/** U+202A–U+202E and U+2066–U+2069: the controls that make text display in another order than it is stored. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

export function visibleControls(text: string): string {
  return text.replace(BIDI_CONTROLS, (c) => `[U+${c.charCodeAt(0).toString(16).toUpperCase()}]`);
}

/** A string from the server, isolated and with its direction controls made visible. */
export function Txt({
  text,
  className,
  title,
  ...rest
}: {
  text: string;
  className?: string;
  'aria-current'?: 'page';
  /** L5.10a fixes: the full text in a tooltip (controls made visible too). */
  title?: string;
}) {
  return (
    <bdi className={className} {...(title !== undefined ? { title: visibleControls(title) } : {})} {...rest}>
      {visibleControls(text)}
    </bdi>
  );
}

/**
 * L5.9 (review A-M1): what the kit shows in a slot it did not write — a label, a hint, a row, a status word. A string
 * goes through `Txt` (whoever passed it: a project name and a Studio word look the same to the kit); an element (a
 * caller's own `<Txt>`, an icon, a composition) and a number are shown as they are. A lint keeps every slot of the kit
 * on it.
 */
export function shown(node: ReactNode): ReactNode {
  return typeof node === 'string' ? <Txt text={node} /> : node;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
}

/** "3 min ago", "yesterday", or the date — from an ISO time; the exact time in a tooltip. */
export function When({ iso }: { iso: string | undefined }) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return <Txt text={iso} />;
  const s = Math.round((Date.now() - t) / 1000);
  const text =
    s < 60
      ? 'just now'
      : s < 3600
        ? `${Math.floor(s / 60)} min ago`
        : s < 86_400
          ? `${Math.floor(s / 3600)} h ago`
          : s < 172_800
            ? 'yesterday'
            : new Date(t).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <time dateTime={new Date(t).toISOString()} title={new Date(t).toLocaleString('en')}>
      {text}
    </time>
  );
}

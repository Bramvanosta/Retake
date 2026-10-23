/**
 * Small pieces shared by the screens. Every value from the server is a React text node; names, slugs, paths, URLs and
 * errors go through `Txt`: a `<bdi>` (bidirectional isolation — a right-to-left override cannot reorder the text around
 * it) whose explicit direction controls are shown as visible marks, so a name holding U+202E then "gnp.exe" never reads as "exe.png". Badges
 * always carry a word — colour is never the only cue.
 */
import type { ReactNode } from 'react';
import type { EnvironmentView } from '@demo-studio/engine';

/** U+202A–U+202E and U+2066–U+2069: the controls that make text display in another order than it is stored. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

export function visibleControls(text: string): string {
  return text.replace(BIDI_CONTROLS, (c) => `[U+${c.charCodeAt(0).toString(16).toUpperCase()}]`);
}

/** A string from the server, isolated and with its direction controls made visible. */
export function Txt({ text, className, ...rest }: { text: string; className?: string; 'aria-current'?: 'page' }) {
  return (
    <bdi className={className} {...rest}>
      {visibleControls(text)}
    </bdi>
  );
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
    s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86_400 ? `${Math.floor(s / 3600)} h ago` : s < 172_800 ? 'yesterday' : new Date(t).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <time dateTime={new Date(t).toISOString()} title={new Date(t).toLocaleString('en')}>
      {text}
    </time>
  );
}

export type BadgeTone = 'neutral' | 'danger' | 'warning' | 'info' | 'success';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** production / read-only / sandbox, in words. */
export function EnvFlags({ env }: { env: Pick<EnvironmentView, 'production' | 'access' | 'sandbox'> }) {
  return (
    <>
      {env.production && <Badge tone="danger">production</Badge>}
      {env.access === 'read-only' && <Badge tone="warning">read-only</Badge>}
      {env.sandbox && <Badge tone="info">sandbox</Badge>}
    </>
  );
}

const RUN_TONE: Record<string, BadgeTone> = { succeeded: 'success', failed: 'danger', interrupted: 'danger', cancelled: 'warning', running: 'info', queued: 'info' };

export function RunState({ status }: { status: string }) {
  return <Badge tone={RUN_TONE[status] ?? 'neutral'}>{status}</Badge>;
}

export function Notice({ tone, title, children, role = 'status' }: { tone: 'info' | 'warning' | 'danger'; title?: string; children?: ReactNode; role?: 'status' | 'alert' | 'note' }) {
  return (
    <div className={`notice notice-${tone}`} role={role}>
      {title && <p className="notice-title">{title}</p>}
      {children}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="muted" role="status">
      Loading {what}…
    </p>
  );
}

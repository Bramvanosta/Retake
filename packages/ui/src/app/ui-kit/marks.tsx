/**
 * L5.9: status and time — `StatusMark` (a shape AND a word, always: ● ok, ◐ running, ○ idle, ◌ waiting, ◆ warning,
 * ▲ attention, ✕ failed, ● recording; the shape is hidden from the accessibility tree, the word is visible text — the
 * checker's colour-only rule wants a state word there), `Timecode` (mono, tabular figures; the spoken form in hidden
 * text, not an `aria-label` on a span), `Progress` (`role="progressbar"`, determinate or not; no motion when the system
 * asks for less).
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import { shown, visibleControls } from '../bits.js';

export type MarkState = 'ok' | 'running' | 'waiting' | 'idle' | 'warn' | 'attention' | 'fail' | 'recording';
export const MARK_STATES: MarkState[] = ['ok', 'running', 'waiting', 'idle', 'warn', 'attention', 'fail', 'recording'];

function Shape({ state }: { state: MarkState }) {
  if (state === 'attention') {
    return (
      <svg className="k-mark-svg k-mark-attention" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
        <path d="M5 1.2L9.2 8.8H.8z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    );
  }
  if (state === 'fail') {
    return (
      <svg className="k-mark-svg k-mark-fail" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
        <path d="M2 2l6 6M8 2L2 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return <span className={`k-mark-shape k-mark-${state}`} aria-hidden="true" />;
}

/** A state: its shape and its word (`word` must say the state: "Ready", "Running", "Failed"…). */
export function StatusMark({ state, word }: { state: MarkState; word: ReactNode }) {
  return (
    <span className="k-mark" data-state={state}>
      <Shape state={state} />
      <span className="k-mark-word">{shown(word)}</span>
    </span>
  );
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `49.04` → `00:00:49.0` (tenths). */
export function formatTimecode(seconds: number): string {
  const t = Math.max(0, Math.round(seconds * 10));
  const h = Math.floor(t / 36000);
  const m = Math.floor((t % 36000) / 600);
  const s = Math.floor((t % 600) / 10);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${t % 10}`;
}

/** Spoken: "49.0 seconds" / "1 minute 12.5 seconds". */
export function spokenTimecode(seconds: number): string {
  const t = Math.max(0, Math.round(seconds * 10)) / 10;
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(1);
  return m > 0 ? `${m} minute${m > 1 ? 's' : ''} ${s} seconds` : `${s} seconds`;
}

export function Timecode({ seconds, total, frame }: { seconds: number; total?: number; frame?: number }) {
  const spoken = `${spokenTimecode(seconds)}${total !== undefined ? ` of ${spokenTimecode(total)}` : ''}${frame !== undefined ? `, frame ${frame}` : ''}`;
  return (
    <span className="k-timecode">
      <span className="k-mono" aria-hidden="true">
        {formatTimecode(seconds)}
        {total !== undefined && <span className="k-timecode-total"> / {formatTimecode(total)}</span>}
        {frame !== undefined && <span className="k-timecode-total"> · f{shown(frame)}</span>}
      </span>
      <span className="k-sr">{shown(spoken)}</span>
    </span>
  );
}

/** A progress bar with its label; no `value`: indeterminate (nothing to count yet; no `aria-busy`: the page is not loading). */
export function Progress({ label, value, max = 100, valueText }: { label: ReactNode; value?: number; max?: number; valueText?: string }) {
  const id = useId();
  const pct = value === undefined ? undefined : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="k-progress">
      <span id={id} className="k-progress-label">
        {shown(label)}
        {valueText && <span className="k-progress-value"> {shown(valueText)}</span>}
      </span>
      <div
        className={pct === undefined ? 'k-progress-track is-indeterminate' : 'k-progress-track'}
        role="progressbar"
        aria-labelledby={id}
        aria-valuemin={pct === undefined ? undefined : 0}
        aria-valuemax={pct === undefined ? undefined : max}
        aria-valuenow={pct === undefined ? undefined : value}
        aria-valuetext={valueText === undefined ? undefined : visibleControls(valueText)}
      >
        <span className="k-progress-fill" style={pct === undefined ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  );
}

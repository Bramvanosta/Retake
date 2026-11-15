/**
 * The live screen's run state (ShootLive.tsx): the run's state in a word and its mark, the steps it executes, the
 * words of hooks and of an ended run, a local clock.
 */
import type { OutlineStep, RunLiveState, RunStatusLite } from './run-live.js';
import { RUN_STATUS_WORDS } from '../words/scenario-words.js';
import type { MarkState } from '../ui-kit/index.js';

export const HOOK_WORDS: Record<string, [string, MarkState]> = { start: ['running', 'running'], ok: ['ok', 'ok'], failed: ['failed', 'fail'], skipped: ['skipped', 'idle'] };
/** "The run …" once it ended. */
const ENDED_WORDS: Record<string, string> = { succeeded: 'succeeded', failed: 'failed', cancelled: 'was stopped', interrupted: 'was interrupted (its worker stopped)' };
export const endedWords = (status: string) => `The run ${ENDED_WORDS[status] ?? RUN_STATUS_WORDS[status] ?? status}`;
/** A run's state in a word on this screen: a stopped run says "stopped" (one word for it across Shoot). */
export const stateWord = (w: string) => RUN_STATUS_WORDS[w] ?? w;
export const PHASE_WORDS: Record<string, string> = { setup: 'Setup hook', teardown: 'Teardown hook', rollback: 'Rollback', step: 'Hook' };

/** The run's state in a word, from the stream (or run_status while the stream is refused). */
export function runState(s: RunLiveState, fb: RunStatusLite | null): { word: string; finished: boolean } {
  if (s.ended || s.end) return { word: s.end?.status ?? s.ended?.status ?? 'ended', finished: true };
  if (s.paused) return { word: 'paused', finished: false };
  if (s.job?.cancel_requested) return { word: 'stopping', finished: false };
  if (s.job && s.job.state !== 'running' && s.job.state !== 'queued') return { word: s.job.state, finished: true };
  if (s.start) return { word: 'running', finished: false };
  if (s.job?.state === 'queued') return { word: 'queued', finished: false };
  if (fb) return { word: fb.paused ? 'paused' : fb.job?.cancel_requested_at && !fb.finished ? 'stopping' : fb.status, finished: fb.finished };
  return { word: s.hello ? 'starting' : 'connecting', finished: false };
}

export const STATE_MARK: Record<string, MarkState> = {
  running: 'running',
  queued: 'waiting',
  starting: 'waiting',
  connecting: 'waiting',
  paused: 'warn',
  stopping: 'warn',
  succeeded: 'ok',
  failed: 'fail',
  cancelled: 'warn',
  interrupted: 'fail',
};

/** The steps the run executes: its outline, else (an older run with none) the steps it reported, in order. */
export function stepRows(s: RunLiveState): OutlineStep[] {
  if (s.outline) return s.outline;
  return Object.keys(s.steps).map((k) => {
    const i = k.lastIndexOf('.');
    return { scene: k.slice(0, i), step: Number(k.slice(i + 1)), action: '', desc: '' };
  });
}

/** "14:03" local time, from an ISO time. */
export function clock(iso: string, withSeconds = false): string {
  const t = new Date(iso);
  return Number.isFinite(t.getTime()) ? t.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) }) : '';
}

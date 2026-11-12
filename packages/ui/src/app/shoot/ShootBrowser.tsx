/**
 * L5.11a: Shoot's browser (R4-ShootPrep / R4-ShootLive) — Prepare (the scenario's preflight), its Runs (newest first,
 * the one queued or running on top: its kind in words, when, its outcome as a shape and words; each opens its live
 * route, which replays a finished run's outcome, steps and log) and Record a scenario. The runs are the status bar's
 * `scenario_actions` read (shoot-data.ts: one entry per scenario and location).
 * L5.11b (R4-Record): on the Record routes, the Recordings group — the project's recent recordings (record_options'
 * `recent`), the open one first with its live state and actions from the screen's own view; each opens its route — and
 * Prepare / Runs only while a scenario is in context. L5.11b fixes (review B-L6): a recording's line says its location
 * and step count again, and a saved one links its scenario (a row under it).
 */
import type { RecordListItem, RecordState, ScenarioRunChoice } from '@retake/engine';
import { Txt, plural } from '../bits.js';
import { STATE_WORDS, startedByWords } from '../words/record-words.js';
import { RUN_STATUS_WORDS } from '../words/scenario-words.js';
import { modeWord } from '../words/shoot-words.js';
import { SourceList, StatusMark } from '../ui-kit/index.js';
import type { MarkState, SourceGroup, SourceItem } from '../ui-kit/index.js';

const MARK: Record<string, MarkState> = { succeeded: 'ok', failed: 'fail', interrupted: 'fail', cancelled: 'warn', running: 'running', queued: 'waiting' };

/** "08:38" today, "yesterday", else the date. */
export function runWhen(iso: string | undefined): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return '';
  const now = new Date();
  if (t.toDateString() === now.toDateString()) return t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (t.toDateString() === y.toDateString()) return 'yesterday';
  return t.toLocaleDateString('en', { day: 'numeric', month: 'short' });
}

/** A run's outcome in words: "Succeeded · 25 of 25 steps", "Failed at step 3 of proposal", "Running". */
export function runOutcome(r: ScenarioRunChoice): string {
  const status = RUN_STATUS_WORDS[r.status] ?? 'unknown';
  const cap = status.charAt(0).toUpperCase() + status.slice(1);
  // A run going: its state only (the list is not re-read per step; the live screen and the status bar count its steps).
  if (r.status === 'running' || r.status === 'queued') return cap;
  if (r.partial && r.status !== 'cancelled') return r.partial.charAt(0).toUpperCase() + r.partial.slice(1);
  if (r.status === 'cancelled') return `Stopped at step ${Math.min(r.steps_done + 1, Math.max(1, r.steps_total))}`;
  return `${cap} · ${r.steps_done} of ${r.steps_total} steps`;
}

/** A recording's state as a mark (its word always beside it). */
export const RECORD_MARK: Record<RecordState, MarkState> = {
  queued: 'waiting',
  preflight: 'recording',
  recording: 'recording',
  draft: 'running',
  check: 'running',
  done: 'ok',
  interrupted: 'warn',
  tampered: 'fail',
  nothing_recorded: 'idle',
  failed: 'fail',
  cancelled: 'warn',
  discarded: 'idle',
  missing: 'idle',
};

const FINAL_RECORD = new Set<RecordState>(['done', 'interrupted', 'nothing_recorded']);

/** A recording's state beside its mark: record-words' words, a state word first where they have none (the colour-only rule). */
export function recordStateWord(state: RecordState): string {
  if (state === 'preflight') return 'Pending: opening the window';
  if (state === 'tampered') return 'Invalid: cannot be verified';
  if (state === 'missing') return 'Missing: not found';
  const w = STATE_WORDS[state]?.[0] ?? 'unknown';
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/**
 * A recording in the browser's words: "Recording · 7 actions · local", "Recorded · 12 steps · local · not saved",
 * "Recorded · 12 steps · staging · saved as quote-v2".
 */
export function recordingWords(r: Pick<RecordListItem, 'state' | 'actions' | 'saved' | 'studio' | 'started_by'> & Partial<Pick<RecordListItem, 'env' | 'steps'>>): string {
  const parts = [recordStateWord(r.state)];
  if (r.actions !== null && (r.state === 'recording' || r.state === 'draft' || r.state === 'check')) parts.push(plural(r.actions, 'action'));
  else if (typeof r.steps === 'number') parts.push(plural(r.steps, 'step'));
  if (r.env) parts.push(r.env);
  if (r.saved) parts.push(`saved as ${r.saved.name}`);
  else if (r.studio && FINAL_RECORD.has(r.state)) parts.push('not saved');
  if (r.started_by && r.started_by !== 'ui') parts.push(`by ${startedByWords(r.started_by)}`);
  return parts.join(' · ');
}

export interface ShootRecordings {
  /** record_options' `recent` (null: not read yet). */
  items: RecordListItem[] | null;
  /** The recording on screen (null: the start form). */
  current: string | null;
  /** The open one as the screen's own view tells it (live state and actions, ahead of the list). */
  live?: Pick<RecordListItem, 'rec_id' | 'state' | 'actions'> | null;
}

export function ShootBrowser({ slug, name, runs, current, recordings }: { slug: string; name: string | null; runs: ScenarioRunChoice[] | null; current: string | null; recordings?: ShootRecordings }) {
  const going = (runs ?? []).filter((r) => r.status === 'queued' || r.status === 'running');
  const done = (runs ?? []).filter((r) => r.status !== 'queued' && r.status !== 'running');
  const row = (r: ScenarioRunChoice): SourceItem => ({
    key: r.id,
    to: { name: 'run', slug, scenario: name ?? '', run: r.id },
    label: <Txt text={`${modeWord(r.mode)} · ${r.status === 'running' || r.status === 'queued' ? 'now' : runWhen(r.finished_at ?? r.started_at)}`} />,
    current: r.id === current,
    detail: <StatusMark state={MARK[r.status] ?? 'idle'} word={<Txt text={runOutcome(r)} />} />,
    testId: 'shoot-run',
  });
  const recRow = (r: RecordListItem): SourceItem => {
    const live = recordings?.live && recordings.live.rec_id === r.rec_id ? { ...r, ...recordings.live } : r;
    const going = live.state === 'queued' || live.state === 'preflight' || live.state === 'recording' || live.state === 'draft' || live.state === 'check';
    const when = going ? 'now' : runWhen(live.started_at ?? undefined);
    return {
      key: r.rec_id,
      to: { name: 'record', slug, rec: r.rec_id },
      label: <Txt text={r.name ?? r.rec_id} />,
      ...(when ? { value: when } : {}),
      current: recordings?.current === r.rec_id,
      detail: <StatusMark state={RECORD_MARK[live.state] ?? 'idle'} word={<Txt text={recordingWords(live)} />} />,
      testId: 'record-recent-item',
      ...(r.saved ? { children: [{ key: `${r.rec_id}-saved`, to: { name: 'scenario' as const, slug, scenario: r.saved.name, tab: 'blocks' as const }, label: <Txt text={`Open ${r.saved.name}`} />, current: false, quiet: true, testId: 'record-recent-saved' }], childrenLabel: 'Its scenario' } : {}),
    };
  };
  // Newest first (record_options' order): the one open in the workspace is the first while it goes.
  const recs = recordings?.items ?? [];
  const onRecord = recordings !== undefined;
  const groups: SourceGroup[] = [];
  if (name !== null) {
    groups.push({ key: 'prepare', items: [{ key: 'prepare', to: { name: 'run', slug, scenario: name }, label: 'Prepare', current: !onRecord && current === null, icon: 'check', testId: 'shoot-prepare' }] });
    groups.push({ key: 'runs', heading: 'Runs', label: 'Runs', items: runs === null ? [] : [...going, ...done].map(row) });
  }
  // (No recording yet: no empty heading — Record a scenario follows.)
  if (onRecord && recs.length > 0) groups.push({ key: 'recordings', heading: 'Recordings', label: 'Recordings', items: recs.map(recRow) });
  groups.push({ key: 'record', items: [{ key: 'record', to: { name: 'record', slug }, label: 'Record a scenario', current: onRecord && recordings.current === null, icon: 'record' }] });
  return <SourceList label="Shoot" groups={groups} />;
}

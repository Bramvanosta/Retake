/**
 * L5.11a: Shoot's browser (R4-ShootPrep / R4-ShootLive) — Prepare (the scenario's preflight), its Runs (newest first,
 * the one queued or running on top: its kind in words, when, its outcome as a shape and words; each opens its live
 * route, which replays a finished run's outcome, steps and log) and Record a scenario. The runs are the status bar's
 * `scenario_actions` read (shoot-data.ts: one entry per scenario and location). Recordings come with L5.11b.
 */
import type { ScenarioRunChoice } from '@demo-studio/engine';
import { Txt } from './bits.js';
import { RUN_STATUS_WORDS } from './scenario-words.js';
import { modeWord } from './shoot-words.js';
import { SourceList, StatusMark } from './ui-kit/index.js';
import type { MarkState, SourceItem } from './ui-kit/index.js';

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

export function ShootBrowser({ slug, name, runs, current }: { slug: string; name: string; runs: ScenarioRunChoice[] | null; current: string | null }) {
  const going = (runs ?? []).filter((r) => r.status === 'queued' || r.status === 'running');
  const done = (runs ?? []).filter((r) => r.status !== 'queued' && r.status !== 'running');
  const row = (r: ScenarioRunChoice): SourceItem => ({
    key: r.id,
    to: { name: 'run', slug, scenario: name, run: r.id },
    label: <Txt text={`${modeWord(r.mode)} · ${r.status === 'running' || r.status === 'queued' ? 'now' : runWhen(r.finished_at ?? r.started_at)}`} />,
    current: r.id === current,
    detail: <StatusMark state={MARK[r.status] ?? 'idle'} word={<Txt text={runOutcome(r)} />} />,
    testId: 'shoot-run',
  });
  return (
    <SourceList
      label="Shoot"
      groups={[
        { key: 'prepare', items: [{ key: 'prepare', to: { name: 'run', slug, scenario: name }, label: 'Prepare', current: current === null, icon: 'check', testId: 'shoot-prepare' }] },
        {
          key: 'runs',
          heading: 'Runs',
          label: 'Runs',
          items: runs === null ? [] : [...going, ...done].map(row),
        },
        { key: 'record', items: [{ key: 'record', to: { name: 'record', slug }, label: 'Record a scenario', current: false, icon: 'record' }] },
      ]}
    />
  );
}

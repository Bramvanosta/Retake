/**
 * The live screen's arrival after a start (its title takes the focus once) and a running run's progress as
 * `run_status` tells it (the status bar's line, the Scenario screen's Running callout). Part of the shoot data
 * (./shoot-data.ts re-exports it).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { runStatus } from '../data/shoot.js';

/** A run's progress as `run_status` tells it (the status bar's line, the Scenario screen's Running callout). */
export interface LiveRun {
  id: string;
  mode: string;
  status: string;
  steps_done: number;
  steps_total: number;
  current?: { scene: string; step: number; action: string };
  paused?: { scene: string; step: number };
  stopping?: boolean;
  pausing?: boolean;
  finished: boolean;
}

// ── the live screen's arrival after a start ───────────────────────────────────────────────────────────────────────────

let liveFocus: string | null = null;
/** A start from this tab opens run `id`'s live screen: its title takes the focus there (never <body>). */
export function focusLiveOnArrival(id: string): void {
  liveFocus = id;
}
/** True once for the run a start opened (its live screen focuses its title). */
export function takeLiveFocus(id: string): boolean {
  if (liveFocus !== id) return false;
  liveFocus = null;
  return true;
}

// ── a running run's progress (run_status) ─────────────────────────────────────────────────────────────────────────────

/** run_status's answer, as far as the progress line reads it. */
interface RunStatusAnswer {
  id: string;
  mode: string;
  status: string;
  steps_done: number;
  steps_total: number;
  current?: { scene: string; step: number; action: string };
  paused?: { scene: string; step: number };
  finished: boolean;
  job?: { pause_requested_at?: string; cancel_requested_at?: string };
}

export function liveOf(d: RunStatusAnswer): LiveRun {
  return {
    id: d.id,
    mode: d.mode,
    status: d.status,
    steps_done: d.steps_done,
    steps_total: d.steps_total,
    ...(d.current ? { current: d.current } : {}),
    ...(d.paused ? { paused: { scene: d.paused.scene, step: d.paused.step } } : {}),
    ...(d.job?.cancel_requested_at ? { stopping: true } : {}),
    ...(d.job?.pause_requested_at && !d.paused ? { pausing: true } : {}),
    finished: d.finished,
  };
}

/**
 * At most one `run_status` read at a time for the run of `slug` (one more after it when progress came meanwhile): at
 * once, on its progress events and on job changes. When the run is finished — interrupted included — `onEnded` runs
 * (once per run). Null id: nothing read.
 */
export function useRunProgress(slug: string | null, runId: string | null, onEnded?: () => void): [LiveRun | null, (runs: string[]) => void] {
  const [live, setLive] = useState<LiveRun | null>(null);
  const busy = useRef(false);
  const again = useRef<string | null>(null);
  const endedFor = useRef<string | null>(null);
  const runningRef = useRef(runId);
  runningRef.current = runId;
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;
  const read = useCallback(
    (id: string) => {
      if (slug === null) return;
      if (busy.current) {
        again.current = id;
        return;
      }
      busy.current = true;
      runStatus({ project: slug, run_id: id })
        .then(
          (d) => {
            setLive(liveOf(d));
            if (d.finished && d.id === runningRef.current && endedFor.current !== d.id) {
              endedFor.current = d.id;
              endedRef.current?.();
            }
          },
          () => undefined,
        )
        .finally(() => {
          busy.current = false;
          const next = again.current;
          again.current = null;
          if (next) read(next);
        });
    },
    [slug],
  );
  useEffect(() => {
    if (runId) read(runId);
    else setLive(null);
  }, [runId, read]);
  const progress = useCallback(
    (runs: string[]) => {
      // [] (a jobs event): the running run, if any — its job may have ended without a word from its run.json.
      const id = runId && (runs.length === 0 || runs.includes(runId)) ? runId : runs[0];
      if (id) read(id);
    },
    [runId, read],
  );
  return [live, progress];
}

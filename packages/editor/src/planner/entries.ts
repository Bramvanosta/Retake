/**
 * Steps of `planEdit`: the entries of the edit (scenes, cards, interstitials in scenario order; what each scene shows
 * of the capture, joined to the previous one when contiguous on the same page), then the runs of contiguous clips and
 * their time maps (idle trimmed, waits sped up, page loads, hooks and freezes cut).
 */
import { COMPONENT_KINDS, TUTORIAL_FEATURES } from '@retake/core';
import { DEFAULT_IDLE_THRESHOLD_S, QUICK_RUN_SPEED, WAIT_SPEED, hookSpans, loadsBesideOtherPages, planRunTiming, quickRunSpans, waitingSpans } from '../timing.js';
import type { RunTiming } from '../timing.js';
import { secs } from '../util.js';
import { pageAt } from './pages.js';
import { CONTIGUOUS_GAP_S, LOAD_START_SLACK_S } from './rules.js';
import type { ClipEntry, Entry, PlanScope, RunOf } from './scope.js';

/** The scenes, cards and interstitials of the edit, in scenario order (skipped and off-camera scenes left out). */
export function planEntries(s: PlanScope): Entry[] {
  const { timeline, cap, srcFps, srcFrameCount, trackSources, warnings, notes, ov, overrideRefs } = s;
  const entries: Entry[] = [];
  const knownIds = new Set<string>(['intro', 'outro', ...TUTORIAL_FEATURES.map((f) => `tutorial-${f}`)]);
  for (const scene of timeline.scenes) {
    knownIds.add(scene.id);
    if (scene.status === 'skipped') {
      notes.add(`scene "${scene.id}" was skipped by the run: not in the edit`);
      continue;
    }
    if (scene.kind === 'card' || scene.kind === 'interstitial') {
      entries.push(scene.kind === 'card' ? { type: 'card', scene } : { type: 'interstitial', scene });
      continue;
    }
    if (scene.offscreen) {
      notes.add(`scene "${scene.id}" was played off camera (offscreen: true): not in the edit`);
      continue;
    }
    if (scene.status === 'failed' || scene.status === 'partial') warnings.add(`scene "${scene.id}" ${scene.status === 'failed' ? 'failed' : 'is partial'} in the run: its clip shows what was captured`);
    // Notification events (step -1, L2.9) belong to no step: they are artefacts, not provenance.
    const events = timeline.events
      .filter((e) => e.scene === scene.id && e.scene_index === scene.index && e.action !== 'notification')
      .sort((a, b) => a.t_start - b.t_start || a.step - b.step);
    const open = events.find((e) => e.action === 'scene_open');
    const still = events.find((e) => e.action === 'scene_still');
    const s0 = still ? still.t_start : open ? open.t_end : scene.t_start;
    const s1 = Math.min(scene.t_end, cap.duration);
    let A = Math.ceil(s0 * srcFps - 1e-6);
    const B = Math.min(srcFrameCount, Math.ceil(s1 * srcFps - 1e-6));
    const prev = entries[entries.length - 1];
    let joined = false;
    const pages = scene.pages && scene.pages.length > 0 ? scene.pages : undefined;
    if (pages) {
      const missing = pages.filter((pg) => !trackSources[pg.track]);
      if (missing.length > 0) warnings.add(`scene "${scene.id}": no track for page${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m.id}"`).join(', ')} in the run: shown from the main capture`);
    }
    if (prev && prev.type === 'clip' && !open) {
      const gap = s0 - prev.s1;
      // Single-page scenes: the same page of the main capture; multi-page scenes: the same pages (their tracks).
      const samePages = pages || prev.pages ? (pages ?? []).map((p) => p.id).join('|') === (prev.pages ?? []).map((p) => p.id).join('|') : undefined;
      const pagePrev = pageAt(timeline, Math.max(prev.s0, prev.s1 - 1e-3))?.id ?? prev.scene.page;
      const pageNext = pageAt(timeline, s0)?.id ?? scene.page;
      if (gap <= CONTIGUOUS_GAP_S && gap >= -CONTIGUOUS_GAP_S && (samePages ?? pagePrev === pageNext)) {
        joined = true;
        A = prev.B;
        notes.add(`"${scene.id}" continues "${prev.scene.id}" on the same page: joined without a transition (the camera continues)`);
        if (scene.transition && scene.transition !== 'cut') notes.add(`"${scene.id}": transition "${scene.transition}" not used — contiguous same-page scenes are joined`);
      }
    }
    if (B <= A) {
      warnings.add(`scene "${scene.id}" has nothing to show (capture ${secs(s0)}–${secs(s1)}): left out`);
      continue;
    }
    let speed = scene.speed ?? 1;
    const ovSpeed = ov.speeds?.[scene.id];
    if (ovSpeed !== undefined) {
      if (ovSpeed > 0 && ovSpeed <= 16) {
        speed = ovSpeed;
        notes.add(`scene "${scene.id}": speed ${ovSpeed}× (overrides.speeds)`);
      } else warnings.add(`overrides.speeds["${scene.id}"] = ${ovSpeed} ignored: use a speed in (0, 16]`);
    }
    if (!(speed > 0)) speed = 1;
    if (open) notes.add(`"${scene.id}": page load ${secs(open.t_start)}–${secs(s0)} of the capture is not shown`);
    entries.push({ type: 'clip', scene, events, s0, s1, A, B, joined, speed, ...(pages && pages.every((pg) => trackSources[pg.track]) ? { pages } : {}) });
  }
  for (const id of Object.keys(ov.speeds ?? {})) {
    if (!timeline.scenes.some((s) => s.id === id && s.kind === 'scene')) warnings.add(`overrides.speeds["${id}"]: no captured scene "${id}" in this run`);
  }
  for (const key of Object.keys(overrideRefs)) {
    if (!(COMPONENT_KINDS as readonly string[]).includes(key) && !knownIds.has(key)) {
      warnings.add(`overrides.components["${key}"]: neither a component kind nor a segment id of this video`);
    }
  }
  if (!entries.some((e) => e.type === 'clip')) warnings.add('no captured scene to show: the video has only cards');
  return entries;
}

/** The runs of contiguous clips (a joined clip continues its run) and each run's time map, with notes on what changed. */
export function planRuns(s: PlanScope, entries: Entry[]): { runs: ClipEntry[][]; runOf: RunOf } {
  const { timeline, ov, warnings, notes, srcFps, outFps } = s;
  const trimIdle = ov.trim_idle !== false;
  let idleThreshold = DEFAULT_IDLE_THRESHOLD_S;
  if (ov.idle_threshold !== undefined) {
    if (ov.idle_threshold > 0) idleThreshold = ov.idle_threshold;
    else warnings.add(`overrides.idle_threshold ${ov.idle_threshold} ignored: use a number of seconds > 0`);
  }
  if (!trimIdle) notes.add('idle trimming disabled (overrides.trim_idle = false)');
  const runs: ClipEntry[][] = [];
  for (const e of entries) {
    if (e.type !== 'clip') continue;
    if (e.joined && runs.length > 0) runs[runs.length - 1].push(e);
    else runs.push([e]);
  }
  const runOf: RunOf = new Map();
  // Page loads the capture held (R-ISS-08): the main capture's, and each page track's.
  const heldLoads = [...(timeline.loading ?? []), ...(timeline.tracks ?? []).flatMap((tr) => tr.loading ?? [])];
  // Page changes (URL segments of the main capture and of every page track): a wait right after one shows loading. A
  // change inside a held load shows when the load ends (the painted page): the loading the edit keeps starts there. The
  // segment comes from the page's own navigation event, the load from the recorder's event of the same commit: a few
  // ms apart, either way.
  const pageChanges = [...timeline.pages, ...(timeline.tracks ?? []).flatMap((tr) => tr.pages)]
    .map((pg) => heldLoads.find((l) => (l.page === undefined || l.page === pg.id) && pg.t_start >= l.t_start - LOAD_START_SLACK_S && pg.t_start < l.t_end)?.t_end ?? pg.t_start)
    .sort((a, b) => a - b);
  /** Some of a capture span plays faster than its clip's own speed in a run's time map (a span a mark or a hold covers does not). */
  const sped = (run: RunTiming, w: { t_start: number; t_end: number }, clips: ClipEntry[]) =>
    run.pieces.some((p) => !p.cut && p.p1 > w.t_start * srcFps + 1e-6 && p.p0 < w.t_end * srcFps - 1e-6 && p.v > (clips[p.clip]?.speed ?? 1) + 1e-9);
  for (const runEntries of runs) {
    const waits = trimIdle ? runEntries.flatMap((e) => waitingSpans(e.events, pageChanges)) : [];
    const quick = trimIdle ? runEntries.flatMap((e) => quickRunSpans(e.events)) : [];
    // A multi-page run shows its pages' tracks: their held loads, not where another page acts; else the main capture's.
    const runPages = runEntries[0].pages;
    const loading = runPages
      ? loadsBesideOtherPages(
          runPages.flatMap((pg) => (timeline.tracks?.find((tr) => tr.id === pg.track)?.loading ?? []).map((l) => ({ ...l, page: pg.id }))),
          runEntries.flatMap((e) => e.events),
        )
      : (timeline.loading ?? []);
    const run = planRunTiming({
      clips: runEntries.map((e) => ({ scene: e.scene.id, A: e.A, B: e.B, baseSpeed: e.speed, events: e.events })),
      srcFps,
      outFps,
      idle: timeline.idle,
      trimIdle,
      idleThresholdS: idleThreshold,
      waits,
      quick,
      loading,
      // L5.7: the main capture's freezes and waits (a multi-page run shows its pages' tracks: none of them recorded).
      ...(runPages ? {} : { frozen: timeline.stalls ?? [], busy: timeline.busy ?? [] }),
      offcamera: runEntries.flatMap((e) => hookSpans(e.events)),
    });
    for (const w of waits) {
      if (!sped(run, w, runEntries)) continue;
      const sc = runEntries.find((e) => w.t_start >= e.s0 - 1e-6 && w.t_start < e.s1)?.scene.id ?? runEntries[0].scene.id;
      notes.add(`"${sc}": waiting ${secs(w.t_start)}–${secs(w.t_end)} of the capture played at up to ${WAIT_SPEED}× (a loading state; marks and holds stay at 1×)`);
    }
    for (const w of quick) {
      if (!sped(run, w, runEntries)) continue;
      const sc = runEntries.find((e) => w.t_start >= e.s0 - 1e-6 && w.t_start < e.s1)?.scene.id ?? runEntries[0].scene.id;
      notes.add(`"${sc}": month run ${secs(w.t_start)}–${secs(w.t_end)} of the capture played at up to ${QUICK_RUN_SPEED}×`);
    }
    runEntries.forEach((e, index) => runOf.set(e, { run, index, entries: runEntries }));
    for (const c of run.cuts) {
      if (c.reason === 'loading') {
        notes.add(`"${runEntries[c.clip].scene.id}": page load ${secs(c.a / srcFps)}–${secs(c.b / srcFps)} of the capture cut (the capture held the previous frame until the new page painted)`);
        continue;
      }
      if (c.reason === 'hook') {
        const ev = runEntries[c.clip].events.find((e) => e.action === 'hook' && e.t_start * srcFps <= c.a + 1e-6 && c.b <= e.t_end * srcFps + 1e-6);
        notes.add(`"${runEntries[c.clip].scene.id}": hook step${ev ? ` ${ev.scene}.${ev.step}` : ''} ${secs(c.a / srcFps)}–${secs(c.b / srcFps)} of the capture cut (it ran off camera)`);
        continue;
      }
      if (c.reason === 'frozen') {
        notes.add(`"${runEntries[c.clip].scene.id}": capture freeze ${secs(c.a / srcFps)}–${secs(c.b / srcFps)} cut (no new frame came while the cursor moved or a click ripple played)`);
        continue;
      }
      if (c.reason === 'busy') {
        const kept = (c.idle.b - c.idle.a - (c.b - c.a)) / srcFps;
        notes.add(`"${runEntries[c.clip].scene.id}": wait after a click ${secs((c.idle.b - c.idle.a) / srcFps)} at ${secs(c.idle.a / srcFps)} of the capture shortened to ${secs(kept)} (a skeleton, a spinner or a blank panel)`);
        continue;
      }
      const kept = (c.idle.b - c.idle.a - (c.b - c.a)) / srcFps;
      notes.add(`"${runEntries[c.clip].scene.id}": idle ${secs((c.idle.b - c.idle.a) / srcFps)} at ${secs(c.idle.a / srcFps)} of the capture shortened to ${secs(kept)}`);
    }
  }
  return { runs, runOf };
}

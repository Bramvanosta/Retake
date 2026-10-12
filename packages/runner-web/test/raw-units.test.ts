/**
 * L2.13 raw export, pure parts: loading cuts, the clip plan on real (frozen) timelines, markers and the interchange
 * files (FCPXML 1.10, CMX 3600, OTIO, CSV / JSON), the cursor model (press scale, ripples, icons, clicks) and the
 * timing constants shared with the kit's cursor look.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Timeline, TimelineEvent } from '@demo-studio/core';
import {
  CURSOR_LOOK,
  RAW_CUT,
  approximateEffects,
  clicksCsv,
  clipClicks,
  clipFrameAt,
  cursorCsv,
  cursorFrames,
  cursorJson,
  easeOut,
  fcpTime,
  gridFrameOf,
  loadingCuts,
  localFrameInterval,
  markersCsv,
  markersJson,
  planRawExport,
  pressScaleAt,
  rawMarkers,
  rawSettings,
  scaleStep,
  timecode,
  writeEdl,
  writeFcpxml,
  writeOtio,
} from '../src/index.js';
import { kitSource } from '../src/kit/source.js';
import { cfrSchedule } from '../src/encode.js';

const fixture = (name: string): Timeline =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../editor/test/fixtures/${name}.timeline.json`, import.meta.url)), 'utf8')) as Timeline;

const ev = (o: Partial<TimelineEvent> & Pick<TimelineEvent, 'step' | 'action' | 't_start' | 't_end'>): TimelineEvent => ({ scene: 's', scene_index: 0, status: 'ok', ...o });

/** Minimal XML well-formedness: balanced tags, quoted attributes, one root. */
function wellFormed(xml: string): { ok: boolean; root?: string; error?: string } {
  const body = xml.replace(/<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '');
  const stack: string[] = [];
  let root: string | undefined;
  const re = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const between = body.slice(last, m.index);
    if (/[<>]/.test(between)) return { ok: false, error: `stray markup before ${m[0]}` };
    last = re.lastIndex;
    const [, close, name, , self] = m;
    if (close) {
      if (stack.pop() !== name) return { ok: false, error: `unbalanced </${name}>` };
    } else if (!self) {
      if (!root) root = name;
      stack.push(name);
    } else if (!root) root = name;
  }
  if (/[<>]/.test(body.slice(last))) return { ok: false, error: 'trailing markup' };
  return stack.length === 0 ? { ok: true, root } : { ok: false, error: `unclosed ${stack.join(',')}` };
}

describe('loading cuts (R-RAW-01)', () => {
  const still = { stillEnd: 2, sceneEnd: 20 };

  it('cuts a navigation load: from just after the click to just after the awaited state', () => {
    const events = [
      ev({ step: 0, action: 'click', t_start: 3, t_end: 5, t_click: 4 }),
      ev({ step: 1, action: 'wait_for', t_start: 5.01, t_end: 5.02 }),
      ev({ step: 2, action: 'wait_for', t_start: 5.02, t_end: 8, mark: 'reveal', hold: { t_start: 8, t_end: 9.5 } }),
      ev({ step: 3, action: 'hold', t_start: 9.6, t_end: 10 }),
    ];
    const cuts = loadingCuts(events, { ...still, pageChanges: () => [4.2] });
    // The URL changed 0.2 s after the click: nothing of the loading page is kept (else 0.3 s of the press would be).
    expect(cuts).toEqual([{ from: 4.2, to: 8 + RAW_CUT.result_margin_s, reason: 'navigation', after_step: 0, wait_step: 2 }]);
    expect(loadingCuts(events, { ...still, pageChanges: () => [4.9] })[0].from).toBe(4 + RAW_CUT.action_keep_s);
  });

  it('paces the resume on the capture: a slowly painted page resumes 1.5 frame intervals after the wait (≤ 0.3 s)', () => {
    const events = [ev({ step: 0, action: 'click', t_start: 3, t_end: 4, t_click: 3.5 }), ev({ step: 1, action: 'wait_for', t_start: 4, t_end: 6 })];
    expect(loadingCuts(events, { ...still, frameInterval: () => 0.12 })[0].to).toBeCloseTo(6.18, 6);
    expect(loadingCuts(events, { ...still, frameInterval: () => 1 })[0].to).toBeCloseTo(6 + RAW_CUT.paint_max_s, 6);
    expect(loadingCuts(events, { ...still, frameInterval: () => 0.016 })[0].to).toBeCloseTo(6.05, 6);
    expect(localFrameInterval([0, 0.1, 0.2, 0.3, 0.42, 0.5], 0.25)).toBeCloseTo(0.1, 6);
    expect(localFrameInterval([0, 5], 2)).toBeUndefined();
  });

  it('an in-page wait after a press is "loading"; a wait for an email is "mail"', () => {
    const inPage = loadingCuts([ev({ step: 0, action: 'click', t_start: 3, t_end: 4, t_click: 3.5 }), ev({ step: 1, action: 'wait_for', t_start: 4.02, t_end: 6 })], still);
    expect(inPage).toMatchObject([{ reason: 'loading', from: 3.8, after_step: 0 }]);
    const mail = loadingCuts([ev({ step: 0, action: 'click', t_start: 3, t_end: 4, t_click: 3.5 }), ev({ step: 1, action: 'wait_for_email', t_start: 4, t_end: 7 })], still);
    expect(mail[0].reason).toBe('mail');
  });

  it('never cuts short waits, holds, marked steps, the opening still or across pages', () => {
    // A wait that did not really wait.
    expect(loadingCuts([ev({ step: 0, action: 'click', t_start: 3, t_end: 4, t_click: 3.5 }), ev({ step: 1, action: 'wait_for', t_start: 4, t_end: 4.2 })], still)).toEqual([]);
    // The step before holds or is marked: the cut starts at the wait, not inside that step.
    const held = loadingCuts([ev({ step: 0, action: 'click', t_start: 3, t_end: 4, t_click: 3.5, hold: { t_start: 4, t_end: 5 } }), ev({ step: 1, action: 'wait_for', t_start: 5, t_end: 7 })], still);
    expect(held[0]).toMatchObject({ from: 5 });
    expect(held[0].after_step).toBeUndefined();
    const marked = loadingCuts([ev({ step: 0, action: 'click', t_start: 3, t_end: 4, t_click: 3.5, mark: 'go' }), ev({ step: 1, action: 'wait_for', t_start: 4, t_end: 7 })], still);
    expect(marked[0].from).toBe(4);
    // A marked wait ends its group: what it waited for stays, the next wait group is separate.
    const two = loadingCuts([ev({ step: 0, action: 'wait_for', t_start: 3, t_end: 5, mark: 'a' }), ev({ step: 1, action: 'wait_for', t_start: 5, t_end: 7 })], still);
    expect(two.map((c) => [c.from, c.to])).toEqual([[3, 5.05], [5, 7.05]]);
    // Never into the opening still.
    expect(loadingCuts([ev({ step: 0, action: 'wait_for', t_start: 1, t_end: 4 })], still)[0].from).toBe(2);
    // A wait on another page than the press (a live hand-off) keeps the press's step whole.
    const other = loadingCuts([ev({ step: 0, action: 'click', t_start: 3, t_end: 4, t_click: 3.5, page: 'a' }), ev({ step: 1, action: 'wait_for', t_start: 4, t_end: 7, page: 'b' })], still);
    expect(other[0]).toMatchObject({ from: 4, page: 'b' });
    expect(other[0].after_step).toBeUndefined();
  });

  it("starts after the step's LAST press: a type's typing and Enter, a widget's option click, a menu's confirm", () => {
    const wait = (t_start: number, t_end = t_start + 1.5) => ev({ step: 9, action: 'wait_for', t_start, t_end });
    const hold = (t: number) => ev({ step: 10, action: 'hold', t_start: t, t_end: t + 1.5, hold: { t_start: t, t_end: t + 1.5 } });
    // type into a field (clicked at 3.1), typed until 4.6, Enter at 4.9 (the signup search shape).
    const typed = ev({ step: 0, action: 'type', t_start: 3, t_end: 5.2, t_click: 3.1, data: { chars: 6, cps: 8, t_type: 3.1, t_typed: 4.6, t_enter: 4.9 } });
    expect(loadingCuts([typed, wait(5.21), hold(6.72)], still)[0]).toMatchObject({ from: 4.9 + RAW_CUT.action_keep_s, after_step: 0 });
    // Without Enter: after the end of the typing (the catalogue search-as-you-type shape), never at the field click.
    const noEnter = ev({ step: 0, action: 'type', t_start: 2.5, t_end: 4.8, t_click: 3.1, data: { chars: 13, cps: 10, t_type: 3.4, t_typed: 4.8 } });
    expect(loadingCuts([noEnter, wait(4.81), hold(6.32)], still)[0].from).toBe(4.81);
    const longer = { ...noEnter, t_end: 5.5 };
    expect(loadingCuts([longer, wait(5.51), hold(7.02)], still)[0].from).toBeCloseTo(4.8 + RAW_CUT.action_keep_s, 6);
    // A run before the typing end was recorded: the step is kept whole.
    const oldType = ev({ step: 0, action: 'type', t_start: 2.5, t_end: 4.8, t_click: 3.1, data: { chars: 13, cps: 10 } });
    expect(loadingCuts([oldType, wait(4.81), hold(6.32)], still)[0].from).toBe(4.81);
    // select: trigger 3.2, option 4.85 (the popup and the option click stay).
    const select = ev({ step: 0, action: 'select', t_start: 3, t_end: 5.3, t_click: 3.2, data: { option: '5 kg', clicks: [{ role: 'trigger', t_click: 3.2 }, { role: 'option', t_click: 4.85 }] } });
    const sc = loadingCuts([select, wait(5.31), hold(6.82)], still)[0];
    expect(sc.from).toBeCloseTo(4.85 + RAW_CUT.action_keep_s, 6);
    expect(sc.from).toBeGreaterThan(4.85);
    // menu with a confirm click.
    const menu = ev({ step: 0, action: 'menu', t_start: 3, t_end: 7, t_click: 3.4, data: { clicks: [{ role: 'trigger', t_click: 3.4 }, { role: 'item', t_click: 5 }, { role: 'confirm', t_click: 6.4 }] } });
    expect(loadingCuts([menu, wait(7.01), hold(8.52)], still)[0].from).toBeCloseTo(6.4 + RAW_CUT.action_keep_s, 6);
    // A drag (press, travel, release) and repeated keys are kept whole.
    const drag = ev({ step: 0, action: 'drag', t_start: 3, t_end: 5, t_click: 3.3 });
    expect(loadingCuts([drag, wait(5.01), hold(6.52)], still)[0].from).toBe(5.01);
    const keys = ev({ step: 0, action: 'press', t_start: 3, t_end: 4.5, t_click: 3, data: { key: 'ArrowDown', times: 4 } });
    expect(loadingCuts([keys, wait(4.51), hold(6.02)], still)[0].from).toBe(4.51);
    // A single key press: 0.3 s after it.
    const key = ev({ step: 0, action: 'press', t_start: 3, t_end: 3.6, t_click: 3, data: { key: 'Enter', times: 1 } });
    expect(loadingCuts([key, wait(3.61), hold(5.12)], still)[0].from).toBeCloseTo(3.3, 6);
  });

  it("a navigation is the URL change after the step's last press (an Enter), never one during its typing", () => {
    const typed = ev({ step: 0, action: 'type', t_start: 3, t_end: 5.6, t_click: 3.1, data: { t_type: 3.1, t_typed: 4.6, t_enter: 4.9 } });
    const events = [typed, ev({ step: 1, action: 'wait_for', t_start: 5.61, t_end: 7 }), ev({ step: 2, action: 'hold', t_start: 7, t_end: 8.5, hold: { t_start: 7, t_end: 8.5 } })];
    expect(loadingCuts(events, { ...still, pageChanges: () => [5.05] })[0]).toMatchObject({ from: 5.05, reason: 'navigation' });
    // A URL rewritten while typing (search-as-you-type) is no navigation: the typing stays.
    expect(loadingCuts(events, { ...still, pageChanges: () => [3.8] })[0]).toMatchObject({ from: 4.9 + RAW_CUT.action_keep_s, reason: 'loading' });
  });

  it('a scene that ends on its awaited state keeps the loading (the result would be out of the clip)', () => {
    const events = [ev({ step: 0, action: 'click', t_start: 2, t_end: 6.5, t_click: 6.2 }), ev({ step: 1, action: 'wait_for', t_start: 6.5, t_end: 8 })];
    const kept: unknown[] = [];
    expect(loadingCuts(events, { stillEnd: 2, sceneEnd: 8.005, kept: (l) => kept.push(l) })).toEqual([]);
    expect(kept).toMatchObject([{ from: 6.5, wait_step: 1 }]);
    // With room for the result after it, the cut is made.
    expect(loadingCuts(events, { stillEnd: 2, sceneEnd: 8.05 + RAW_CUT.min_tail_s }).length).toBe(1);
  });

  it('resumes on a frame painted after the margin: the next screencast frame when the page was still painting', () => {
    // The catalogue import: awaited state seen at 19.893; a half-drawn frame arrived at 19.926, the painted one at 20.051.
    const events = [ev({ step: 0, action: 'drop_file', t_start: 10, t_end: 16, t_click: 15.66 }), ev({ step: 1, action: 'wait_for', t_start: 16, t_end: 19.893 }), ev({ step: 2, action: 'hold', t_start: 19.9, t_end: 21.5, hold: { t_start: 19.9, t_end: 21.5 } })];
    const frames = [19.5, 19.62, 19.72, 19.82, 19.926, 20.051, 20.15];
    const opts = { stillEnd: 2, sceneEnd: 22, frameInterval: () => 0.103, nextFrame: (_p: string | undefined, t: number) => frames.find((f) => f >= t - 1e-6) };
    expect(loadingCuts(events, opts)[0].to).toBe(20.051);
    // An idle page sends no frame: its last frame is its final picture, the resume stays at t_end + margin.
    const idle = [19.5, 19.926, 21.2];
    expect(loadingCuts(events, { ...opts, nextFrame: (_p, t) => idle.find((f) => f >= t - 1e-6) })[0].to).toBe(20.048);
  });
});

describe('clip plan on real timelines (R-RAW-01)', () => {
  it('quote: one clip per scene from its still (the page load out), contiguous on the sequence, real time', () => {
    const tl = fixture('quote');
    const plan = planRawExport(tl, { fps: 30 });
    const scenes = tl.scenes.filter((s) => s.kind === 'scene');
    expect(plan.clips.map((c) => c.name)).toEqual(scenes.map((s, i) => `${String(i + 1).padStart(2, '0')}-${s.id}`));
    for (const c of plan.clips) {
      const still = c.events.find((e) => e.action === 'scene_still');
      expect(c.t0).toBe(still?.t_start ?? c.t0);
      expect(c.spans[0].n0).toBe(Math.ceil(c.t0 * 30 - 1e-6));
      expect(c.frames).toBe(c.spans.reduce((n, s) => n + s.n1 - s.n0, 0));
      expect(c.primary).toBe(true);
    }
    // Real time: a clip without cuts lasts its capture range.
    const plain = plan.clips.find((c) => c.cuts.length === 0)!;
    expect(Math.abs(plain.frames / 30 - (plain.t1 - plain.t0))).toBeLessThan(2 / 30);
    let at = 0;
    for (const s of plan.sequence) {
      expect(s.start).toBe(at);
      at += plan.clips[s.clip].frames;
    }
    expect(plan.frames).toBe(at);
    expect(plan.notes.some((n) => /page load .* is not in the clip/.test(n))).toBe(true);
  });

  it('60 fps: the same capture ranges on a twice finer grid (frame n = capture time n / 60)', () => {
    const tl = fixture('quote');
    const p30 = planRawExport(tl, { fps: 30 });
    const p60 = planRawExport(tl, { fps: 60 });
    p30.clips.forEach((c, i) => {
      expect(Math.abs(p60.clips[i].frames - 2 * c.frames)).toBeLessThanOrEqual(2);
      expect(gridFrameOf(p60.clips[i], 0)).toBe(Math.ceil(c.t0 * 60 - 1e-6));
    });
  });

  it('catalogue: the loading inside scenes is cut (marked waits keep their moment), --no-cuts keeps it', () => {
    const tl = fixture('catalogue');
    const plan = planRawExport(tl, { fps: 30 });
    const cuts = plan.clips.flatMap((c) => c.cuts.map((x) => ({ clip: c.name, ...x })));
    for (const x of cuts) {
      const clip = plan.clips.find((c) => c.name === x.clip)!;
      const wait = clip.events.find((e) => e.step === x.wait_step)!;
      expect(['wait_for', 'wait_for_email']).toContain(wait.action);
      // The awaited state is kept: the cut ends after the wait's end.
      expect(x.to).toBeGreaterThan(wait.t_end);
      expect(clipFrameAt(clip, wait.t_end + 0.2, 30)).toBeGreaterThan(x.at - 1);
      // Nothing of the cut is in the clip.
      expect(clip.spans.some((s) => s.n0 < x.n1 && s.n1 > x.n0)).toBe(false);
    }
    const none = planRawExport(tl, { fps: 30, cuts: false });
    expect(none.clips.every((c) => c.cuts.length === 0 && c.spans.length === 1)).toBe(true);
  });

  /** A one-scene capture: still 1–2 s, then `events`; the scene ends at `end`; screencast frames at `frames`. */
  const synthetic = (events: TimelineEvent[], end: number, frames: number[]): Timeline =>
    ({
      run_id: 'r',
      mode: 'capture',
      scenario: 'x',
      capture: { file: 'capture.mp4', width: 1920, height: 1080, scale: 1, fps: 30, duration: end + 1, frames: Math.round((end + 1) * 30) },
      scenes: [{ id: 's', index: 0, kind: 'scene', t_start: 0, t_end: end, status: 'ok' }],
      events: [ev({ step: -1, action: 'scene_still', t_start: 1, t_end: 2 }), ...events],
      pages: [{ id: 'main', t_start: 0, t_end: end + 1 }],
      cursor: [],
      markers: [],
      idle: [],
      warnings: [],
    }) as unknown as Timeline;

  it('the first frame after a cut shows a frame painted after the resume, at 30 and 60 fps', () => {
    // The catalogue import at 60 fps: the painted frame arrived 3 ms after t_end + margin (half-drawn frame before it).
    const frames = [...Array.from({ length: 199 }, (_, i) => i * 0.1), 19.926, 20.051, ...Array.from({ length: 20 }, (_, i) => 20.151 + i * 0.1)];
    const tl = synthetic(
      [
        ev({ step: 0, action: 'drop_file', t_start: 10, t_end: 16, t_click: 15.66 }),
        ev({ step: 1, action: 'wait_for', t_start: 16, t_end: 19.893 }),
        ev({ step: 2, action: 'hold', t_start: 19.9, t_end: 21.5, hold: { t_start: 19.9, t_end: 21.5 } }),
      ],
      22,
      frames,
    );
    const index = frames.map((t, i) => ({ file: `${i}.jpg`, t }));
    for (const fps of [30, 60]) {
      const plan = planRawExport(tl, { fps, frameTimes: () => frames });
      const clip = plan.clips[0];
      expect(clip.cuts.length).toBe(1);
      expect(clip.cuts[0].to).toBe(20.051);
      const schedule = cfrSchedule(index, 23, fps);
      const shown = schedule[gridFrameOf(clip, clip.cuts[0].at)];
      expect(index.find((f) => f.file === shown)!.t, `${fps} fps`).toBe(20.051);
      // The frame before the cut still shows the press, not the loading.
      expect(index.find((f) => f.file === schedule[gridFrameOf(clip, clip.cuts[0].at - 1)])!.t).toBeLessThan(16.1);
    }
  });

  it('a scene ending on a long wait keeps its loading: its marks and step markers are on the clip', () => {
    const events = [ev({ step: 0, action: 'click', t_start: 2, t_end: 6.5, t_click: 6.2 }), ev({ step: 1, action: 'wait_for', t_start: 6.5, t_end: 8, mark: 'sent' })];
    const frames = Array.from({ length: 270 }, (_, i) => i / 30);
    for (const marked of [false, true]) {
      const tl = synthetic(events.map((e) => (e.step === 1 && !marked ? { ...e, mark: undefined } : e)), 8.005, frames);
      const plan = planRawExport(tl, { fps: 30, frameTimes: () => frames });
      const clip = plan.clips[0];
      expect(clip.cuts).toEqual([]);
      expect(clip.frames).toBe(Math.ceil(8.005 * 30) - 30);
      expect(plan.notes.some((n) => /loading kept .* ends on the awaited state of step s\.1, .* `hold`/.test(n))).toBe(true);
      const m = rawMarkers(plan);
      expect(m.filter((x) => x.kind === 'step').map((x) => x.step)).toEqual([0, 1]);
      expect(m.filter((x) => x.kind === 'mark').length).toBe(marked ? 1 : 0);
      for (const x of m) expect(x.frame).toBeLessThan(clip.frames);
      if (marked) expect(m.find((x) => x.kind === 'mark')!.frame).toBe(clip.frames - 1);
    }
  });

  it('live-quote (two pages): a clip per page per scene on the same frames; the first acting page is on the sequence', () => {
    const tl = fixture('live-quote');
    const plan = planRawExport(tl, { fps: 30 });
    const scenes = tl.scenes.filter((s) => s.kind === 'scene');
    expect(plan.clips.length).toBe(scenes.reduce((n, s) => n + (s.pages?.length ?? 1), 0));
    for (const s of scenes) {
      const clips = plan.clips.filter((c) => c.scene === s.id);
      expect(clips.map((c) => c.page)).toEqual(s.pages!.map((p) => p.id));
      expect(new Set(clips.map((c) => JSON.stringify(c.spans))).size).toBe(1);
      expect(clips.filter((c) => c.primary).length).toBe(1);
      const still = tl.events.find((e) => e.scene === s.id && e.action === 'scene_still');
      expect(clips.find((c) => c.primary)!.page).toBe(still?.page ?? s.pages![0].id);
      for (const c of clips) {
        expect(c.name).toBe(`${String(c.number).padStart(2, '0')}-${s.id}-${c.page}`);
        expect(c.source.track).toBe(c.page);
      }
    }
    expect(plan.sequence.length).toBe(scenes.length);
  });
});

describe('markers and interchange files (R-RAW-03)', () => {
  const tl = fixture('catalogue');
  const plan = planRawExport(tl, { fps: 30 });
  const markers = rawMarkers(plan);
  const files = { clips: plan.clips.map((c) => `/pkg/clips/${c.name}.mp4`) };
  const meta = { title: 'catalogue raw', event: 'Demo raw', uid: 'run-1' };

  it('timecodes and rational times', () => {
    expect(timecode(0, 30)).toBe('00:00:00:00');
    expect(timecode(30 * 3661 + 29, 30)).toBe('01:01:01:29');
    expect(timecode(119, 60)).toBe('00:00:01:59');
    expect(fcpTime(0, 30)).toBe('0s');
    expect(fcpTime(249, 30)).toBe('249/30s');
  });

  it('scenes, steps, marks, captions and cuts on the sequence clips, in clip and sequence frames', () => {
    const kinds = new Set(markers.map((m) => m.kind));
    for (const k of ['scene', 'step', 'mark', 'caption', 'cut']) expect(kinds.has(k as never), k).toBe(true);
    expect(markers.filter((m) => m.kind === 'scene').length).toBe(plan.sequence.length);
    expect(markers.filter((m) => m.kind === 'mark').map((m) => m.name).sort()).toEqual(tl.markers.map((m) => m.name).sort());
    for (const m of markers) {
      const clip = plan.clips[m.clip];
      expect(clip.primary).toBe(true);
      expect(m.frame).toBeGreaterThanOrEqual(0);
      expect(m.frame + m.duration).toBeLessThanOrEqual(clip.frames);
      expect(m.seq).toBe(plan.sequence.find((s) => s.clip === m.clip)!.start + m.frame);
    }
    // A caption lasts until the next one.
    const caps = markers.filter((m) => m.kind === 'caption');
    expect(caps.every((c) => c.duration >= 1)).toBe(true);
  });

  it('FCPXML 1.10: well-formed, one project, clips on the spine back to back, every time on the frame grid', () => {
    const x = writeFcpxml(plan, markers, files, meta);
    const wf = wellFormed(x);
    expect(wf, wf.error).toMatchObject({ ok: true, root: 'fcpxml' });
    expect(x).toContain('<fcpxml version="1.10">');
    expect((x.match(/<project /g) ?? []).length).toBe(1);
    expect(x).toContain(`<sequence format="r1" duration="${plan.frames}/30s" tcStart="0s" tcFormat="NDF">`);
    const times = [...x.matchAll(/(?:start|duration|offset)="([^"]+)"/g)].map((m) => m[1]);
    for (const t of times) expect(t, t).toMatch(/^(0s|\d+\/30s)$/);
    for (const s of plan.sequence) {
      const c = plan.clips[s.clip];
      expect(x).toContain(`offset="${fcpTime(s.start, 30)}" name="${c.name}" start="${fcpTime(s.start, 30)}" duration="${c.frames}/30s"`);
    }
    expect((x.match(/<chapter-marker /g) ?? []).length).toBe(plan.sequence.length);
    expect((x.match(/<marker /g) ?? []).length + (x.match(/<chapter-marker /g) ?? []).length).toBe(markers.length);
    expect(x).toContain('src="file:///pkg/clips/01-import.mp4"');
  });

  it('CMX 3600: an event per sequence clip, source = record timecodes, LOC lines inside each event', () => {
    const e = writeEdl(plan, markers, files, meta);
    const lines = e.split('\n');
    expect(lines[0]).toBe('TITLE: catalogue raw');
    expect(lines[1]).toBe('FCM: NON-DROP FRAME');
    const events = lines.filter((l) => /^\d{3}  /.test(l));
    expect(events.length).toBe(plan.sequence.length);
    events.forEach((l, i) => {
      const s = plan.sequence[i];
      const c = plan.clips[s.clip];
      const a = timecode(s.start, 30);
      const b = timecode(s.start + c.frames, 30);
      expect(l).toBe(`${String(i + 1).padStart(3, '0')}  CLIP${String(c.number).padStart(3, '0')}  V     C        ${a} ${b} ${a} ${b}`);
    });
    const locs = lines.filter((l) => l.startsWith('* LOC: '));
    expect(locs.length).toBe(markers.length);
    for (const l of locs) expect(l).toMatch(/^\* LOC: \d\d:\d\d:\d\d:\d\d (RED|GREEN|BLUE|CYAN|MAGENTA|YELLOW|WHITE|BLACK) +[\x20-\x7e]+$/);
  });

  it('OTIO: a Timeline with V1 of the clips at their timecode and coloured markers in media time', () => {
    const o = JSON.parse(writeOtio(plan, markers, files, meta)) as {
      OTIO_SCHEMA: string;
      tracks: { children: Array<{ name: string; kind: string; children: Array<{ OTIO_SCHEMA: string; name: string; source_range: { start_time: { value: number }; duration: { value: number; rate: number } }; markers: Array<{ color: string; marked_range: { start_time: { value: number } } }>; media_references: { DEFAULT_MEDIA: { target_url: string } } }> }> };
    };
    expect(o.OTIO_SCHEMA).toBe('Timeline.1');
    const v1 = o.tracks.children[0];
    expect(v1).toMatchObject({ name: 'V1', kind: 'Video' });
    expect(v1.children.length).toBe(plan.sequence.length);
    v1.children.forEach((c, i) => {
      const s = plan.sequence[i];
      expect(c.OTIO_SCHEMA).toBe('Clip.2');
      expect(c.source_range.start_time.value).toBe(s.start);
      expect(c.source_range.duration).toMatchObject({ value: plan.clips[s.clip].frames, rate: 30 });
      // A URL (OTIO's target_url), as in the FCPXML.
      expect(c.media_references.DEFAULT_MEDIA.target_url).toBe(`file://${files.clips[s.clip]}`);
      for (const m of c.markers) {
        expect(m.marked_range.start_time.value).toBeGreaterThanOrEqual(s.start);
        expect(m.marked_range.start_time.value).toBeLessThan(s.start + plan.clips[s.clip].frames);
      }
    });
    expect(v1.children.reduce((n, c) => n + c.markers.length, 0)).toBe(markers.length);
  });

  it('multi-page + layers: other pages connected and disabled, cursor layers above their clip', () => {
    const lq = planRawExport(fixture('live-quote'), { fps: 60 });
    const lm = rawMarkers(lq);
    const f = { clips: lq.clips.map((c) => `/p/clips/${c.name}.mov`), layers: lq.clips.map((c) => `/p/cursor/${c.name}-cursor.mov`) };
    const x = writeFcpxml(lq, lm, f, meta);
    expect(wellFormed(x).ok).toBe(true);
    expect((x.match(/enabled="0"/g) ?? []).length).toBe(2 * (lq.clips.length - lq.sequence.length));
    expect((x.match(/lane="1"/g) ?? []).length).toBe(lq.sequence.length);
    const o = JSON.parse(writeOtio(lq, lm, f, meta)) as { tracks: { children: Array<{ name: string }> } };
    expect(o.tracks.children.map((t) => t.name)).toEqual(['V1', 'Cursor', 'Page 2', 'Page 2 cursor']);
    // The EDL keeps the sequence only.
    expect(writeEdl(lq, lm, f, meta).split('\n').filter((l) => /^\d{3}  /.test(l)).length).toBe(lq.sequence.length);
    // ProRes layers carry their clip's timecode: media time from the clip's sequence start.
    const later = lq.sequence[1];
    const laterClip = lq.clips[later.clip];
    expect(later.start).toBeGreaterThan(0);
    expect(x).toContain(`name="${laterClip.name}-cursor" uid="run-1/${laterClip.name}-cursor" start="${fcpTime(later.start, 60)}"`);
  });

  it('WebM layers (no timecode): out of the FCPXML, referenced from media time 0 in the OTIO', () => {
    const lq = planRawExport(fixture('live-quote'), { fps: 30 });
    const lm = rawMarkers(lq);
    const f = { clips: lq.clips.map((c) => `/p/clips/${c.name}.mp4`), layers: lq.clips.map((c) => `/p/cursor/${c.name}-cursor.webm`), layersTimecoded: false };
    const x = writeFcpxml(lq, lm, f, meta);
    expect(wellFormed(x).ok).toBe(true);
    expect(x).not.toContain('-cursor');
    expect((x.match(/enabled="0"/g) ?? []).length).toBe(lq.clips.length - lq.sequence.length);
    type OClip = { OTIO_SCHEMA: string; name: string; source_range: { start_time: { value: number }; duration: { value: number } }; media_references: { DEFAULT_MEDIA: { available_range: { start_time: { value: number } }; target_url: string } } };
    const o = JSON.parse(writeOtio(lq, lm, f, meta)) as { tracks: { children: Array<{ name: string; children: OClip[] }> } };
    const cursor = o.tracks.children.find((t) => t.name === 'Cursor')!.children.filter((c) => c.OTIO_SCHEMA === 'Clip.2');
    const v1 = o.tracks.children.find((t) => t.name === 'V1')!.children.filter((c) => c.OTIO_SCHEMA === 'Clip.2');
    expect(cursor.length).toBe(lq.sequence.length);
    cursor.forEach((c, i) => {
      expect(c.source_range.start_time.value).toBe(0);
      expect(c.media_references.DEFAULT_MEDIA.available_range.start_time.value).toBe(0);
      expect(c.source_range.duration.value).toBe(v1[i].source_range.duration.value);
      expect(c.media_references.DEFAULT_MEDIA.target_url).toMatch(/^file:\/\/\/p\/cursor\/.*-cursor\.webm$/);
    });
    // The clips themselves keep their timecode (the second scene starts later on the sequence).
    expect(v1[1].source_range.start_time.value).toBe(lq.sequence[1].start);
    expect(v1[1].source_range.start_time.value).toBeGreaterThan(0);
  });

  it('markers.csv and markers.json agree, with clip-relative and sequence times', () => {
    const file = (c: { name: string }) => `clips/${c.name}.mp4`;
    const j = JSON.parse(markersJson(plan, markers, file)) as { markers: Array<{ seq_frame: number; seq_tc: string; clip_frame: number; clip: string }> };
    const rows = markersCsv(plan, markers, file).trim().split('\n');
    expect(rows[0].startsWith('kind,name,color,clip,')).toBe(true);
    expect(rows.length - 1).toBe(j.markers.length);
    for (const m of j.markers) expect(m.seq_tc).toBe(timecode(m.seq_frame, 30));
  });
});

describe('cursor model (R-RAW-02)', () => {
  it('press scale: a 90 ms ease-out to 0.9 and back, from wherever it was', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
    const edges = [{ t: 1, down: true }, { t: 1.08, down: false }];
    expect(pressScaleAt(edges, 0.5)).toBe(1);
    expect(pressScaleAt(edges, 1)).toBe(1);
    expect(pressScaleAt(edges, 1.079)).toBeLessThan(0.92);
    expect(pressScaleAt(edges, 1.3)).toBeCloseTo(1, 6);
    expect(pressScaleAt([{ t: 0, down: true }], 5)).toBeCloseTo(CURSOR_LOOK.press_scale, 6);
    expect(scaleStep(1)).toBe(0);
    expect(scaleStep(0.9)).toBe(10);
  });

  it('frames from recorded effects: position, icon, press and ripples young enough', () => {
    const tl = fixture('quote');
    const plan = planRawExport(tl, { fps: 30 });
    const clip = plan.clips[1];
    const t = gridFrameOf(clip, 30) / 30;
    const samples = [
      { t: t - 1, x: 10, y: 20, visible: true },
      { t: t - 0.05, x: 100, y: 200, visible: true, down: true },
      { t: t + 0.5, x: 100, y: 200, visible: true },
    ];
    const effects = [
      { t: 0, type: 'icon' as const, icon: 'arrow' as const },
      { t: t - 0.2, type: 'icon' as const, icon: 'hand' as const },
      { t: t - 0.05, type: 'press' as const },
      { t: t - 0.05, type: 'ripple' as const, x: 100, y: 200 },
    ];
    const { frames, approximated } = cursorFrames(clip, 30, { samples, effects });
    expect(approximated).toBe(false);
    expect(frames.length).toBe(clip.frames);
    expect(frames[30]).toMatchObject({ x: 100, y: 200, visible: true, down: true, icon: 'hand' });
    expect(frames[30].ripples).toEqual([{ x: 100, y: 200, age: 0.05 }]);
    expect(frames[30].scale).toBeLessThan(1);
    expect(frames[30 + 20].ripples).toEqual([]);
    expect(frames[0].icon).toBe('arrow');
  });

  it('runs before L2.13: presses and ripples from the button samples, hand over a clicked button', () => {
    const fx = approximateEffects(
      [
        { t: 1, x: 5, y: 5, visible: true },
        { t: 2, x: 50, y: 50, visible: true, down: true },
        { t: 2.1, x: 50, y: 50, visible: true },
        { t: 3.5, x: 5, y: 5, visible: true },
      ],
      [ev({ step: 0, action: 'click', t_start: 1, t_end: 3, t_click: 2, target: { desc: 'button "Go"', bbox: { x: 40, y: 40, w: 30, h: 20 } } })],
    );
    expect(fx.filter((e) => e.type === 'press').map((e) => e.t)).toEqual([2]);
    expect(fx.filter((e) => e.type === 'ripple')).toEqual([{ t: 2, type: 'ripple', x: 50, y: 50 }]);
    expect(fx.filter((e) => e.type === 'icon').map((e) => e.icon)).toEqual(['arrow', 'hand', 'arrow']);
  });

  it('clicks with their step, target box and clip frame; CSV in clip pixels', () => {
    const tl = fixture('quote');
    const plan = planRawExport(tl, { fps: 30 });
    const data = plan.clips.map((c) => ({
      clip: c,
      file: `clips/${c.name}.mp4`,
      frames: cursorFrames(c, 30, { samples: tl.cursor }).frames,
      clicks: clipClicks(c, 30, (t) => clipFrameAt(c, t, 30)),
      approximated: true,
    }));
    const all = data.flatMap((d) => d.clicks);
    const clickEvents = tl.events.filter((e) => typeof e.t_click === 'number' && e.action !== 'press' && !(e.action === 'type' && !e.point));
    expect(all.length).toBeGreaterThanOrEqual(clickEvents.length);
    for (const d of data) for (const k of d.clicks) expect(k.f).toBeLessThan(d.clip.frames);
    const csv = clicksCsv(plan, data).trim().split('\n');
    expect(csv[0]).toBe('clip,frame,time_s,seq_time_s,capture_t,x,y,scene,step,step_id,action,target,bbox_x,bbox_y,bbox_w,bbox_h,page');
    expect(csv.length - 1).toBe(all.length);
    const rows = cursorCsv(plan, data).trim().split('\n');
    expect(rows.length - 1).toBe(plan.clips.reduce((n, c) => n + c.frames, 0));
    const j = JSON.parse(cursorJson(plan, data, { run: 'r', mode: 'baked' })) as { clips: Array<{ samples: unknown[]; clicks: unknown[] }> };
    expect(j.clips.length).toBe(plan.clips.length);
  });

  it("the timing constants match the kit's cursor look", () => {
    const src = kitSource({ cursor: { style: 'arrow-dark', size: 26, ripple_color: 'red' }, storage_key: 'k' });
    expect(src).toContain(`transition:transform ${CURSOR_LOOK.press_ms}ms ease-out`);
    expect(src).toContain(`.s.p{transform:scale(${String(CURSOR_LOOK.press_scale).replace(/^0/, '')})}`);
    expect(src).toContain(`dsr-o ${CURSOR_LOOK.ripple_ms}ms`);
  });
});

describe('settings', () => {
  const project = { slug: 'p', dir: '/p', root: '/', config: { name: 'P', raw: { format: 'prores', fps: 60 } } } as never;
  it('flags win over project raw settings, the cursor defaults to how the run was captured', () => {
    expect(rawSettings(project, { capture: {} as Timeline['capture'] }, {})).toMatchObject({ format: 'prores', fps: 60, cursor: 'baked', layer: 'prores', cuts: true, selects: false });
    expect(rawSettings(project, { capture: { cursor: 'hidden' } as Timeline['capture'] }, { format: 'mp4' })).toMatchObject({ format: 'mp4', cursor: 'none', hidden: true });
    expect(() => rawSettings(project, { capture: {} as Timeline['capture'] }, { fps: 25 as never })).toThrow(/use 30 or 60/);
  });
});

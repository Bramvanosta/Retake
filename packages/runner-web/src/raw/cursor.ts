/**
 * Cursor of a raw export (L2.13, R-RAW-02): what the in-page cursor showed on every frame of a clip — position,
 * visibility, icon, press scale and click ripples — from the run's cursor track and its cursor effects (the icon,
 * presses and ripples the kit reported as it drew them; runs captured before L2.13 have none: approximated from the
 * steps, see `approximateEffects`). Clicks with their step and target. Pure.
 */
import type { BBox, CursorEffect, CursorIcon, CursorSample, Timeline, TimelineEvent } from '@retake/core/model';
import { gridFrameOf, type RawClipPlan, type RawPlan, sequenceStartOf } from './plan.js';

/**
 * Timing of the kit's cursor look (kit/page/cursor-look.ts `lookCss`; a unit test keeps them in step): the press
 * scales the icon to 0.9 over a 90 ms ease-out transition; a ripple grows over 500 ms and fades over 550 ms, then it is
 * removed.
 */
export const CURSOR_LOOK = { press_scale: 0.9, press_ms: 90, ripple_ms: 550 } as const;
/** A synthetic click (dom / pointer strategy) flashes the press for this long (kit `flashPress`). */
const FLASH_PRESS_S = 0.11;

/** The cursor of a clip's source: the main capture's, or its page track's (multi-page scenes). */
export function cursorTrackOf(timeline: Timeline, clip: Pick<RawClipPlan, 'source'>): { samples: CursorSample[]; effects?: CursorEffect[] } {
  if (clip.source.track === 'main') return { samples: timeline.cursor, ...(timeline.cursor_effects ? { effects: timeline.cursor_effects } : {}) };
  const t = timeline.tracks?.find((x) => x.id === clip.source.track);
  return { samples: t?.cursor ?? [], ...(t?.cursor_effects ? { effects: t.cursor_effects } : {}) };
}

const POINTER_ROLES = /^(link|button|menuitem|menuitemcheckbox|menuitemradio|option|tab|checkbox|radio|switch|combobox|treeitem|row|gridcell|cell|label|summary)\b/i;
const TEXT_ROLES = /^(textbox|searchbox|spinbutton|textarea|input)\b/i;

const inBox = (b: BBox | undefined, x: number, y: number) => !!b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

/**
 * Effects of a run captured before L2.13 (no `cursor_effects`): presses and ripples at the track's button-down
 * samples, a press flash and a ripple at each synthetic click (dom / pointer strategy) and, for the icon, the hand
 * over a step's clickable target (link, button, option…) and the text beam over a field while that step runs —
 * an approximation of what the kit computed from the page.
 */
export function approximateEffects(samples: readonly CursorSample[], events: readonly TimelineEvent[]): CursorEffect[] {
  const out: CursorEffect[] = [];
  let down = false;
  for (const s of samples) {
    const d = !!s.down;
    if (d && !down) {
      out.push({ t: s.t, type: 'press' }, { t: s.t, type: 'ripple', x: s.x, y: s.y });
    } else if (!d && down) out.push({ t: s.t, type: 'release' });
    down = d;
  }
  for (const e of events) {
    if ((e.strategy === 'dom' || e.strategy === 'pointer') && typeof e.t_click === 'number') {
      out.push({ t: e.t_click, type: 'press' }, { t: e.t_click + FLASH_PRESS_S, type: 'release' });
      if (e.point) out.push({ t: e.t_click, type: 'ripple', x: e.point.x, y: e.point.y });
    }
  }
  // Icons: sampled where the cursor moves, against the steps running then.
  const steps = events.filter((e) => e.step >= 0 && e.target?.bbox);
  let icon: CursorIcon = 'arrow';
  out.push({ t: 0, type: 'icon', icon });
  for (const s of samples) {
    const step = steps.find((e) => s.t >= e.t_start - 0.05 && s.t <= e.t_end + 0.05 && inBox(e.target!.bbox, s.x, s.y));
    const desc = step?.target?.desc ?? '';
    const next: CursorIcon = !step ? 'arrow' : TEXT_ROLES.test(desc) || step.action === 'type' ? 'ibeam' : POINTER_ROLES.test(desc) ? 'hand' : 'arrow';
    if (next !== icon) {
      icon = next;
      out.push({ t: s.t, type: 'icon', icon });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** CSS `ease-out` = cubic-bezier(0, 0, 0.58, 1) at progress u. */
export function easeOut(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  // x(s) = 3(1-s)s²·0.58 + s³ ... solve x(s) = u by bisection, return y(s).
  const bx = (s: number) => 3 * (1 - s) * s * s * 0.58 + s * s * s;
  const by = (s: number) => 3 * (1 - s) * (1 - s) * s * 0 + 3 * (1 - s) * s * s * 1 + s * s * s;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (bx(m) < u) lo = m;
    else hi = m;
  }
  return by((lo + hi) / 2);
}

/** The press scale at time t from press / release effects (sorted): a 90 ms ease-out transition from where it was. */
export function pressScaleAt(edges: ReadonlyArray<{ t: number; down: boolean }>, t: number): number {
  let from = 1;
  let to = 1;
  let t0 = -Infinity;
  const valueAt = (x: number) => from + (to - from) * easeOut((x - t0) / (CURSOR_LOOK.press_ms / 1000));
  for (const e of edges) {
    if (e.t > t) break;
    const v = Number.isFinite(t0) ? valueAt(e.t) : from;
    const target = e.down ? CURSOR_LOOK.press_scale : 1;
    if (target === to) continue;
    from = v;
    to = target;
    t0 = e.t;
  }
  return Number.isFinite(t0) ? valueAt(t) : 1;
}

/** What the cursor shows on one frame (CSS px of the clip's page). */
export interface CursorFrame {
  /** Clip frame. */
  f: number;
  /** Capture time of the frame (s). */
  t: number;
  x: number;
  y: number;
  visible: boolean;
  down: boolean;
  icon: CursorIcon;
  /** Press scale of the icon (1 → 0.9). */
  scale: number;
  /** Ripples on screen: centre (CSS px) and age (s). */
  ripples: Array<{ x: number; y: number; age: number }>;
}

/** Index of the last element whose t ≤ x (−1 when none); `list` sorted by t. */
function lastAtOrBefore<T extends { t: number }>(list: readonly T[], x: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (list[m].t <= x + 1e-9) lo = m + 1;
    else hi = m;
  }
  return lo - 1;
}

/**
 * The cursor on every frame of a clip: frame k shows capture time n/fps (its export-grid frame) — the latest sample
 * then, the icon last reported, the press scale and the ripples younger than their 550 ms.
 */
export function cursorFrames(clip: RawClipPlan, fps: number, track: { samples: readonly CursorSample[]; effects?: readonly CursorEffect[] }): { frames: CursorFrame[]; approximated: boolean } {
  const samples = [...track.samples].sort((a, b) => a.t - b.t);
  const approximated = !track.effects;
  const effects = [...(track.effects ?? approximateEffects(samples, clip.events))].sort((a, b) => a.t - b.t);
  const icons = effects.filter((e) => e.type === 'icon' && e.icon);
  const edges = effects.filter((e) => e.type === 'press' || e.type === 'release').map((e) => ({ t: e.t, down: e.type === 'press' }));
  const ripples = effects.filter((e) => e.type === 'ripple' && typeof e.x === 'number' && typeof e.y === 'number');
  const life = CURSOR_LOOK.ripple_ms / 1000;
  const frames: CursorFrame[] = [];
  for (let k = 0; k < clip.frames; k++) {
    const t = gridFrameOf(clip, k) / fps;
    const si = lastAtOrBefore(samples, t);
    const s = si >= 0 ? samples[si] : undefined;
    const ii = lastAtOrBefore(icons, t);
    const ei = lastAtOrBefore(edges, t);
    const r: CursorFrame['ripples'] = [];
    for (let j = lastAtOrBefore(ripples, t); j >= 0 && t - ripples[j].t < life; j--) r.unshift({ x: ripples[j].x!, y: ripples[j].y!, age: Math.round((t - ripples[j].t) * 1e4) / 1e4 });
    frames.push({
      f: k,
      t: Math.round(t * 1e4) / 1e4,
      x: s?.x ?? 0,
      y: s?.y ?? 0,
      visible: !!s?.visible,
      down: ei >= 0 ? edges[ei].down : false,
      icon: ii >= 0 ? icons[ii].icon! : 'arrow',
      scale: Math.round(pressScaleAt(edges, t) * 1e4) / 1e4,
      ripples: r,
    });
  }
  return { frames, approximated };
}

/** A click of a clip, with its step and target (CSS px). */
export interface RawClick {
  /** Clip frame and capture time. */
  f: number;
  t: number;
  x?: number;
  y?: number;
  scene: string;
  step: number;
  step_id?: string;
  action: string;
  target?: string;
  bbox?: BBox;
  page?: string;
}

/**
 * The clicks of a clip: every step's click (widgets: each of `data.clicks`), at its press time, on the clip's page
 * (multi-page scenes); a click inside a cut is placed on the first frame after it.
 */
export function clipClicks(clip: RawClipPlan, clipFrameAt: (t: number) => number | null): RawClick[] {
  const out: RawClick[] = [];
  for (const e of clip.events) {
    if (e.step < 0 || e.status === 'skipped') continue;
    if (clip.page !== undefined && (e.page ?? clip.page) !== clip.page) continue;
    const data = e.data as { clicks?: Array<{ t_click?: number; bbox?: BBox; point?: { x: number; y: number }; desc?: string }> } | undefined;
    const list = Array.isArray(data?.clicks) ? data!.clicks.filter((c) => typeof c.t_click === 'number') : [];
    const clicks = list.length
      ? list.map((c) => ({ t: c.t_click!, bbox: c.bbox, point: c.point, desc: c.desc ?? e.target?.desc }))
      : typeof e.t_click === 'number' && !(e.action === 'press' || (e.action === 'type' && e.point === undefined))
        ? [{ t: e.t_click, bbox: e.target?.bbox, point: e.point, desc: e.target?.desc }]
        : [];
    for (const c of clicks) {
      const f = clipFrameAt(c.t);
      if (f === null) continue;
      out.push({
        f,
        t: Math.round(c.t * 1000) / 1000,
        ...(c.point ? { x: c.point.x, y: c.point.y } : {}),
        scene: e.scene,
        step: e.step,
        ...(e.id ? { step_id: e.id } : {}),
        action: e.action,
        ...(c.desc ? { target: c.desc } : {}),
        ...(c.bbox ? { bbox: c.bbox } : {}),
        ...(e.page ? { page: e.page } : {}),
      });
    }
  }
  return out.sort((a, b) => a.f - b.f || a.t - b.t);
}

const csvCell = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csvLine = (cells: unknown[]): string => cells.map(csvCell).join(',');

export interface ClipCursorData {
  clip: RawClipPlan;
  file: string;
  frames: CursorFrame[];
  clicks: RawClick[];
  approximated: boolean;
}

/**
 * cursor.json: per clip, the cursor on every frame and the clicks — positions in the CLIP's pixels (CSS px × scale),
 * times clip-relative (s) and on the sequence; `capture_t` is the run's capture time.
 */
export function cursorJson(plan: RawPlan, data: readonly ClipCursorData[], meta: { run: string; mode: string }): string {
  const fps = plan.fps;
  return (
    JSON.stringify(
      {
        version: 1,
        run: meta.run,
        cursor: meta.mode,
        fps,
        units: 'pixels of the clip (CSS px × scale); times in seconds, clip-relative unless named seq_',
        clips: data.map((d) => {
          const sc = d.clip.source.scale;
          const seq = sequenceStartOf(plan, d.clip);
          return {
            clip: d.file,
            scene: d.clip.scene,
            ...(d.clip.page !== undefined ? { page: d.clip.page } : {}),
            width: d.clip.source.width,
            height: d.clip.source.height,
            frames: d.clip.frames,
            seq_start_frame: seq,
            icon_source: d.approximated ? 'approximated (the run did not record the cursor icon)' : 'recorded',
            samples: d.frames.map((c) => ({
              f: c.f,
              t: round4(c.f / fps),
              capture_t: c.t,
              x: round2(c.x * sc),
              y: round2(c.y * sc),
              visible: c.visible,
              down: c.down,
              icon: c.icon,
              ...(c.scale !== 1 ? { scale: c.scale } : {}),
              ...(c.ripples.length ? { ripples: c.ripples.map((r) => ({ x: round2(r.x * sc), y: round2(r.y * sc), age: r.age })) } : {}),
            })),
            clicks: d.clicks.map((k) => ({
              f: k.f,
              t: round4(k.f / fps),
              seq_t: round4((seq + k.f) / fps),
              capture_t: k.t,
              ...(k.x !== undefined ? { x: round2(k.x * sc), y: round2(k.y! * sc) } : {}),
              scene: k.scene,
              step: k.step,
              ...(k.step_id ? { step_id: k.step_id } : {}),
              action: k.action,
              ...(k.target ? { target: k.target } : {}),
              ...(k.bbox ? { bbox: { x: round2(k.bbox.x * sc), y: round2(k.bbox.y * sc), w: round2(k.bbox.w * sc), h: round2(k.bbox.h * sc) } } : {}),
              ...(k.page ? { page: k.page } : {}),
            })),
          };
        }),
      },
      null,
      1,
    ) + '\n'
  );
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** cursor.csv: one row per clip frame (clip-relative time, position in clip pixels, visible, down, icon, scale). */
export function cursorCsv(plan: RawPlan, data: readonly ClipCursorData[]): string {
  const rows = [csvLine(['clip', 'frame', 'time_s', 'seq_time_s', 'capture_t', 'x', 'y', 'visible', 'down', 'icon', 'scale', 'ripples'])];
  for (const d of data) {
    const sc = d.clip.source.scale;
    const seq = sequenceStartOf(plan, d.clip);
    for (const c of d.frames) {
      rows.push(
        csvLine([d.file, c.f, round4(c.f / plan.fps), round4((seq + c.f) / plan.fps), c.t, round2(c.x * sc), round2(c.y * sc), c.visible ? 1 : 0, c.down ? 1 : 0, c.icon, c.scale, c.ripples.length]),
      );
    }
  }
  return rows.join('\n') + '\n';
}

/** clicks.csv: one row per click (clip frame, times, position, step, target box — clip pixels). */
export function clicksCsv(plan: RawPlan, data: readonly ClipCursorData[]): string {
  const rows = [csvLine(['clip', 'frame', 'time_s', 'seq_time_s', 'capture_t', 'x', 'y', 'scene', 'step', 'step_id', 'action', 'target', 'bbox_x', 'bbox_y', 'bbox_w', 'bbox_h', 'page'])];
  for (const d of data) {
    const sc = d.clip.source.scale;
    const seq = sequenceStartOf(plan, d.clip);
    for (const k of d.clicks) {
      rows.push(
        csvLine([
          d.file,
          k.f,
          round4(k.f / plan.fps),
          round4((seq + k.f) / plan.fps),
          k.t,
          k.x !== undefined ? round2(k.x * sc) : '',
          k.y !== undefined ? round2(k.y * sc) : '',
          k.scene,
          k.step,
          k.step_id ?? '',
          k.action,
          k.target ?? '',
          k.bbox ? round2(k.bbox.x * sc) : '',
          k.bbox ? round2(k.bbox.y * sc) : '',
          k.bbox ? round2(k.bbox.w * sc) : '',
          k.bbox ? round2(k.bbox.h * sc) : '',
          k.page ?? '',
        ]),
      );
    }
  }
  return rows.join('\n') + '\n';
}

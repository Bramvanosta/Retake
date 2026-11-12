/**
 * L5.12a: the timeline's pieces (R4-Edit) — `Track` (a labelled row: a group named "Name: N items", its label column and
 * a lane of items placed by frame as percentages of the video, so the fit and the zoomed level are one layout at two
 * widths), `TrackItem` (an item of a lane: a span of frames or a tick at one frame — a button that carries its words;
 * pressed: the selection fill and a 2 px ring; a band at its start for a transition or a camera ramp; a tip beside a tick
 * that its focus shows too), `Scrubber` (the playhead's range input on the lane, with time labels under it) and
 * `Playhead` (the line over the lanes: drawn apart from them, so a playing preview re-renders no item).
 * L5.12a fixes (review A-L3): every item is a 24 px target — 24 px tall, a span narrower than 24 px has a 24 px hit area
 * centred on it, a tick is 24 px wide — and the ticks of a lane keep 24 px between them where the lane has room (nudged
 * apart by `spaceTicks` as the lane's width changes: the fit and the zoomed level); a lane too crowded keeps them on their
 * frames (Zoom in spreads them, ← → reach each).
 */
import { useLayoutEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { plural, shown, visibleControls } from '../bits.js';
import { hrefTo } from '../route.js';
import type { Route } from '../route.js';

/** Left and width of a span of frames, as percentages of the video. */
export function spanStyle(from: number, to: number, frames: number): CSSProperties {
  const n = Math.max(1, frames);
  const a = Math.min(Math.max(0, from), n);
  const b = Math.min(Math.max(a, to), n);
  return { left: `${(a / n) * 100}%`, width: `${((b - a) / n) * 100}%` };
}

/** The left of one frame, as a percentage of the video. */
export function tickStyle(frame: number, frames: number): CSSProperties {
  return { left: `${(Math.min(Math.max(0, frame), frames) / Math.max(1, frames)) * 100}%` };
}

/** The least distance between two targets (WCAG 2.5.8). */
export const TARGET_PX = 24;

/**
 * Tick centres (px, in order) moved apart to keep `gap` between them inside [0, width] — the least moves left to right,
 * then back from the end; unchanged when they cannot all fit.
 */
export function spaceTicks(xs: readonly number[], width: number, gap = TARGET_PX): number[] {
  const n = xs.length;
  const out = [...xs];
  if (n < 2 || (n - 1) * gap > width) return out;
  for (let i = 1; i < n; i++) out[i] = Math.max(out[i], out[i - 1] + gap);
  if (out[n - 1] > width) {
    out[n - 1] = width;
    for (let i = n - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - gap);
  }
  return out;
}

/** Nudge a lane's ticks apart (their left stays the frame's; a margin moves the target). */
function spaceLane(lane: HTMLElement): void {
  const ticks = [...lane.querySelectorAll<HTMLElement>(':scope > .k-trackitem.is-tick')];
  const w = lane.clientWidth;
  const xs = ticks.map((t) => (parseFloat(t.style.left) / 100) * w);
  const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const spaced = spaceTicks(
    order.map((i) => xs[i]),
    w,
  );
  order.forEach((i, k) => {
    const d = spaced[k] - xs[i];
    ticks[i].style.marginLeft = Math.abs(d) < 0.5 ? '' : `${d.toFixed(1)}px`;
  });
}

export function Track({ name, testId, count, children }: { name: string; testId: string; count: number; children: ReactNode }) {
  const lane = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const ul = lane.current;
    if (!ul || !ul.querySelector(':scope > .k-trackitem.is-tick')) return;
    spaceLane(ul);
    const ro = new ResizeObserver(() => spaceLane(ul));
    ro.observe(ul);
    return () => ro.disconnect();
  });
  return (
    <div className="k-track" role="group" aria-label={visibleControls(`${name}: ${plural(count, 'item')}`)} data-testid={testId}>
      <span className="k-track-label" aria-hidden="true">
        {shown(name)}
      </span>
      <ul className="k-track-lane" ref={lane}>
        {shown(children)}
      </ul>
    </div>
  );
}

export type TrackItemVariant = 'segment' | 'caption' | 'step' | 'camera' | 'speed' | 'cut' | 'marker' | 'pin';

export interface TrackItemProps {
  variant: TrackItemVariant;
  /** A span (from, to) or a tick (at). */
  place: { from: number; to: number } | { at: number };
  frames: number;
  /** Its words (kind, label, times): the button's name. */
  label: string;
  /** A tooltip (the same words, or the text alone). */
  title?: string;
  /** States drawn by the variant (`missing`, `joined`, `still`, `held`, `fast`, `open`, `resolved`, a reason…). */
  states?: string[];
  pressed?: boolean;
  /** A band at the item's start, as a fraction of its width (a transition into it, a camera ramp), under its words. */
  band?: number;
  /** Shown beside a tick on hover and focus (a pin's thread, with its link). */
  tip?: ReactNode;
  testId: string;
  /** Data attributes kept for tests and styles (`id`, `from`, `key`, `at`, `frame`, `status`). */
  data?: Partial<Record<'id' | 'from' | 'key' | 'at' | 'frame' | 'status', string | number>>;
  /** Its action — or, L5.12b, `to`: a tick that opens another screen is a link (a comment's pin opens its thread). */
  onActivate?: () => void;
  to?: Route;
  children: ReactNode;
}

export function TrackItem({ variant, place, frames, label, title, states, pressed, band, tip, testId, data, onActivate, to, children }: TrackItemProps) {
  const tick = 'at' in place;
  const cls = ['k-trackitem', `k-trackitem-${variant}`, tick ? 'is-tick' : 'is-span', pressed ? 'is-pressed' : '', ...(states ?? []).map((s) => `is-${s}`)].filter(Boolean).join(' ');
  const bandNode = band !== undefined && band > 0 ? <span className="k-trackitem-band" aria-hidden="true" style={{ width: `${Math.min(1, band) * 100}%` }} /> : null;
  const style = tick ? tickStyle(place.at, frames) : spanStyle(place.from, place.to, frames);
  if (to) {
    return (
      <li className={cls} style={style}>
        <a
          href={hrefTo(to)}
          className="k-trackitem-button"
          data-testid={testId}
          data-id={data?.id}
          data-frame={data?.frame}
          data-status={data?.status}
          aria-label={visibleControls(label)}
          title={title === undefined ? undefined : visibleControls(title)}
        >
          {shown(bandNode)}
          <span className="k-trackitem-text">{shown(children)}</span>
        </a>
        {tip !== undefined && <span className="k-trackitem-tip">{shown(tip)}</span>}
      </li>
    );
  }
  return (
    <li className={cls} style={style}>
      <button
        type="button"
        className="k-trackitem-button"
        data-testid={testId}
        data-id={data?.id}
        data-from={data?.from}
        data-key={data?.key}
        data-at={data?.at}
        data-frame={data?.frame}
        data-status={data?.status}
        aria-label={visibleControls(label)}
        aria-pressed={pressed === undefined ? undefined : pressed}
        title={title === undefined ? undefined : visibleControls(title)}
        onClick={onActivate}
      >
        {shown(bandNode)}
        <span className="k-trackitem-text">{shown(children)}</span>
      </button>
      {tip !== undefined && <span className="k-trackitem-tip">{shown(tip)}</span>}
    </li>
  );
}

/** The playhead's range input on its lane (its own arrows move one frame), time labels under it (decorative). */
export function Scrubber({
  time,
  max,
  value,
  valueText,
  onChange,
  marks,
  testId,
  label = 'Playhead',
}: {
  time: string;
  max: number;
  value: number;
  valueText: string;
  onChange: (frame: number) => void;
  marks?: Array<{ at: number; label: string }>;
  testId?: string;
  /** L5.12b: its name (the comments viewer's "Frame"). */
  label?: string;
}) {
  return (
    <div className="k-track k-scrub">
      <span className="k-track-label k-mono" aria-hidden="true">
        {shown(time)}
      </span>
      <div className="k-track-lane k-scrub-lane">
        <input
          type="range"
          className="k-scrubber"
          data-testid={testId}
          min={0}
          max={max}
          step={1}
          value={value}
          aria-label={visibleControls(label)}
          aria-valuetext={visibleControls(valueText)}
          onChange={(e) => onChange(Number(e.currentTarget.value))}
        />
        {marks && marks.length > 0 && (
          <span className="k-scrub-marks" aria-hidden="true">
            {marks.map((m) => (
              <span key={m.label} className="k-scrub-mark k-mono" style={{ left: `${Math.min(1, Math.max(0, m.at)) * 100}%` }}>
                {shown(m.label)}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

/** The playhead over the lanes (a fraction of the video), offset by the label column. */
export function Playhead({ at, testId }: { at: number; testId?: string }) {
  return (
    <div className="k-playhead-layer" aria-hidden="true">
      <div className="k-playhead" data-testid={testId} style={{ left: `${Math.min(1, Math.max(0, at)) * 100}%` }} />
    </div>
  );
}

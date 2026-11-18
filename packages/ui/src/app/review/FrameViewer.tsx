/**
 * One render's frames (R4-Comments' centre) — made by the server (`render_frame`: exact, any render, any browser; no
 * video plays in the page): the frame sized by the render's own aspect ratio (the pointer maths use this box — the
 * picture itself, no letterbox) with the region over it (the kit's RegionOverlay), a slider, ◀ / ▶ one frame and ± one
 * second, a typed time (the CLI's `--at` rule), the render's markers and the threads made on it as ticks on one lane (a
 * marker seeks, a pin is a link to its thread); ← → one frame, Shift one second (never while typing, never doubling the
 * slider's own arrows).
 * - Frames: one request in flight, the newest wins, a 429 backs off, a 503 is retried once, a 409 `cancelled` is ignored
 *   (FrameRequests, comment-words.ts); one random session id per tab (the server drops the older asks of a session).
 * - Drawing (`drawing`): a drag on the frame draws a region (pointer capture, Esc cancels, a new drag replaces it, a
 *   click makes none; a cancelled pointer — a system gesture, a lost capture — cancels like Esc) — the one pointer
 *   surface here (named in the real-controls lint's exceptions); its keyboard alternative is the composer's four %
 *   fields (WCAG 2.5.7).
 * - The picture's alt names the frame it shows (not the one asked for); one status line, always there, says a frame that
 *   is slow to come ("Loading frame N…", after a pause: never once per arrow press).
 * - The arrows never move the frame behind an open modal (the palette, a sheet).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { renderFrame, useRenderOutline } from '../data/renders.js';
import type { FrameAnswer, Outline } from '../data/ops.js';
import { Txt } from '../bits.js';
import { FrameRequests, frameTime, newSessionId, renderWords } from '../words/comment-words.js';
import type { FrameAsk, Region } from '../words/comment-words.js';
import { Jpeg } from '../Thumb.js';
import { SHEET_DATA_MAX } from '../thumbs.js';
import { Callout, RegionOverlay, Scrubber } from '../ui-kit/index.js';
import { ToolsNeeded } from '../shell/tools-parts.js';
import { useRegionDrag } from './region-drag.js';
import { FrameControls, ViewerTicks, useViewerKeys } from './viewer-controls.js';

/** This tab's render_frame session: its newest request of a render wins on the server. */
const SESSION = newSessionId();
/** How long a frame may take before the status line says it is loading (ms). */
const STALE_SAY_MS = 600;

/** The render the viewer shows, as the page read it (a reused id is another render: created_at). */
export interface Shown {
  render_id: string;
  created_at: string;
}

/** The frames: one request in flight, the newest wins (FrameRequests); a 409 says the render was replaced. */
function useFrameImage(slug: string, onReplaced: () => void, want: { o: Outline | null; frame: number; last: number; shown: Shown }) {
  const { o, frame, last, shown } = want;
  const [image, setImage] = useState<FrameAnswer | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const requests = useRef<FrameRequests<FrameAnswer> | null>(null);
  const replaced = useRef(onReplaced);
  replaced.current = onReplaced;
  useEffect(() => {
    const r = new FrameRequests<FrameAnswer>({
      fetch: (ask: FrameAsk, signal) => renderFrame({ project: slug, render_id: ask.render_id, created_at: ask.created_at, frame: ask.frame, session: SESSION }, { signal }),
      onResult: (res) => {
        if (res.ok) {
          setImage(res.data);
          setFrameError(null);
        } else if (res.error.code !== 'cancelled') {
          setFrameError(res.error.message);
          if (res.error.status === 409) replaced.current();
        }
      },
    });
    requests.current = r;
    return () => {
      r.close();
      requests.current = null;
    };
  }, [slug]);
  useEffect(() => {
    if (!o || frame > last) return;
    requests.current?.want({ render_id: shown.render_id, created_at: shown.created_at, frame });
  }, [o, frame, last, shown.render_id, shown.created_at]);
  return { image, frameError };
}

export function FrameViewer(p: {
  slug: string;
  name: string;
  shown: Shown;
  frame: number;
  setFrame: (f: number) => void;
  drawing: boolean;
  region: Region | null;
  setRegion: (r: Region | null) => void;
  regionLabel: string;
  tick: number;
  onReplaced: () => void;
  /** The outline is read (the frame's box has its size): the composer may bring itself into view. */
  onLaidOut?: () => void;
}) {
  const { slug, shown, frame, setFrame } = p;
  const [outline, reloadOutline] = useRenderOutline({ project: slug, render_id: shown.render_id, created_at: shown.created_at }, `${slug}\0${shown.render_id}\0${shown.created_at}`);
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` (a comments event) is the trigger to read the outline again
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reloadOutline();
  }, [p.tick, reloadOutline]);
  const o = outline.state === 'ready' ? outline.data : null;
  const laidOut = useRef(p.onLaidOut);
  laidOut.current = p.onLaidOut;
  useEffect(() => {
    if (outline.state === 'ready') laidOut.current?.();
  }, [outline.state]);
  const last = o ? Math.max(0, o.frames - 1) : 0;
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const go = useCallback((f: number) => setFrame(Math.min(last, Math.max(0, Math.round(f)))), [last, setFrame]);
  // Inside the render once its length is known.
  useEffect(() => {
    if (o && frame > last) setFrame(last);
  }, [o, frame, last, setFrame]);

  const { image, frameError } = useFrameImage(slug, p.onReplaced, { o, frame, last, shown });

  // ← / → one frame, Shift one second (never while typing, never doubling the slider's own arrows).
  useViewerKeys(o, go, frameRef);

  const [time, setTime] = useState('');
  const [timeError, setTimeError] = useState<string | null>(null);
  const timeId = useId();

  if (outline.state === 'loading') {
    return (
      <p className="cm-quiet" role="status">
        Loading the render…
      </p>
    );
  }
  if (outline.state === 'error') {
    return (
      <Callout state="fail" role="alert" title="This render cannot be shown">
        <p className="cm-pre" data-testid="outline-error">
          <Txt text={outline.error} />
        </p>
      </Callout>
    );
  }
  const d = outline.data;
  const ticks = d.markers.length + d.pins.length;
  return (
    <div className="cm-viewer" data-testid="viewer" data-render={d.render_id} data-variant={d.variant} data-frame={frame} data-shown={image ? image.frame : ''}>
      {/* A frame is rendered again to be commented (render_frame): the render tools. */}
      <ToolsNeeded need="render" what="Showing a frame to comment" testId="frame-tools" />
      <FramePicture o={d} image={image} frame={frame} drawing={p.drawing} region={p.region} setRegion={p.setRegion} regionLabel={p.regionLabel} />
      {frameError && (
        <p className="cm-pre cm-error" role="alert" data-testid="frame-error">
          <Txt text={frameError} />
        </p>
      )}
      <div className="cm-lanes">
        <Scrubber
          label="Frame"
          testId="frame-slider"
          time={frameTime(frame, d.fps)}
          max={last}
          value={Math.min(frame, last)}
          valueText={`frame ${frame.toLocaleString('en')}, ${frameTime(frame, d.fps)}`}
          onChange={go}
        />
        {ticks > 0 && <ViewerTicks d={d} ticks={ticks} slug={slug} name={p.name} go={go} />}
      </div>
      <FrameControls d={d} frame={frame} go={go} time={time} setTime={setTime} timeError={timeError} setTimeError={setTimeError} timeId={timeId} />
      <p className="cm-quiet">
        <Txt text={`← → one frame · Shift + ← → one second · ${d.width}×${d.height}, ${d.fps} fps${d.variant !== 'landscape' ? `, ${d.variant}` : ''}`} />
      </p>
    </div>
  );
}

/**
 * The frame, sized by the render's own aspect ratio, with the region drawn over it; a drag draws a new region when
 * `drawing` (the pointer surface: its keyboard alternative is the composer's four % fields).
 */
function FramePicture(p: { o: Outline; image: FrameAnswer | null; frame: number; drawing: boolean; region: Region | null; setRegion: (r: Region | null) => void; regionLabel: string }) {
  const { box, draft, onDown, onMove, onUp, onCancel } = useRegionDrag({ drawing: p.drawing, image: p.image, region: p.region, setRegion: p.setRegion });
  const shownRegion = draft ?? p.region;
  const { width: w, height: h } = p.o;
  // The one status line: a frame slow to come is said after a pause (never once per arrow press); the first picture too.
  const stale = p.image !== null && p.image.frame !== p.frame;
  const [slow, setSlow] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new frame asked restarts the pause before "loading" is said
  useEffect(() => {
    setSlow(false);
    if (!stale) return;
    const t = setTimeout(() => setSlow(true), STALE_SAY_MS);
    return () => clearTimeout(t);
  }, [stale, p.frame]);
  const status = !p.image ? 'Loading the frame…' : stale && slow ? `Loading frame ${p.frame.toLocaleString('en')}…` : '';
  return (
    <div
      ref={box}
      className={p.drawing ? 'cm-frame is-drawing' : 'cm-frame'}
      data-testid="viewer-frame"
      style={{ aspectRatio: `${w} / ${h}`, width: `min(100%, calc(58vh * ${w} / ${h}))` }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
    >
      {p.image ? (
        <Jpeg
          base64={p.image.base64}
          max={SHEET_DATA_MAX}
          width={p.image.width}
          height={p.image.height}
          alt={`Frame ${p.image.frame.toLocaleString('en')} of ${renderWords(p.o.render_id)} (${frameTime(p.image.frame, p.o.fps)})`}
        />
      ) : (
        <span className="cm-frame-note" aria-hidden="true">
          Loading the frame…
        </span>
      )}
      {stale && (
        <span className="cm-frame-stale" aria-hidden="true">
          <Txt text={`Loading frame ${p.frame.toLocaleString('en')}…`} />
        </span>
      )}
      <span className="k-sr" role="status" data-testid="viewer-status">
        <Txt text={status} />
      </span>
      {shownRegion && <RegionOverlay region={shownRegion} label={p.regionLabel} draft={draft !== null} testId="viewer-region" />}
    </div>
  );
}

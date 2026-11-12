/**
 * One render's frames (L4.6 part D1; L5.12b « Épure » 4b, R4-Comments' centre: was CommentsScreen.tsx's Viewer and
 * FrameView) — made by the server (`render_frame`: exact, any render, any browser; no video plays in the page): the
 * frame sized by the render's own aspect ratio (the pointer maths use this box — the picture itself, no letterbox) with
 * the region over it (the kit's RegionOverlay), a slider, ◀ / ▶ one frame and ± one second, a typed time (the CLI's
 * `--at` rule), the render's markers and the threads made on it as ticks on one lane (a marker seeks, a pin is a link
 * to its thread); ← → one frame, Shift one second (never while typing, never doubling the slider's own arrows).
 * - Frames: one request in flight, the newest wins, a 429 backs off, a 503 is retried once, a 409 `cancelled` is ignored
 *   (FrameRequests, comment-words.ts); one random session id per tab (the server drops the older asks of a session).
 * - Drawing (`drawing`): a drag on the frame draws a region (pointer capture, Esc cancels, a new drag replaces it, a
 *   click makes none; a cancelled pointer — a system gesture, a lost capture — cancels like Esc: review A-L4) — the one
 *   pointer surface here (named in the real-controls lint's exceptions); its keyboard alternative is the composer's four %
 *   fields (WCAG 2.5.7).
 * - The picture's alt names the frame it shows (not the one asked for); one status line, always there, says a frame that
 *   is slow to come ("Loading frame N…", after a pause: never once per arrow press) — review A-L5.
 * - The arrows never move the frame behind an open modal (the palette, a sheet: review A-L9).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { renderFrame, useRenderOutline } from '../data/renders.js';
import type { FrameAnswer, Outline } from '../data/ops.js';
import { Txt } from '../bits.js';
import { FrameRequests, frameTime, newSessionId, parseTimecode, pointIn, regionOfDrag, renderWords, timeExample, viewerKey } from '../words/comment-words.js';
import type { FrameAsk, Region } from '../words/comment-words.js';
import { Jpeg } from '../Thumb.js';
import { SHEET_DATA_MAX } from '../thumbs.js';
import type { KeyTarget } from '../words/timeline-words.js';
import { Button, Callout, RegionOverlay, Scrubber, TextField, Track, TrackItem, modalOpen } from '../ui-kit/index.js';

/** This tab's render_frame session: its newest request of a render wins on the server. */
const SESSION = newSessionId();
/** How long a frame may take before the status line says it is loading (ms). */
const STALE_SAY_MS = 600;

/** The render the viewer shows, as the page read it (a reused id is another render: created_at). */
export interface Shown {
  render_id: string;
  created_at: string;
}

function keyTarget(t: EventTarget | null): KeyTarget {
  const el = t instanceof Element ? t : null;
  return {
    tag: el?.tagName ?? 'body',
    ...(el instanceof HTMLInputElement ? { type: el.type } : {}),
    ...(el instanceof HTMLElement && el.isContentEditable ? { editable: true } : {}),
    ...(el?.closest('[role="radiogroup"]') ? { inRadioGroup: true } : {}),
  };
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

  // The frames: one request in flight, the newest wins (FrameRequests).
  const [image, setImage] = useState<FrameAnswer | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const requests = useRef<FrameRequests<FrameAnswer> | null>(null);
  const replaced = useRef(p.onReplaced);
  replaced.current = p.onReplaced;
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

  // ← / → one frame, Shift one second (never while typing, never doubling the slider's own arrows).
  useEffect(() => {
    if (!o) return;
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen()) return;
      const by = viewerKey(e, keyTarget(e.target), o.fps);
      if (by === null) return;
      e.preventDefault();
      go(frameRef.current + by);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [o, go]);

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
      <FramePicture o={d} image={image} frame={frame} drawing={p.drawing} region={p.region} setRegion={p.setRegion} regionLabel={p.regionLabel} />
      {frameError && (
        <p className="cm-pre cm-error" role="alert" data-testid="frame-error">
          <Txt text={frameError} />
        </p>
      )}
      <div className="cm-lanes">
        <Scrubber label="Frame" testId="frame-slider" time={frameTime(frame, d.fps)} max={last} value={Math.min(frame, last)} valueText={`frame ${frame.toLocaleString('en')}, ${frameTime(frame, d.fps)}`} onChange={go} />
        {ticks > 0 && (
          <Track name="Marks & pins" testId="viewer-ticks" count={ticks}>
            {d.markers.map((k, i) => {
              const words = `Marker ${d.untrusted.markers[i] ?? ''} at ${frameTime(k.frame, d.fps)}`;
              return (
                <TrackItem key={`m${i}`} variant="marker" place={{ at: k.frame }} frames={d.frames} label={words} title={words} testId="viewer-marker" data={{ frame: k.frame }} onActivate={() => go(k.frame)}>
                  <span aria-hidden="true">◆</span>
                </TrackItem>
              );
            })}
            {d.pins.map((pin) => {
              const words = `Comment, ${pin.status}, at ${frameTime(pin.frame, d.fps)}: open the thread`;
              return (
                <TrackItem key={pin.id} variant="pin" place={{ at: pin.frame }} frames={d.frames} label={words} title={words} states={[pin.status]} testId="viewer-pin" data={{ id: pin.id, frame: pin.frame, status: pin.status }} to={{ name: 'comments', slug, scenario: p.name, thread: pin.id }}>
                  <span aria-hidden="true">{pin.status === 'open' ? '●' : '○'}</span>
                </TrackItem>
              );
            })}
          </Track>
        )}
      </div>
      <div className="cm-controls" role="group" aria-label="Frame controls">
        <Button size="sm" aria-label="Back one second" onClick={() => go(frame - Math.round(d.fps))}>
          −1 s
        </Button>
        <Button size="sm" icon="chevron-left" aria-label="Previous frame" data-testid="viewer-prev" onClick={() => go(frame - 1)}>
          Frame
        </Button>
        <Button size="sm" icon="chevron-right" aria-label="Next frame" data-testid="viewer-next" onClick={() => go(frame + 1)}>
          Frame
        </Button>
        <Button size="sm" aria-label="Forward one second" onClick={() => go(frame + Math.round(d.fps))}>
          +1 s
        </Button>
        <output className="cm-time k-mono" data-testid="viewer-time" aria-live="off">
          <Txt text={`${frameTime(frame, d.fps)} / ${frameTime(d.frames, d.fps)} · frame ${frame.toLocaleString('en')} of ${d.frames.toLocaleString('en')}`} />
        </output>
        <form
          className="cm-goto"
          onSubmit={(e) => {
            e.preventDefault();
            const r = parseTimecode(time, d.fps, d.frames);
            if ('error' in r) setTimeError(r.error);
            else {
              setTimeError(null);
              go(r.frame);
            }
          }}
        >
          <TextField id={timeId} label="Go to a time" labelHidden layout="inline" inputMode="decimal" placeholder={timeExample(d.frames, d.fps)} value={time} onChange={setTime} unsaved={null} error={timeError ?? undefined} testId="viewer-time-input" autoComplete="off" spellCheck={false} />
          <Button size="sm" submit>
            Go
          </Button>
        </form>
      </div>
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
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; from: { x: number; y: number }; before: Region | null } | null>(null);
  const [draft, setDraft] = useState<Region | null>(null);
  const [dragging, setDragging] = useState(false);
  const { setRegion } = p;
  // Esc cancels a drag (the region before it stays).
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !drag.current) return;
      e.preventDefault();
      const el = box.current;
      if (el?.hasPointerCapture(drag.current.id)) el.releasePointerCapture(drag.current.id);
      drag.current = null;
      setDraft(null);
      setDragging(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragging]);
  const rect = () => box.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!p.drawing || !p.image || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, from: pointIn(rect(), e.clientX, e.clientY), before: p.region };
    setDraft(null);
    setDragging(true);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setDraft(regionOfDrag(d.from, pointIn(rect(), e.clientX, e.clientY)));
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    setDraft(null);
    // A click (no drag) makes no region: the one before stays.
    const r = regionOfDrag(d.from, pointIn(rect(), e.clientX, e.clientY));
    if (r) setRegion(r);
  };
  // A cancelled pointer (a system gesture took it, the capture was lost) cancels like Esc: the region before it stays.
  const onCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDraft(null);
    setDragging(false);
  };
  const shownRegion = draft ?? p.region;
  const { width: w, height: h } = p.o;
  // The one status line: a frame slow to come is said after a pause (never once per arrow press); the first picture too.
  const stale = p.image !== null && p.image.frame !== p.frame;
  const [slow, setSlow] = useState(false);
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
        <Jpeg base64={p.image.base64} max={SHEET_DATA_MAX} width={p.image.width} height={p.image.height} alt={`Frame ${p.image.frame.toLocaleString('en')} of ${renderWords(p.o.render_id)} (${frameTime(p.image.frame, p.o.fps)})`} />
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

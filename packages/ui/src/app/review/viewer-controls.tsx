/**
 * The frame viewer's lanes and controls as they are drawn: the render's markers and the threads' pins on one lane, the
 * frame buttons, the time shown and the Go to a time form; and the viewer's keys (← → one frame, Shift one second, never
 * while typing, never doubling the slider's own arrows, never behind an open modal).
 */
import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Outline } from '../data/ops.js';
import { Txt } from '../bits.js';
import { frameTime, parseTimecode, timeExample, viewerKey } from '../words/comment-words.js';
import type { KeyTarget } from '../words/timeline-words.js';
import { Button, TextField, Track, TrackItem, modalOpen } from '../ui-kit/index.js';

function keyTarget(t: EventTarget | null): KeyTarget {
  const el = t instanceof Element ? t : null;
  return {
    tag: el?.tagName ?? 'body',
    ...(el instanceof HTMLInputElement ? { type: el.type } : {}),
    ...(el instanceof HTMLElement && el.isContentEditable ? { editable: true } : {}),
    ...(el?.closest('[role="radiogroup"]') ? { inRadioGroup: true } : {}),
  };
}

/** ← / → one frame, Shift one second (never while typing, never doubling the slider's own arrows). */
export function useViewerKeys(o: Outline | null, go: (f: number) => void, frameRef: { current: number }) {
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
  }, [o, go, frameRef]);
}

/** The render's markers (each seeks) and the threads made on it (each a link to its thread), as ticks on one lane. */
export function ViewerTicks({ d, ticks, slug, name, go }: { d: Outline; ticks: number; slug: string; name: string; go: (f: number) => void }) {
  return (
    <Track name="Marks & pins" testId="viewer-ticks" count={ticks}>
      {d.markers.map((k, i) => {
        const words = `Marker ${d.untrusted.markers[i] ?? ''} at ${frameTime(k.frame, d.fps)}`;
        return (
          <TrackItem
            // biome-ignore lint/suspicious/noArrayIndexKey: markers in render order, the index also reads their names (untrusted.markers[i]): the index is the marker
            key={`m${i}`}
            variant="marker"
            place={{ at: k.frame }}
            frames={d.frames}
            label={words}
            title={words}
            testId="viewer-marker"
            data={{ frame: k.frame }}
            onActivate={() => go(k.frame)}
          >
            <span aria-hidden="true">◆</span>
          </TrackItem>
        );
      })}
      {d.pins.map((pin) => {
        const words = `Comment, ${pin.status}, at ${frameTime(pin.frame, d.fps)}: open the thread`;
        return (
          <TrackItem
            key={pin.id}
            variant="pin"
            place={{ at: pin.frame }}
            frames={d.frames}
            label={words}
            title={words}
            states={[pin.status]}
            testId="viewer-pin"
            data={{ id: pin.id, frame: pin.frame, status: pin.status }}
            to={{ name: 'comments', slug, scenario: name, thread: pin.id }}
          >
            <span aria-hidden="true">{pin.status === 'open' ? '●' : '○'}</span>
          </TrackItem>
        );
      })}
    </Track>
  );
}

/** ◀ / ▶ one frame and ± one second, the time shown, and Go to a time (the CLI's `--at` rule). */
export function FrameControls({
  d,
  frame,
  go,
  time,
  setTime,
  timeError,
  setTimeError,
  timeId,
}: {
  d: Outline;
  frame: number;
  go: (f: number) => void;
  time: string;
  setTime: (t: string) => void;
  timeError: string | null;
  setTimeError: Dispatch<SetStateAction<string | null>>;
  timeId: string;
}) {
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a toolbar-like row of frame buttons; <fieldset> would bring its own border, padding and min-width */}
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
          <TextField
            id={timeId}
            label="Go to a time"
            labelHidden
            layout="inline"
            inputMode="decimal"
            placeholder={timeExample(d.frames, d.fps)}
            value={time}
            onChange={setTime}
            unsaved={null}
            error={timeError ?? undefined}
            testId="viewer-time-input"
            autoComplete="off"
            spellCheck={false}
          />
          <Button size="sm" submit>
            Go
          </Button>
        </form>
      </div>
    </>
  );
}

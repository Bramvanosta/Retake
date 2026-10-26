/**
 * The live picture of a run (L4.4, R-UI-16): the page the run acts on, as the worker's live channel sends it (≤ 960
 * px, ≤ 10 fps), drawn on a canvas — the JPEG decoded from bytes in memory by `ImageDecoder` where the browser has it
 * (WebCodecs: the bytes go to the decoder as they are), else by `createImageBitmap` of a Blob (review A: a browser may
 * keep a Blob's bytes in its blob storage, on disk under memory pressure — a 50 KB frame stays in memory in practice):
 * no image address (no `src=`, no blob: or object URL — the source lint allows both decoders in this file only),
 * nothing stored.
 * The box keeps a fixed aspect and the canvas a fixed size: the picture is letterboxed — scaled to fit, centred, the
 * bands dark — for the frame size it is laid out for. A new width lays it out again at once (another page, another
 * viewport); a new height of the same width only after SETTLE_FRAMES frames in a row: the screencast mixes heights of
 * one width (e.g. 960×471 with, now and then, a 960×540 frame), and a frame of another height is drawn at the
 * current place and scale (its top where the picture's top is) rather than making the picture jump (run-live.ts
 * `nextLayout`, `placeFrame`). Nothing is ever resized. Latest-only: while one frame decodes, a newer one replaces
 * the one waiting.
 *
 * The picture is ON by default for a dry run and OFF for a capture (it costs Chromium CPU during the take); the toggle
 * says so. It is a picture for the eye only: the canvas has a label, its state is said in words next to it, and it is
 * not a live region (a frame is not news).
 */
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import { LIVE_BOX, nextLayout, placeFrame } from './run-live.js';
import type { LiveFrame, PictureState, Size } from './run-live.js';
import { Txt } from './bits.js';

/** The canvas's drawing size: a 16:9 box. */
const { w: W, h: H } = LIVE_BOX;

export interface LiveViewHandle {
  draw(f: LiveFrame): void;
  clear(): void;
}

const STATE_WORDS: Record<PictureState, string> = {
  off: 'Live picture hidden',
  none: 'No live picture.',
  waiting: 'Waiting for the first picture of the page…',
  live: 'Live: the page the run is acting on, as it happens. Not recorded.',
  busy: 'The live picture is not available here.',
  ended: 'The run ended: no more pictures (the last one it showed stays here).',
};

/** base64 → bytes (the frame's JPEG; checked by the server: FF D8 FF, ≤ 512 KiB). */
function bytesOf(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.length >= 3 && out[0] === 0xff && out[1] === 0xd8 && out[2] === 0xff ? out : null;
  } catch {
    return null;
  }
}

/** A decoded frame, drawn then released. */
interface Decoded {
  image: CanvasImageSource;
  release(): void;
}

/** WebCodecs' ImageDecoder (Chromium), as far as this file uses it. */
type ImageDecoderLike = new (init: { data: Uint8Array<ArrayBuffer>; type: string }) => { decode(): Promise<{ image: CanvasImageSource & { close(): void } }>; close(): void };

async function decodeJpeg(bytes: Uint8Array<ArrayBuffer>): Promise<Decoded> {
  const Decoder = (globalThis as { ImageDecoder?: ImageDecoderLike }).ImageDecoder;
  if (Decoder) {
    try {
      const d = new Decoder({ data: bytes, type: 'image/jpeg' });
      const { image } = await d.decode();
      return {
        image,
        release: () => {
          image.close();
          d.close();
        },
      };
    } catch {
      /* not decoded this way: the Blob below */
    }
  }
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  return { image: bitmap, release: () => bitmap.close() };
}

interface Props {
  /** What the server says the picture is doing (null: not known yet). */
  picture: { state: PictureState; why?: string } | null;
  /** The picture is shown (the person's choice, else the default for the run's mode). */
  shown: boolean;
  /** The run is a capture (the toggle says what the picture costs). */
  capture: boolean;
  /** null: the toggle is not offered (a terminal's run, an ended run, the stream refused). */
  onToggle: (() => void) | null;
  /** Why there is no picture, when the screen knows better than the stream (refused stream). */
  note?: string;
}

export const LiveView = forwardRef<LiveViewHandle, Props>(function LiveView({ picture, shown, capture, onToggle, note }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const decoding = useRef(false);
  const waiting = useRef<LiveFrame | null>(null);
  const drawn = useRef(0);
  /** The frame size the picture is laid out for, and the streak of frames of a new height. */
  const layout = useRef<Size | null>(null);
  const pending = useRef<Size & { n: number }>({ w: 0, h: 0, n: 0 });

  const paint = useCallback((image: CanvasImageSource, f: LiveFrame) => {
    const c = canvas.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    layout.current = nextLayout(layout.current, pending.current, f);
    const { x, y, dw, dh } = placeFrame(layout.current, f);
    g.fillStyle = '#16181d';
    g.fillRect(0, 0, W, H);
    g.drawImage(image, x, y, dw, dh);
    drawn.current++;
    // How many frames this canvas drew (the e2e reads it; dataset, not an attribute set outside React).
    c.dataset.frames = String(drawn.current);
  }, []);

  const decode = useCallback(
    (f: LiveFrame) => {
      const bytes = bytesOf(f.jpeg);
      if (!bytes) return;
      decoding.current = true;
      decodeJpeg(bytes)
        .then(
          (d) => {
            paint(d.image, f);
            d.release();
          },
          () => undefined,
        )
        .finally(() => {
          decoding.current = false;
          const next = waiting.current;
          waiting.current = null;
          if (next) decode(next);
        });
    },
    [paint],
  );

  useImperativeHandle(
    ref,
    () => ({
      draw(f) {
        if (decoding.current) waiting.current = f;
        else decode(f);
      },
      clear() {
        waiting.current = null;
        layout.current = null;
        pending.current = { w: 0, h: 0, n: 0 };
        const c = canvas.current;
        const g = c?.getContext('2d');
        if (c && g) g.clearRect(0, 0, W, H);
      },
    }),
    [decode],
  );

  // A picture that cannot come (a terminal's run, an ended run, refused) says so whatever the toggle.
  const fixed = picture?.state === 'none' || picture?.state === 'ended' || picture?.state === 'busy';
  const state: PictureState = !shown && !fixed ? 'off' : (picture?.state ?? 'waiting');
  const live = shown && state === 'live';
  return (
    <section className="card live-card" aria-labelledby="live-h">
      <div className="card-head">
        <h2 id="live-h" className="card-title">
          Live picture
        </h2>
        {onToggle && (
          <button type="button" className="button small" aria-pressed={shown} data-testid="picture-toggle" onClick={onToggle}>
            {shown ? 'Hide live picture' : 'Show live picture'}
          </button>
        )}
      </div>
      <div className={`live-box${live ? ' is-live' : ''}`} data-state={state}>
        <canvas ref={canvas} width={W} height={H} className="live-canvas" role="img" aria-label="Live picture of the page the run is acting on (not recorded)" data-testid="live-canvas" hidden={!shown} />
        {!live && (
          <p className="live-empty" data-testid="picture-state">
            {note ? <Txt text={note} /> : state === 'ended' && (!shown || drawn.current === 0) ? 'The run ended.' : STATE_WORDS[state]}
            {!note && picture?.why && state !== 'live' && state !== 'ended' && (
              <>
                {' — '}
                <Txt text={picture.why} />
              </>
            )}
          </p>
        )}
      </div>
      <p className="muted small" data-testid="picture-help">
        {live
          ? STATE_WORDS.live
          : capture
            ? 'A capture shows its live picture only when asked: drawing it costs Chromium CPU during the take.'
            : 'A dry run shows its live picture by default; hiding it stops the picture, not the run.'}{' '}
        The picture stops while this tab is hidden.
      </p>
    </section>
  );
});

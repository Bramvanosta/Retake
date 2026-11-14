/**
 * A step's picture from its run (L4.2): asked when its row comes on screen (one IntersectionObserver per screen, the
 * loader in thumbs.ts batches the keys), shown at a fixed size (no layout shift), with an `alt` built by the caller
 * from the scenario only — never from page text. While it loads, or when the run has none, a placeholder says so in
 * words.
 *
 * The app's ONE image source: `Picture`'s `src={url}` where `url` comes from `imageDataUrl` (a fixed prefix of the
 * format and a checked base64 payload, under the use's cap: a step picture's THUMB_DATA_MAX or, L4.5 part E, a review
 * contact sheet's SHEET_DATA_MAX — both JPEG, through `Jpeg`; L4.7, a library poster's POSTER_DATA_MAX (PNG) or loop's
 * LOOP_DATA_MAX (GIF), magic-checked) — the source lint test allows `src=` here only, in exactly this form.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { shown } from './bits.js';
import { THUMB_DATA_MAX, ThumbLoader, imageDataUrl, jpegDataUrl } from './thumbs.js';
import type { ImageCap, ImageFormat, MissingReason, ThumbEntry, ThumbFetch } from './thumbs.js';

/**
 * The sizes a picture is drawn at (L5.10a: a prop; L5.10b: the scenario's frames rebuilt — no row size left): a frame
 * (248 × 140: the storyboard's, 100 % of its column), a poster (the same: the Project screen's grid) and the
 * inspector's (280 × 158). The attributes give the box its ratio before the picture comes (no layout shift); the server
 * sends ≤ 480 px for 2× screens. The boxes' look is screens.css's (`th-*`).
 */
export type ThumbSize = 'frame' | 'poster' | 'inspector';
const SIZES: Record<ThumbSize, [number, number]> = { frame: [248, 140], poster: [248, 140], inspector: [280, 158] };

interface ThumbsCtx {
  loader: ThumbLoader;
  observe(el: Element, on: (visible: boolean) => void): () => void;
}

const Ctx = createContext<ThumbsCtx | null>(null);

/** One loader and one observer for a screen; everything stops when it unmounts. */
export function ThumbsProvider({ fetch, children }: { fetch: ThumbFetch; children: ReactNode }) {
  const value = useMemo<ThumbsCtx>(() => {
    const loader = new ThumbLoader({ fetch });
    const callbacks = new Map<Element, (visible: boolean) => void>();
    let io: IntersectionObserver | null = null;
    const observer = () =>
      (io ??= new IntersectionObserver(
        (entries) => {
          for (const e of entries) callbacks.get(e.target)?.(e.isIntersecting);
        },
        // L5.9: the shell's centre pane is the scroller — its margin, not the window's (the pane clips what is below).
        { root: document.getElementById('main'), rootMargin: '200px 0px' },
      ));
    return {
      loader,
      observe(el, on) {
        callbacks.set(el, on);
        observer().observe(el);
        return () => {
          callbacks.delete(el);
          io?.unobserve(el);
        };
      },
    };
    // The fetch closes over the project only: one loader per screen (the screen is keyed by project and scenario).
  }, []);
  useEffect(() => () => value.loader.close(), [value]);
  return <Ctx.Provider value={value}>{shown(children)}</Ctx.Provider>;
}

const REASON: Record<MissingReason, string> = {
  no_step: 'This step is not in the run',
  not_reached: 'Not reached in this run',
  no_picture: 'No picture kept for this step',
  unreadable: 'The picture cannot be read',
  too_large: 'The picture is too large to show',
  budget: 'Loading the picture…',
  cancelled: 'Loading the picture…',
  failed: 'The picture could not be loaded',
};

function useEntry(loader: ThumbLoader, run: string, key: string): ThumbEntry | undefined {
  return useSyncExternalStore(
    (fn) => loader.subscribe(run, key, fn),
    () => loader.get(run, key),
  );
}

/** The picture of the run's step `runKey` (the run's own key), or why there is none. */
export function Thumb({ run, runKey, alt, size = 'frame' }: { run: string; runKey: string; alt: string; size?: ThumbSize }) {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('Thumb outside ThumbsProvider');
  const box = useRef<HTMLDivElement>(null);
  const entry = useEntry(ctx.loader, run, runKey);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let visible = false;
    const stop = ctx.observe(el, (v) => {
      if (v === visible) return;
      visible = v;
      ctx.loader.setVisible(run, runKey, v);
    });
    return () => {
      stop();
      if (visible) ctx.loader.setVisible(run, runKey, false);
    };
  }, [ctx, run, runKey]);
  const ok = entry?.state === 'ok' && jpegDataUrl(entry.base64) !== null ? entry : null;
  return (
    <div ref={box} className="th-box" data-testid="thumb" data-size={size} data-state={ok ? 'ok' : entry?.state === 'missing' ? entry.reason : 'loading'}>
      {ok ? (
        <Jpeg base64={ok.base64} max={THUMB_DATA_MAX} width={SIZES[size][0]} height={SIZES[size][1]} alt={alt} />
      ) : (
        <span className="th-words">{shown(entry?.state === 'missing' ? REASON[entry.reason] : 'Loading the picture…')}</span>
      )}
    </div>
  );
}

/**
 * The app's one `<img>`: a base64 image from the server as a checked data: address (imageDataUrl of `format` under
 * `max`), or nothing when it does not pass. `format` and `max` are literals at every use (ImageFormat, ImageCap: the
 * lint checks), never values from data.
 */
export function Picture({
  format,
  base64,
  max,
  width,
  height,
  alt,
  className,
}: {
  format: ImageFormat;
  base64: string;
  max: ImageCap;
  width: number;
  height: number;
  alt: string;
  className?: string;
}) {
  const url = imageDataUrl(format, base64, max);
  if (!url) return null;
  return <img src={url} width={width} height={height} alt={alt} decoding="async" draggable={false} className={className} />;
}

/** A base64 JPEG (a step picture, a contact sheet) through the one `<img>`; `max` one of the two JPEG caps. */
export function Jpeg({ base64, max, width, height, alt }: { base64: string; max: ImageCap; width: number; height: number; alt: string }) {
  return <Picture format="jpeg" base64={base64} max={max} width={width} height={height} alt={alt} />;
}

/** The same box with words instead of a picture (a step the run cannot picture). */
export function NoThumb({ children, size = 'frame' }: { children: ReactNode; size?: ThumbSize }) {
  return (
    <div className="th-box th-none" data-testid="thumb" data-size={size} data-state="none">
      <span className="th-words">{shown(children)}</span>
    </div>
  );
}

/**
 * A step's picture from its run (L4.2): asked when its row comes on screen (one IntersectionObserver per screen, the
 * loader in thumbs.ts batches the keys), shown at a fixed size (no layout shift), with an `alt` built by the caller
 * from the scenario only — never from page text. While it loads, or when the run has none, a placeholder says so in
 * words.
 *
 * The app's ONE image source: `src={url}` where `url` comes from `jpegDataUrl` (the fixed `data:image/jpeg;base64,`
 * prefix and a checked base64 payload) — the source lint test allows `src=` here only, in exactly this form.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { ThumbLoader, jpegDataUrl } from './thumbs.js';
import type { MissingReason, ThumbEntry, ThumbFetch } from './thumbs.js';

/** The width and height a picture is shown at (CSS px); the server sends ≤ 480 px for 2× screens. */
export const THUMB_W = 160;
export const THUMB_H = 90;

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
        { rootMargin: '200px 0px' },
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
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
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
export function Thumb({ run, runKey, alt }: { run: string; runKey: string; alt: string }) {
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
  const url = entry?.state === 'ok' ? jpegDataUrl(entry.base64) : null;
  return (
    <div ref={box} className="thumb" data-testid="thumb" data-state={url ? 'ok' : (entry?.state === 'missing' ? entry.reason : 'loading')}>
      {url ? (
        <img src={url} width={THUMB_W} height={THUMB_H} alt={alt} decoding="async" draggable={false} />
      ) : (
        <span className="thumb-words">{entry?.state === 'missing' ? REASON[entry.reason] : 'Loading the picture…'}</span>
      )}
    </div>
  );
}

/** The same box with words instead of a picture (a step the run cannot picture). */
export function NoThumb({ children }: { children: ReactNode }) {
  return (
    <div className="thumb thumb-none" data-testid="thumb" data-state="none">
      <span className="thumb-words">{children}</span>
    </div>
  );
}

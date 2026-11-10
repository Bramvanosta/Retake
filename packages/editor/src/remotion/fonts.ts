/**
 * Theme fonts: registered with the FontFace API before anything is drawn (text fitting measures with the real
 * fonts), the render held with delayRender until they are loaded. In the Studio's preview (preview-mode.ts) a face that
 * fails is a warning and the text draws in the fallback font; a render stops (cancelRender).
 */
import { useEffect, useState } from 'react';
import { cancelRender, continueRender, delayRender } from './host.js';
import type { ThemeFontFace } from '@retake/components';
import { usePreviewMode } from './preview-mode.js';

const loaded = new Map<string, Promise<void>>();

function loadFace(face: ThemeFontFace): Promise<void> {
  const key = `${face.family}|${face.url}|${face.weight}|${face.style}`;
  let p = loaded.get(key);
  if (!p) {
    const ff = new FontFace(face.family, `url("${face.url}")`, { weight: String(face.weight), style: face.style });
    p = ff.load().then((f) => {
      document.fonts.add(f);
    });
    loaded.set(key, p);
  }
  return p;
}

/**
 * True once every face is loaded. The first render returns false (draw nothing); the render is delayed until the
 * faces are loaded AND the children that need them have mounted (continueRender runs in an effect after that commit).
 */
export function useThemeFonts(faces: readonly ThemeFontFace[] | undefined): boolean {
  const list = faces ?? [];
  const [handle] = useState(() => (list.length > 0 ? delayRender(`loading ${list.length} theme font(s)`) : null));
  const [ready, setReady] = useState(list.length === 0);
  const preview = usePreviewMode();
  useEffect(() => {
    if (handle === null) return;
    let alive = true;
    Promise.all(list.map(loadFace))
      .then(() => {
        if (alive) setReady(true);
      })
      .catch((e: unknown) => {
        if (!preview) {
          cancelRender(new Error(`a theme font could not be loaded (${list.map((f) => f.url).join(', ')}): ${e instanceof Error ? e.message : String(e)}`));
          return;
        }
        // Preview: the faces that loaded are used, the others fall back (the frame's URLs are not named: capabilities).
        preview.warn(`a theme font could not be loaded (${[...new Set(list.map((f) => f.family))].join(', ')}): the preview uses a fallback font`);
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
    // The faces of a plan never change during a render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);
  useEffect(() => {
    if (ready && handle !== null) continueRender(handle);
  }, [ready, handle]);
  return ready;
}

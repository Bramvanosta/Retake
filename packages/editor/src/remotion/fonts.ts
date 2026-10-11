/**
 * Theme fonts: registered with the FontFace API before anything is drawn (text fitting measures with the real
 * fonts), the render held with delayRender until they are loaded.
 */
import { useEffect, useState } from 'react';
import { cancelRender, continueRender, delayRender } from 'remotion';
import type { ThemeFontFace } from '@demo-studio/components';

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
  useEffect(() => {
    if (handle === null) return;
    let alive = true;
    Promise.all(list.map(loadFace))
      .then(() => {
        if (alive) setReady(true);
      })
      .catch((e: unknown) => cancelRender(new Error(`a theme font could not be loaded (${list.map((f) => f.url).join(', ')}): ${e instanceof Error ? e.message : String(e)}`)));
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

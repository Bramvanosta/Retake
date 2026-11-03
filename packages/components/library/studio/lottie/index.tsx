import { AbsoluteFill } from 'remotion';
import { LottieFile, mediaBackground, themeColorMap } from '@retake/components/kit';
import type { ComponentProps } from '@retake/components/kit';

type Params = { fit: 'contain' | 'cover'; background: string; size: number; loop: boolean; colors: Record<string, string> };

/**
 * A Lottie file (L2.12): full frame on the background — in a centred box `size` × the frame — or, as an overlay, in the
 * box the planner placed (`anchor`), clipped to the visible capture. Colours listed in `colors` take the theme's.
 */
export default function LottieAnimation({ as, theme, media, params, rects, anchor, width, height }: ComponentProps<Params>) {
  const file = media?.file?.kind === 'lottie' ? media.file : undefined;
  const colors = themeColorMap(theme, params.colors);
  const body = file ? <LottieFile media={file} fit={params.fit} loop={params.loop} colors={colors} /> : null;
  if (as === 'overlay') {
    const screen = rects?.screen ?? { x: 0, y: 0, w: width, h: height };
    const box = anchor && anchor.w > 0 && anchor.h > 0 ? anchor : screen;
    return (
      <AbsoluteFill>
        <div style={{ position: 'absolute', left: screen.x, top: screen.y, width: screen.w, height: screen.h, overflow: 'hidden', borderRadius: rects?.radius ?? 0 }}>
          <div style={{ position: 'absolute', left: box.x - screen.x, top: box.y - screen.y, width: box.w, height: box.h }}>{body}</div>
        </div>
      </AbsoluteFill>
    );
  }
  const size = Math.max(0.05, Math.min(1, params.size));
  return (
    <AbsoluteFill style={{ background: mediaBackground(theme, params.background), alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: width * size, height: height * size }}>{body}</div>
    </AbsoluteFill>
  );
}

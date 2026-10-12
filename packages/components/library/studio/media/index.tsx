import { AbsoluteFill } from 'remotion';
import { ImageFile, VideoFile, autoFit, mediaBackground } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { fit: 'auto' | 'cover' | 'contain'; background: string; volume: number; from: number; to?: number; loop: boolean };

/**
 * Your own file (L2.12): full frame — on the background, filled or whole — or, as an overlay, in the box the planner
 * placed (`anchor`, output px: the step's target, the cursor, a side of the screen or a rect of the page, mapped through
 * the layout, the camera and the reframe), clipped to the visible capture. Nothing else is drawn: the motion is yours,
 * the theme brings the background and the transitions around it.
 */
export default function Media({ as, theme, media, params, rects, anchor, width, height }: ComponentProps<Params>) {
  const file = media?.file;
  const screen = rects?.screen ?? { x: 0, y: 0, w: width, h: height };
  const box = anchor && anchor.w > 0 && anchor.h > 0 ? anchor : screen;
  const fit = params.fit === 'auto' ? (file?.kind === 'video' || file?.kind === 'picture' ? autoFit(file, as === 'overlay' ? box : { w: width, h: height }) : 'cover') : params.fit;
  const body =
    file?.kind === 'video' ? (
      <VideoFile media={file} fit={fit} volume={params.volume} from={params.from} to={params.to} loop={params.loop} />
    ) : file?.kind === 'picture' ? (
      <ImageFile media={file} fit={fit} />
    ) : null;
  if (as === 'overlay') {
    return (
      <AbsoluteFill>
        <div style={{ position: 'absolute', left: screen.x, top: screen.y, width: screen.w, height: screen.h, overflow: 'hidden', borderRadius: rects?.radius ?? 0 }}>
          <div style={{ position: 'absolute', left: box.x - screen.x, top: box.y - screen.y, width: box.w, height: box.h }}>{body}</div>
        </div>
      </AbsoluteFill>
    );
  }
  return <AbsoluteFill style={{ background: mediaBackground(theme, params.background) }}>{body}</AbsoluteFill>;
}

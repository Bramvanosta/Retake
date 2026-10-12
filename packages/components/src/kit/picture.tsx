/**
 * Pictures of cards (L2.10): a `PictureMedia` — an image file, or a frame of the capture video frozen at its time
 * (studio/card-before-after). Deterministic: the frame is the video at `video.time_s` whatever the composition frame.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Img, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import type { PictureMedia } from '../types.js';

/**
 * The picture filling its parent box (`fit`: cover crops, contain letterboxes, fill stretches). A frame of the capture
 * is an OffthreadVideo inside a Sequence shifted so the video shows `video.time_s` (not `<Freeze>`, which clamps to the
 * composition length).
 */
export function Picture(props: { media: PictureMedia; fit?: 'cover' | 'contain' | 'fill'; style?: CSSProperties }): ReactNode {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fit = props.fit ?? 'cover';
  const style: CSSProperties = { width: '100%', height: '100%', display: 'block', objectFit: fit, ...props.style };
  if (props.media.video) {
    const t = props.media.video.time_s * fps;
    return (
      <Sequence from={frame - t} layout="none" name="picture">
        <OffthreadVideo src={props.media.url} muted style={style} />
      </Sequence>
    );
  }
  return <Img src={props.media.url} style={style} />;
}

/** Aspect ratio (w / h) of a picture, when known. */
export function pictureAspect(media: PictureMedia | undefined): number | undefined {
  return media?.width && media.height ? media.width / media.height : undefined;
}

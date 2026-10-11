import { useCurrentFrame } from 'remotion';
import { FitText, activeIndex, fadeOut, rise, textStyleCss } from '@demo-studio/components/kit';
import type { CaptionCue, ComponentProps, ThemeTextStyle } from '@demo-studio/components/kit';

type Params = { align: 'center' | 'left'; max_lines: number; rule: boolean };

const FOREVER = Number.MAX_SAFE_INTEGER;

/** The active cue: kicker (with an accent rule) over a display line, rising in at each cue change. */
export default function Caption({ theme, slots, params, unit, width, height, fps, cues, area }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const list: CaptionCue[] =
    cues && cues.length > 0 ? cues : slots.text ? [{ from: 0, to: FOREVER, text: slots.text, kicker: slots.kicker, scene: '' }] : [];
  const index = activeIndex(list, frame);
  if (index < 0) return null;
  const cue = list[index];
  const box = area ?? { x: 120 * unit, y: height - 190 * unit, w: width - 240 * unit, h: 150 * unit };
  const kicker: ThemeTextStyle = theme.captions?.kicker ?? { font: theme.fonts.body, size: 15, weight: 600, uppercase: true, color: theme.colors.accent, letter_spacing: 0.14 };
  const line: ThemeTextStyle = theme.captions?.line ?? { font: theme.fonts.display, size: 35, color: theme.colors.text };
  const local = frame - cue.from;
  const enter = rise(local, fps, { duration: 0.45, distance: 12, unit });
  const exit = cue.to === FOREVER ? 1 : fadeOut(local, fps, cue.to - cue.from, { duration: 0.25 });
  const center = params.align !== 'left';
  return (
    <div
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: center ? 'center' : 'flex-start',
        opacity: enter.opacity * exit,
        transform: enter.transform,
      }}
    >
      {cue.kicker ? (
        <div style={{ ...textStyleCss(kicker, unit), display: 'flex', alignItems: 'center', gap: 12 * unit, marginBottom: 8 * unit }}>
          {params.rule ? <span style={{ width: 28 * unit, height: 2 * unit, background: theme.colors.accent, display: 'inline-block' }} /> : null}
          {cue.kicker}
        </div>
      ) : null}
      <FitText
        text={cue.text}
        width={box.w}
        height={box.h - (cue.kicker ? (kicker.size + 8) * unit * 1.2 : 0)}
        maxFontSize={line.size * unit}
        minFontSize={line.size * unit * 0.6}
        maxLines={params.max_lines}
        lineHeight={1.2}
        fontFamily={line.font}
        fontWeight={line.weight}
        letterSpacing={line.letter_spacing}
        uppercase={line.uppercase}
        color={line.color}
        align={center ? 'center' : 'left'}
      />
    </div>
  );
}

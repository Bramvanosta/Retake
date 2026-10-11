import { useCurrentFrame } from 'remotion';
import { FitText, activeIndex, darkLight, fadeOut, rise, textStyleCss, withAlpha } from '@demo-studio/components/kit';
import type { CaptionCue, ComponentProps, ThemeTextStyle } from '@demo-studio/components/kit';

type Params = { position: 'below' | 'above'; align: 'left' | 'center'; max_lines: number; rule: boolean };

const FOREVER = Number.MAX_SAFE_INTEGER;

/** The active cue: accent rule + kicker over one display line; rises in at each cue, fades out at its end. */
export default function CaptionBelow({ theme, slots, params, unit, width, height, fps, cues, area }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const list: CaptionCue[] =
    cues && cues.length > 0 ? cues : slots.text ? [{ from: 0, to: FOREVER, text: slots.text, kicker: slots.kicker, scene: '' }] : [];
  const index = activeIndex(list, frame);
  if (index < 0) return null;
  const cue = list[index];
  const below = area ?? { x: 180 * unit, y: height - 150 * unit, w: width - 360 * unit, h: 110 * unit };
  const above = params.position === 'above';
  const box = above ? { x: below.x, y: 36 * unit, w: below.w, h: below.h } : below;
  const kicker: ThemeTextStyle = theme.captions?.kicker ?? { font: theme.fonts.body, size: 15, weight: 600, uppercase: true, color: theme.colors.accent, letter_spacing: 0.14 };
  const line: ThemeTextStyle = theme.captions?.line ?? { font: theme.fonts.display, size: 38, color: theme.colors.text };
  const local = frame - cue.from;
  const enter = rise(local, fps, { duration: 0.35, distance: 7, unit, ease: 'entrance' });
  const exit = cue.to === FOREVER ? 1 : fadeOut(local, fps, cue.to - cue.from, { duration: 0.25 });
  const center = params.align === 'center';
  const pad = 6 * unit;
  const kickerHeight = cue.kicker ? (kicker.size * 1.2 + 12) * unit : 0;
  return (
    <div
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        boxSizing: 'border-box',
        padding: `0 ${pad}px`,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: center ? 'center' : 'flex-start',
        opacity: enter.opacity * exit,
        transform: enter.transform,
        ...(above ? { background: withAlpha(darkLight(theme).light, 0.92), borderRadius: 14 * unit, padding: `0 ${24 * unit}px` } : {}),
      }}
    >
      {cue.kicker ? (
        <div style={{ ...textStyleCss(kicker, unit), display: 'flex', alignItems: 'center', gap: 12 * unit, marginBottom: 12 * unit, whiteSpace: 'nowrap' }}>
          {params.rule ? <span style={{ width: 36 * unit, height: 2 * unit, background: theme.colors.accent, display: 'inline-block', flex: 'none' }} /> : null}
          {cue.kicker}
        </div>
      ) : null}
      <FitText
        text={cue.text}
        width={box.w - 2 * (above ? 24 * unit : pad)}
        height={box.h - kickerHeight}
        maxFontSize={line.size * unit}
        minFontSize={line.size * unit * 0.62}
        maxLines={params.max_lines}
        lineHeight={1.18}
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

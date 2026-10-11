import { useCurrentFrame } from 'remotion';
import { activeIndex, cssFontFamily, darkLight, fadeOut, fitText, measureText, readableOn, rise, roundTo, withAlpha } from '@demo-studio/components/kit';
import type { CaptionCue, ComponentProps } from '@demo-studio/components/kit';

type Params = { opacity: number; max_width: number };

const FOREVER = Number.MAX_SAFE_INTEGER;

/** The active cue on a translucent dark band, centred near the bottom (or in the layout's caption area). */
export default function CaptionOverlay({ theme, slots, params, unit, width, height, fps, cues, area }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const list: CaptionCue[] =
    cues && cues.length > 0 ? cues : slots.text ? [{ from: 0, to: FOREVER, text: slots.text, kicker: slots.kicker, scene: '' }] : [];
  const index = activeIndex(list, frame);
  if (index < 0) return null;
  const cue = list[index];
  const { dark, light } = darkLight(theme);
  const lineSize = Math.min(34, theme.captions?.line.size ?? 34) * unit;
  const kickerSize = 14 * unit;
  const padX = 30 * unit;
  const padY = 18 * unit;
  const maxW = Math.min(params.max_width * unit, (area?.w ?? width - 160 * unit));
  const fit = fitText({ text: cue.text, width: maxW - 2 * padX, maxFontSize: lineSize, minFontSize: lineSize * 0.6, maxLines: 2, lineHeight: 1.2, fontFamily: theme.fonts.display });
  const kickerW = cue.kicker ? measureText(cue.kicker.toUpperCase(), { family: theme.fonts.body, weight: 600, size: kickerSize, letterSpacing: 0.14 }) : 0;
  const textW = Math.max(fit.width, kickerW);
  const w = roundTo(Math.min(maxW, textW + 2 * padX));
  const h = roundTo(fit.lines.length * fit.fontSize * 1.2 + (cue.kicker ? kickerSize * 1.3 + 8 * unit : 0) + 2 * padY);
  const x = area ? area.x + (area.w - w) / 2 : (width - w) / 2;
  const y = area ? area.y + Math.max(0, (area.h - h) / 2) : height - 64 * unit - h;
  const local = frame - cue.from;
  const enter = rise(local, fps, { duration: 0.35, distance: 8, unit, ease: 'entrance' });
  const exit = cue.to === FOREVER ? 1 : fadeOut(local, fps, cue.to - cue.from, { duration: 0.25 });
  return (
    <div
      style={{
        position: 'absolute',
        left: roundTo(x),
        top: roundTo(y),
        width: w,
        height: h,
        boxSizing: 'border-box',
        padding: `${padY}px ${padX}px`,
        borderRadius: 16 * unit,
        background: withAlpha(dark, params.opacity),
        boxShadow: `0 ${10 * unit}px ${30 * unit}px ${withAlpha(dark, 0.25)}`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: enter.opacity * exit,
        transform: enter.transform,
      }}
    >
      {cue.kicker ? (
        <div
          style={{
            fontFamily: cssFontFamily(theme.fonts.body),
            fontWeight: 600,
            fontSize: kickerSize,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: readableOn(dark, theme.colors.accent, withAlpha(light, 0.75)),
            marginBottom: 8 * unit,
            whiteSpace: 'nowrap',
          }}
        >
          {cue.kicker}
        </div>
      ) : null}
      <div style={{ fontFamily: cssFontFamily(theme.fonts.display), fontSize: fit.fontSize, lineHeight: 1.2, color: light, textAlign: 'center' }}>
        {fit.lines.map((l, i) => (
          <div key={i} style={{ whiteSpace: 'pre' }}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

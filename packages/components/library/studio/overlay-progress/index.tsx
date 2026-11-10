import { CapText, backgroundSample, biasMotion, capTextLayout, clamp, fadeOut, liftToContrast, mixColors, progress, readableOn, roundTo, useCurrentFrame, withAlpha } from '@retake/components/kit';
import type { ComponentProps } from '@retake/components/kit';

type Params = { position: 'top' | 'bottom'; thickness: number; gap: number; margin: number; labels: boolean };

/**
 * One segment per chapter (`chapters`, frames relative to the bar), widths proportional to their length; the current
 * one fills as the frame advances. Without chapters: one continuous bar.
 */
export default function OverlayProgress({ theme, params, unit, width, height, fps, durationInFrames, chapters }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const u = unit;
  const list = chapters && chapters.length > 0 ? chapters : [{ id: 'all', from: 0, to: durationInFrames }];
  const total = Math.max(1, list[list.length - 1].to - list[0].from);
  const bg = backgroundSample(theme);
  const accent = liftToContrast(bg, theme.colors.accent, theme.colors.text, 2.2);
  const track = withAlpha(readableOn(bg, theme.colors.text, theme.colors.paper, 3), 0.14);
  const margin = params.margin * u;
  const gap = list.length > 1 ? params.gap * u : 0;
  const t = params.thickness * u;
  const avail = width - 2 * margin - gap * (list.length - 1);
  const y = params.position === 'top' ? 16 * u : height - 16 * u - t;
  const pace = biasMotion(theme.style_bias).pace;
  const opacity = roundTo(Math.min(progress(frame, fps, { duration: 0.4 * pace }), fadeOut(frame, fps, durationInFrames, { duration: 0.4 * pace })), 4);
  let x = margin;
  const current = list.findIndex((c) => frame >= c.from && frame < c.to);
  const label = params.labels && current >= 0 && list[current].label
    ? capTextLayout({ text: `${current + 1}/${list.length} · ${list[current].label}`, width: 640 * u, maxFontSize: 15 * u, minFontSize: 11 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.08, uppercase: true })
    : null;
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity }}>
      {list.map((c, i) => {
        const w = (avail * (c.to - c.from)) / total;
        const left = x;
        x += w + gap;
        const fillP = clamp((frame - c.from) / Math.max(1, c.to - c.from));
        return (
          <div key={c.id + i} style={{ position: 'absolute', left: roundTo(left, 2), top: roundTo(y, 2), width: roundTo(w, 2), height: roundTo(t, 2), borderRadius: t / 2, background: track, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${roundTo(fillP * 100, 3)}%`, borderRadius: t / 2, background: i === current ? accent : mixColors(accent, bg, 0.12) }} />
          </div>
        );
      })}
      {label ? <CapText layout={label} x={params.position === 'top' ? margin : margin} capTop={params.position === 'top' ? y + t + 12 * u : y - 12 * u - label.capHeight} color={withAlpha(readableOn(bg, theme.colors.text, theme.colors.paper, 3), 0.7)} /> : null}
    </div>
  );
}

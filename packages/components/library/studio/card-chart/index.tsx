import { useCurrentFrame } from 'remotion';
import {
  Background,
  CapText,
  backgroundSample,
  biasMotion,
  capTextLayout,
  darkLight,
  formatMetrics,
  mixColors,
  nightTone,
  parseFigure,
  parseNumber,
  progress,
  readableOn,
  roundTo,
  withAlpha,
} from '@demo-studio/components/kit';
import type { ComponentProps, TableMedia, ThemeTokens } from '@demo-studio/components/kit';

type Params = {
  type: 'bar' | 'line';
  data: Array<{ label: string; value: number }>;
  x: string;
  y: string;
  highlight: string;
  prefix: string;
  suffix: string;
  decimals: number;
  max_points: number;
  tone: 'paper' | 'dark';
};

function palette(theme: ThemeTokens, tone: Params['tone']) {
  const { dark, light } = darkLight(theme);
  if (tone === 'dark') {
    const bg = nightTone(theme);
    const ink = readableOn(bg, light, theme.colors.paper, 4.5);
    return { bg, sample: bg, ink, accent: readableOn(bg, theme.colors.accent, withAlpha(ink, 0.75), 2.6), muted: withAlpha(ink, 0.68) };
  }
  const bg = backgroundSample(theme);
  const ink = readableOn(bg, theme.colors.text, readableOn(bg, dark, light) === dark ? dark : light);
  return { bg: undefined, sample: bg, ink, accent: readableOn(bg, theme.colors.accent, ink, 2.2), muted: readableOn(bg, theme.colors.muted, ink, 3) };
}

function appear(frame: number, fps: number, delay: number, duration: number, distance: number) {
  const p = progress(frame, fps, { delay, duration, ease: 'easeInOut' });
  return { opacity: roundTo(p, 4), transform: `translateY(${roundTo((1 - p) * distance, 2)}px)` };
}

/** The points: from the table (columns x / y, else the first and the first numeric one), else the inline data. */
export function chartPoints(table: TableMedia | undefined, p: Pick<Params, 'data' | 'x' | 'y' | 'max_points'>): { points: Array<{ label: string; value: number; raw: string }>; decimals: number } {
  let pts: Array<{ label: string; value: number; raw: string }> = [];
  if (table && table.columns.length > 0) {
    const col = (name: string) => (name ? table.columns.findIndex((c) => c.trim().toLowerCase() === name.trim().toLowerCase()) : -1);
    const xi = Math.max(0, col(p.x));
    let yi = col(p.y);
    if (yi < 0) yi = table.columns.findIndex((_, i) => i !== xi && table.rows.some((r) => Number.isFinite(parseNumber(r[i] ?? ''))));
    if (yi >= 0) pts = table.rows.map((r) => ({ label: r[xi] ?? '', raw: r[yi] ?? '', value: parseNumber(r[yi] ?? '') })).filter((x) => Number.isFinite(x.value));
  } else {
    pts = (p.data ?? []).map((d) => ({ label: String(d.label), value: Number(d.value), raw: String(d.value) })).filter((x) => Number.isFinite(x.value));
  }
  pts = pts.slice(-Math.max(2, p.max_points));
  const decimals = Math.min(2, Math.max(0, ...pts.map((x) => parseFigure(x.raw)?.decimals ?? 0)));
  return { points: pts, decimals };
}

function format(v: number, decimals: number, prefix: string, suffix: string): string {
  const s = Math.abs(v)
    .toFixed(decimals)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0 ? '−' : ''}${prefix}${s}${suffix}`;
}

/**
 * Title block on top, the chart area below. Bars grow from the baseline one after the other (0.09 s apart, 0.7 s
 * each); a line draws over 1.4 s, its points pop as it reaches them. The highlighted category is in the accent.
 */
export default function CardChart({ theme, slots, params, unit, width, height, fps, variant, media }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const { u, inset } = formatMetrics(variant, unit);
  const bias = biasMotion(theme.style_bias);
  const c = palette(theme, params.tone);
  const { points, decimals: auto } = chartPoints(media?.data as TableMedia | undefined, params);
  const decimals = params.decimals >= 0 ? params.decimals : auto;
  const margin = inset(180);
  const column = width - 2 * margin;
  const n = points.length;
  const hl = params.highlight === 'none' ? -1 : params.highlight ? points.findIndex((p) => p.label === params.highlight) : n - 1;

  const kicker = slots.kicker
    ? capTextLayout({ text: slots.kicker, width: column, maxFontSize: 18 * u, minFontSize: 12 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.18, uppercase: true })
    : null;
  const title = slots.title ? capTextLayout({ text: slots.title, width: column, maxFontSize: 60 * u, minFontSize: 34 * u, maxLines: 2, lineHeight: 1.06, fontFamily: theme.fonts.display }) : null;
  const note = slots.note ? capTextLayout({ text: slots.note, width: column, maxFontSize: 18 * u, minFontSize: 13 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body }) : null;
  const top = 110 * u;
  let y = top;
  const kickerTop = y;
  if (kicker) y += kicker.capHeight + 28 * u;
  const titleTop = y;
  if (title) y += title.band;
  const chartTop = y + 90 * u;
  const chartBottom = height - 110 * u - (note ? note.capHeight + 34 * u : 0) - 44 * u;
  const chartH = Math.max(80 * u, chartBottom - chartTop);
  const max = Math.max(...points.map((p) => p.value), 0);
  const min = Math.min(...points.map((p) => p.value), 0);
  const span = max - min || 1;
  const yOf = (v: number) => chartTop + chartH * (1 - (v - min) / span);
  const base = yOf(0);
  const slot = n > 0 ? column / n : column;
  const barW = Math.min(slot * 0.62, 150 * u);
  const quiet = mixColors(c.sample, c.ink, 0.22);
  const labelSize = Math.max(13 * u, Math.min(22 * u, slot * 0.22));
  const valueSize = Math.max(14 * u, Math.min(26 * u, slot * 0.24));

  const kickerIn = appear(frame, fps, 0.05, 0.45 * bias.pace, 10 * bias.travel * u);
  const titleIn = appear(frame, fps, 0.15, 0.5 * bias.pace, 12 * bias.travel * u);
  const axisIn = progress(frame, fps, { delay: 0.35, duration: 0.5, ease: 'standard' });
  const start = 0.55;
  const step = Math.min(0.09, 1.1 / Math.max(1, n));

  const xs = points.map((_, i) => margin + slot * (i + 0.5));
  const lineP = progress(frame, fps, { delay: start, duration: 1.4, ease: 'easeInOut' });
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${roundTo(xs[i], 2)} ${roundTo(yOf(p.value), 2)}`).join(' ');
  const area = n > 1 ? `${path} L${roundTo(xs[n - 1], 2)} ${roundTo(base, 2)} L${roundTo(xs[0], 2)} ${roundTo(base, 2)} Z` : '';
  const len = points.reduce((s, p, i) => (i === 0 ? 0 : s + Math.hypot(xs[i] - xs[i - 1], yOf(p.value) - yOf(points[i - 1].value))), 0);

  return (
    <Background theme={theme} style={c.bg ? { background: c.bg } : undefined}>
      {kicker ? (
        <div style={{ position: 'absolute', inset: 0, ...kickerIn }}>
          <CapText layout={kicker} x={margin} capTop={kickerTop} color={c.accent} />
        </div>
      ) : null}
      {title ? (
        <div style={{ position: 'absolute', inset: 0, ...titleIn }}>
          <CapText layout={title} x={margin} capTop={titleTop} color={c.ink} />
        </div>
      ) : null}
      <div style={{ position: 'absolute', left: margin, top: roundTo(base, 2), width: roundTo(column, 2), height: Math.max(1, roundTo(1.5 * u, 2)), background: withAlpha(c.ink, 0.35), transform: `scaleX(${roundTo(axisIn, 4)})`, transformOrigin: 'left' }} />
      {params.type === 'line' ? (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: 'absolute', inset: 0 }}>
          {area ? <path d={area} fill={withAlpha(c.accent, roundTo(0.1 * lineP, 3))} /> : null}
          {n > 1 ? (
            <path d={path} fill="none" stroke={c.accent} strokeWidth={roundTo(4 * u, 2)} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={roundTo(len, 2)} strokeDashoffset={roundTo(len * (1 - lineP), 2)} />
          ) : null}
        </svg>
      ) : null}
      {points.map((p, i) => {
        const delay = start + i * step;
        const g = params.type === 'bar' ? progress(frame, fps, { delay, duration: 0.7 * bias.pace, ease: 'entrance' }) : progress(frame, fps, { delay: start + (1.4 * i) / Math.max(1, n - 1), duration: 0.3, ease: 'entrance' });
        const isHl = i === hl;
        const fill = isHl ? c.accent : quiet;
        const vy = yOf(p.value);
        const value = capTextLayout({ text: format(p.value, decimals, params.prefix, params.suffix), width: slot * 1.2, maxFontSize: valueSize, minFontSize: 11 * u, maxLines: 1, lineHeight: 1.1, fontFamily: theme.fonts.body, fontWeight: isHl ? 700 : 600 });
        const label = capTextLayout({ text: p.label, width: slot * 0.96, maxFontSize: labelSize, minFontSize: 10 * u, maxLines: 1, lineHeight: 1.1, fontFamily: theme.fonts.body, fontWeight: 500 });
        const barTop = Math.min(vy, base);
        const barH = Math.abs(base - vy);
        const valueTop = (params.type === 'bar' ? base - (base - barTop) * g : vy) - 18 * u - value.capHeight - (params.type === 'line' ? 6 * u : 0);
        const valueIn = progress(frame, fps, { delay: delay + (params.type === 'bar' ? 0.45 : 1.1), duration: 0.35 });
        return (
          <div key={i}>
            {params.type === 'bar' ? (
              <div
                style={{
                  position: 'absolute',
                  left: roundTo(xs[i] - barW / 2, 2),
                  top: roundTo(base - (base - barTop) * g, 2),
                  width: roundTo(barW, 2),
                  height: roundTo(Math.max(0, barH * g), 2),
                  borderRadius: `${roundTo(8 * u, 2)}px ${roundTo(8 * u, 2)}px 0 0`,
                  background: fill,
                }}
              />
            ) : (
              <div
                style={{
                  position: 'absolute',
                  left: roundTo(xs[i] - (isHl ? 9 : 6) * u, 2),
                  top: roundTo(vy - (isHl ? 9 : 6) * u, 2),
                  width: (isHl ? 18 : 12) * u,
                  height: (isHl ? 18 : 12) * u,
                  borderRadius: '50%',
                  background: isHl ? c.accent : c.sample,
                  boxShadow: `0 0 0 ${roundTo(3 * u, 2)}px ${c.accent}`,
                  opacity: roundTo(g, 4),
                  transform: `scale(${roundTo(0.4 + 0.6 * g, 4)})`,
                }}
              />
            )}
            <div style={{ position: 'absolute', inset: 0, opacity: roundTo(valueIn, 4) }}>
              <CapText layout={value} x={xs[i]} capTop={valueTop} align="center" color={isHl ? c.accent : c.ink} />
            </div>
            <div style={{ position: 'absolute', inset: 0, opacity: roundTo(axisIn, 4) }}>
              <CapText layout={label} x={xs[i]} capTop={base + 22 * u} align="center" color={c.muted} />
            </div>
          </div>
        );
      })}
      {note ? (
        <div style={{ position: 'absolute', inset: 0, opacity: roundTo(axisIn, 4) }}>
          <CapText layout={note} x={margin} capTop={height - 110 * u - note.capHeight} color={c.muted} />
        </div>
      ) : null}
    </Background>
  );
}

import { useCurrentFrame } from 'remotion';
import {
  Background,
  CapText,
  SYSTEM_COLORS,
  backgroundSample,
  biasMotion,
  capTextLayout,
  contrastRatio,
  darkLight,
  formatMetrics,
  nightTone,
  progress,
  qrEncode,
  qrPath,
  readableOn,
  roundTo,
  withAlpha,
} from '@demo-studio/components/kit';
import type { ComponentProps, QrLevel, ThemeTokens } from '@demo-studio/components/kit';

type Params = { tone: 'paper' | 'dark'; show_qr: boolean; qr_level: QrLevel };

function palette(theme: ThemeTokens, tone: Params['tone']) {
  const { dark, light } = darkLight(theme);
  if (tone === 'dark') {
    const bg = nightTone(theme);
    const ink = readableOn(bg, light, theme.colors.paper, 4.5);
    return { bg, sample: bg, ink, accent: readableOn(bg, theme.colors.accent, withAlpha(ink, 0.75), 2.6), muted: withAlpha(ink, 0.68), dark, light };
  }
  const bg = backgroundSample(theme);
  const ink = readableOn(bg, theme.colors.text, readableOn(bg, dark, light) === dark ? dark : light);
  return { bg: undefined, sample: bg, ink, accent: readableOn(bg, theme.colors.accent, ink, 2.2), muted: readableOn(bg, theme.colors.muted, ink, 3), dark, light };
}

function appear(frame: number, fps: number, delay: number, duration: number, distance: number) {
  const p = progress(frame, fps, { delay, duration, ease: 'easeInOut' });
  return { opacity: roundTo(p, 4), transform: `translateY(${roundTo((1 - p) * distance, 2)}px)` };
}

/** "shop.example.com/x" → "https://shop.example.com/x" (a QR code needs a full URL for phones to open it). */
function qrTarget(v: string): string {
  const s = v.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
}

/**
 * Landscape: the text column on the left, the QR card on the right, centred as a row. Vertical / square: the column,
 * then the QR card under it, centred. Modules dark on light (contrast ≥ 7 or pure black on white) so phones scan it.
 */
export default function CardCta({ theme, slots, params, unit, width, height, fps, variant }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const { u, inset } = formatMetrics(variant, unit);
  const bias = biasMotion(theme.style_bias);
  const c = palette(theme, params.tone);
  const wide = variant === 'landscape';
  const qrText = slots.qr ?? slots.url;
  let qr: ReturnType<typeof qrEncode> | null = null;
  if (params.show_qr && qrText) {
    try {
      qr = qrEncode(qrTarget(qrText), { level: params.qr_level });
    } catch {
      qr = null;
    }
  }
  const margin = inset(200);
  const qrSize = (wide ? 300 : variant === 'square' ? 230 : 330) * u;
  const qrPad = 22 * u;
  const qrLabelGap = 22 * u;
  const columnW = wide ? Math.min(980 * u, width - 2 * margin - (qr ? qrSize + 2 * qrPad + 140 * u : 0)) : width - 2 * margin;
  const center = !wide;

  const kicker = slots.kicker
    ? capTextLayout({ text: slots.kicker, width: columnW, maxFontSize: 18 * u, minFontSize: 12 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.18, uppercase: true })
    : null;
  const title = capTextLayout({ text: slots.title ?? '', width: columnW, maxFontSize: 80 * u, minFontSize: 44 * u, maxLines: 2, lineHeight: 1.04, fontFamily: theme.fonts.display, letterSpacing: -0.012 });
  const text = slots.text ? capTextLayout({ text: slots.text, width: columnW, maxFontSize: 27 * u, minFontSize: 18 * u, maxLines: 2, lineHeight: 1.35, fontFamily: theme.fonts.body }) : null;
  const btnText = capTextLayout({ text: slots.button ?? 'Get started', width: columnW - 80 * u, maxFontSize: 27 * u, minFontSize: 18 * u, maxLines: 1, lineHeight: 1.1, fontFamily: theme.fonts.body, fontWeight: 600 });
  const url = slots.url ? capTextLayout({ text: slots.url, width: columnW, maxFontSize: 22 * u, minFontSize: 15 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 500 }) : null;
  const qrLabel = qr ? capTextLayout({ text: slots.qr_label ?? 'Scan to open', width: qrSize + 2 * qrPad, maxFontSize: 16 * u, minFontSize: 11 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.14, uppercase: true }) : null;
  const btnH = btnText.capHeight + 46 * u;
  const btnW = btnText.width + 76 * u;

  // The text column.
  let y = 0;
  const kickerTop = kicker ? y : undefined;
  if (kicker) y += kicker.capHeight + 34 * u;
  const titleTop = y;
  y += title.band;
  let textTop: number | undefined;
  if (text) {
    y += 34 * u;
    textTop = y;
    y += text.band;
  }
  y += 52 * u;
  const btnTop = y;
  y += btnH;
  let urlTop: number | undefined;
  if (url) {
    y += 26 * u;
    urlTop = y;
    y += url.capHeight;
  }
  const colH = y;
  const qrCardH = qr ? qrSize + 2 * qrPad + (qrLabel ? qrLabelGap + qrLabel.capHeight : 0) : 0;
  const qrCardW = qrSize + 2 * qrPad;
  let colX: number;
  let colY: number;
  let qrX = 0;
  let qrY = 0;
  if (wide) {
    const rowW = columnW + (qr ? 140 * u + qrCardW : 0);
    colX = (width - rowW) / 2;
    colY = Math.round((height - colH) / 2);
    qrX = colX + columnW + 140 * u;
    qrY = Math.round((height - qrCardH) / 2);
  } else {
    const gap = 80 * u;
    const total = colH + (qr ? gap + qrCardH : 0);
    colX = width / 2;
    colY = Math.round((height - total) / 2);
    qrX = (width - qrCardW) / 2;
    qrY = colY + colH + gap;
  }
  const align = center ? 'center' : 'left';
  const btnX = center ? width / 2 - btnW / 2 : colX;

  const kickerIn = appear(frame, fps, 0.1, 0.45 * bias.pace, 10 * bias.travel * u);
  const titleIn = appear(frame, fps, 0.25, 0.5 * bias.pace, 14 * bias.travel * u);
  const textIn = appear(frame, fps, 0.45, 0.5 * bias.pace, 10 * bias.travel * u);
  const pop = progress(frame, fps, { delay: 0.65, duration: 0.45, ease: [0.34, 1.45, 0.64, 1] });
  const pulse = progress(frame, fps, { delay: 1.6, duration: 0.6, ease: 'easeInOut' });
  const pulseScale = 1 + 0.035 * Math.sin(Math.PI * pulse);
  const urlIn = appear(frame, fps, 0.85, 0.5 * bias.pace, 8 * bias.travel * u);
  const qrIn = progress(frame, fps, { delay: 0.9, duration: 0.6 * bias.pace, ease: 'entrance' });

  // QR colours: the theme's dark on white when they contrast enough, else black on white.
  const qrDark = (contrastRatio(SYSTEM_COLORS.white, c.dark) ?? 0) >= 7 ? c.dark : SYSTEM_COLORS.black;
  const btnInk = readableOn(c.accent, c.light, SYSTEM_COLORS.white, 3.5);
  const quiet = 2;
  const modules = qr ? qr.size + 2 * quiet : 1;

  return (
    <Background theme={theme} style={c.bg ? { background: c.bg } : undefined}>
      {kicker && kickerTop !== undefined ? (
        <div style={{ position: 'absolute', inset: 0, ...kickerIn }}>
          <CapText layout={kicker} x={colX} capTop={colY + kickerTop} align={align} color={c.accent} />
        </div>
      ) : null}
      <div style={{ position: 'absolute', inset: 0, ...titleIn }}>
        <CapText layout={title} x={colX} capTop={colY + titleTop} align={align} color={c.ink} />
      </div>
      {text && textTop !== undefined ? (
        <div style={{ position: 'absolute', inset: 0, ...textIn }}>
          <CapText layout={text} x={colX} capTop={colY + textTop} align={align} color={c.muted} />
        </div>
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: roundTo(btnX, 2),
          top: roundTo(colY + btnTop, 2),
          width: roundTo(btnW, 2),
          height: roundTo(btnH, 2),
          borderRadius: btnH / 2,
          background: c.accent,
          opacity: roundTo(Math.min(1, pop * 1.6), 4),
          transform: `scale(${roundTo((0.85 + 0.15 * pop) * pulseScale, 4)})`,
          boxShadow: `0 ${8 * u}px ${22 * u}px ${withAlpha(c.accent, 0.28)}`,
        }}
      >
        <CapText layout={btnText} x={btnW / 2} capTop={(btnH - btnText.capHeight) / 2} align="center" color={btnInk} />
      </div>
      {url && urlTop !== undefined ? (
        <div style={{ position: 'absolute', inset: 0, ...urlIn }}>
          <CapText layout={url} x={center ? width / 2 : colX} capTop={colY + urlTop} align={align} color={c.muted} />
        </div>
      ) : null}
      {qr ? (
        <div
          style={{
            position: 'absolute',
            left: roundTo(qrX, 2),
            top: roundTo(qrY, 2),
            width: roundTo(qrCardW, 2),
            height: roundTo(qrCardH, 2),
            opacity: roundTo(qrIn, 4),
            transform: `scale(${roundTo(0.94 + 0.06 * qrIn, 4)})`,
          }}
        >
          <div style={{ position: 'absolute', left: 0, top: 0, width: qrCardW, height: qrCardW, borderRadius: 18 * u, background: SYSTEM_COLORS.white, boxShadow: `0 ${10 * u}px ${30 * u}px ${withAlpha(c.dark, 0.16)}, 0 0 0 ${Math.max(1, u)}px ${withAlpha(c.dark, 0.08)}` }} />
          <svg
            width={qrSize}
            height={qrSize}
            viewBox={`0 0 ${modules} ${modules}`}
            shapeRendering="crispEdges"
            style={{ position: 'absolute', left: qrPad, top: qrPad }}
          >
            <path d={qrPath(qr.modules, 1, quiet)} fill={qrDark} />
          </svg>
          {qrLabel ? <CapText layout={qrLabel} x={qrCardW / 2} capTop={qrCardW + qrLabelGap} align="center" color={c.muted} /> : null}
        </div>
      ) : null}
    </Background>
  );
}

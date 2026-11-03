import { useCurrentFrame } from 'remotion';
import {
  Background,
  CapText,
  SYSTEM_COLORS,
  Picture,
  backgroundSample,
  biasMotion,
  capTextLayout,
  cardShadow,
  darkLight,
  formatMetrics,
  nightTone,
  pictureAspect,
  progress,
  readableOn,
  roundTo,
  withAlpha,
} from '@retake/components/kit';
import type { ComponentProps, PictureMedia, ThemeTokens } from '@retake/components/kit';

type Params = { wipe_at: number; wipe: number; direction: 'left-to-right' | 'right-to-left' | 'top-to-bottom'; end_at: number; tone: 'paper' | 'dark' };

function palette(theme: ThemeTokens, tone: Params['tone']) {
  const { dark, light } = darkLight(theme);
  if (tone === 'dark') {
    const bg = nightTone(theme);
    const ink = readableOn(bg, light, theme.colors.paper, 4.5);
    return { bg, ink, accent: readableOn(bg, theme.colors.accent, withAlpha(ink, 0.75), 2.6), dark, light };
  }
  const bg = backgroundSample(theme);
  const ink = readableOn(bg, theme.colors.text, readableOn(bg, dark, light) === dark ? dark : light);
  return { bg: undefined, ink, accent: readableOn(bg, theme.colors.accent, ink, 2.2), dark, light };
}

function appear(frame: number, fps: number, delay: number, duration: number, distance: number) {
  const p = progress(frame, fps, { delay, duration, ease: 'easeInOut' });
  return { opacity: roundTo(p, 4), transform: `translateY(${roundTo((1 - p) * distance, 2)}px)` };
}

/** A label chip in the night tone, `bottom` px above the card's bottom edge. */
function Chip({ text, x, bottom, align, u, theme }: { text: string; x: number; bottom: number; align: 'left' | 'right'; u: number; theme: ThemeTokens }) {
  const night = nightTone(theme);
  const { light } = darkLight(theme);
  const l = capTextLayout({ text, width: 360 * u, maxFontSize: 15 * u, minFontSize: 11 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 700, letterSpacing: 0.14, uppercase: true });
  const w = l.width + 32 * u;
  const h = l.capHeight + 22 * u;
  const left = align === 'left' ? x : x - w;
  return (
    <div style={{ position: 'absolute', left: roundTo(left, 2), bottom: roundTo(bottom, 2), width: roundTo(w, 2), height: roundTo(h, 2), borderRadius: h / 2, background: withAlpha(night, 0.82) }}>
      <CapText layout={l} x={w / 2} capTop={(h - l.capHeight) / 2} align="center" color={readableOn(night, light, SYSTEM_COLORS.white, 4.5)} />
    </div>
  );
}

/**
 * Title block on top, then the card (as wide as the format allows at the pictures' aspect). The before shows, then
 * the after wipes in behind a divider with a round handle (eased), stopping at `end_at`.
 */
export default function CardBeforeAfter({ theme, slots, params, unit, width, height, fps, variant, media }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const { u, inset } = formatMetrics(variant, unit);
  const bias = biasMotion(theme.style_bias);
  const c = palette(theme, params.tone);
  const before = media?.before as PictureMedia | undefined;
  const after = media?.after as PictureMedia | undefined;
  const aspect = pictureAspect(before) ?? pictureAspect(after) ?? 16 / 9;
  const margin = inset(180);
  const column = width - 2 * margin;

  const kicker = slots.kicker
    ? capTextLayout({ text: slots.kicker, width: column, maxFontSize: 18 * u, minFontSize: 12 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.18, uppercase: true })
    : null;
  const title = slots.title ? capTextLayout({ text: slots.title, width: column, maxFontSize: 52 * u, minFontSize: 32 * u, maxLines: 2, lineHeight: 1.08, fontFamily: theme.fonts.display }) : null;
  let head = 0;
  if (kicker) head += kicker.capHeight + (title ? 26 * u : 0);
  if (title) head += title.band;
  const headGap = head > 0 ? 44 * u : 0;
  const maxH = height - 2 * 70 * u - head - headGap;
  let cw = column;
  let ch = cw / aspect;
  if (ch > maxH) {
    ch = maxH;
    cw = ch * aspect;
  }
  const top = Math.round((height - (head + headGap + ch)) / 2);
  const cardX = (width - cw) / 2;
  const cardY = top + head + headGap;
  const radius = 16 * u;

  const p = progress(frame, fps, { delay: params.wipe_at, duration: params.wipe, ease: 'gentle' }) * params.end_at;
  const vertical = params.direction === 'top-to-bottom';
  const rtl = params.direction === 'right-to-left';
  const pos = vertical ? ch * p : rtl ? cw * (1 - p) : cw * p;
  const clip = vertical ? `inset(0 0 ${roundTo(ch - pos, 2)}px 0)` : rtl ? `inset(0 0 0 ${roundTo(pos, 2)}px)` : `inset(0 ${roundTo(cw - pos, 2)}px 0 0)`;
  const showDivider = p > 0.001 && p < 0.999;
  const handle = 44 * u;
  const cardIn = appear(frame, fps, 0.25, 0.55 * bias.pace, 18 * bias.travel * u);
  const kickerIn = appear(frame, fps, 0.05, 0.45 * bias.pace, 10 * bias.travel * u);
  const titleIn = appear(frame, fps, 0.15, 0.5 * bias.pace, 12 * bias.travel * u);
  const labelBefore = slots.before_label ?? 'Before';
  const labelAfter = slots.after_label ?? 'After';
  const chipPad = 18 * u;

  return (
    <Background theme={theme} style={c.bg ? { background: c.bg } : undefined}>
      {kicker ? (
        <div style={{ position: 'absolute', inset: 0, ...kickerIn }}>
          <CapText layout={kicker} x={width / 2} capTop={top} align="center" color={c.accent} />
        </div>
      ) : null}
      {title ? (
        <div style={{ position: 'absolute', inset: 0, ...titleIn }}>
          <CapText layout={title} x={width / 2} capTop={top + (kicker ? kicker.capHeight + 26 * u : 0)} align="center" color={c.ink} />
        </div>
      ) : null}
      <div style={{ position: 'absolute', inset: 0, ...cardIn }}>
        <div style={{ position: 'absolute', left: roundTo(cardX, 2), top: roundTo(cardY, 2), width: roundTo(cw, 2), height: roundTo(ch, 2), borderRadius: radius, overflow: 'hidden', boxShadow: cardShadow(theme, 'soft', unit), background: c.light }}>
          {before ? <Picture media={before} fit="cover" /> : null}
          {after ? (
            <div style={{ position: 'absolute', inset: 0, clipPath: clip }}>
              <Picture media={after} fit="cover" />
            </div>
          ) : null}
          {p < 0.999 ? <Chip text={labelBefore} x={rtl ? chipPad : cw - chipPad} bottom={chipPad} align={rtl ? 'left' : 'right'} u={u} theme={theme} /> : null}
          {p > 0.001 ? <Chip text={labelAfter} x={rtl ? cw - chipPad : chipPad} bottom={chipPad} align={rtl ? 'right' : 'left'} u={u} theme={theme} /> : null}
        </div>
        {showDivider ? (
          <>
            <div
              style={{
                position: 'absolute',
                left: roundTo(vertical ? cardX : cardX + pos - 1.5 * u, 2),
                top: roundTo(vertical ? cardY + pos - 1.5 * u : cardY, 2),
                width: roundTo(vertical ? cw : 3 * u, 2),
                height: roundTo(vertical ? 3 * u : ch, 2),
                background: c.light,
                boxShadow: `0 0 ${8 * u}px ${withAlpha(c.dark, 0.35)}`,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: roundTo((vertical ? cardX + cw / 2 : cardX + pos) - handle / 2, 2),
                top: roundTo((vertical ? cardY + pos : cardY + ch / 2) - handle / 2, 2),
                width: handle,
                height: handle,
                borderRadius: handle / 2,
                background: c.light,
                boxShadow: `0 ${4 * u}px ${14 * u}px ${withAlpha(c.dark, 0.3)}, 0 0 0 ${2 * u}px ${c.accent}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width={handle * 0.56} height={handle * 0.56} viewBox="0 0 24 24" fill="none" stroke={c.accent} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ transform: vertical ? 'rotate(90deg)' : undefined }}>
                <path d="M9 6l-6 6 6 6M15 6l6 6-6 6" />
              </svg>
            </div>
          </>
        ) : null}
      </div>
    </Background>
  );
}

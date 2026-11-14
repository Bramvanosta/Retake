import {
  CAPTION_BAND_PAD_X,
  CapText,
  activeIndex,
  biasMotion,
  capTextLayout,
  captionBandBox,
  darkLight,
  fadeOut,
  liftToContrast,
  mixColors,
  nightTone,
  readableOn,
  rise,
  roundTo,
  useCurrentFrame,
  withAlpha,
} from '@retake/components/kit';
import type { CaptionCue, ComponentProps, ThemeTextStyle, ThemeTokens } from '@retake/components/kit';

type Params = { position: 'over' | 'area'; align: 'center' | 'left'; opacity: number; max_width: number; max_lines: number };

const FOREVER = Number.MAX_SAFE_INTEGER;
/** Seconds a caption waits after the clip starts / leaves before it ends (as studio/caption-below). */
const EDGE_S = 0.15;
const PAD_Y = 18;
const RULE_W = 24;
const RULE_GAP = 10;
const KICKER_GAP = 13;

/** The band's tones: the theme's night tone, light text on it, the accent when it reads there. */
function tones(theme: ThemeTokens): { band: string; line: string; kicker: string } {
  const night = nightTone(theme);
  const { dark, light } = darkLight(theme);
  const ink = readableOn(night, light, readableOn(night, theme.colors.paper, mixColors(light, dark, 0.15), 4.5), 4.5);
  // The kicker keeps the theme's accent hue: lifted towards the light tone until it reads on the band.
  return { band: night, line: ink, kicker: liftToContrast(night, theme.colors.accent, ink, 3.5) };
}

function styles(theme: ThemeTokens): { kicker: ThemeTextStyle; line: ThemeTextStyle } {
  const kicker = theme.captions?.kicker ?? { font: theme.fonts.body, size: 15, weight: 600, uppercase: true, color: theme.colors.accent, letter_spacing: 0.14 };
  const line = theme.captions?.line ?? { font: theme.fonts.display, size: 38, color: theme.colors.text };
  return { kicker, line };
}

/** First and last cue of the run of contiguous cues sharing the kicker of cue `i`. */
function kickerRun(list: CaptionCue[], i: number): [number, number] {
  let a = i;
  let b = i;
  const k = list[i].kicker ?? '';
  while (a > 0 && (list[a - 1].kicker ?? '') === k && list[a - 1].to === list[a].from) a--;
  while (b < list.length - 1 && (list[b + 1].kicker ?? '') === k && list[b + 1].from === list[b].to) b++;
  return [a, b];
}

/**
 * The active cue on a translucent band over the bottom of the capture (`rects.screen`), or in the layout's caption
 * area: an accent rule + the uppercase kicker (theme caption kicker style, the accent when it reads on the band) over
 * the caption line (theme caption line style, light), centred. The band holds its size through a run of cues with the
 * same kicker and only the line changes (out 0.25 s, in 0.35 s with a rise); it rises in with the first cue of a run
 * and fades out with the last. style_bias balanced / motion: more rise and a slight scale settle of the band.
 */
export default function CaptionOverlay({ theme, slots, params, unit, width, height, fps, durationInFrames, cues, area, rects, variant }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const u = unit;
  const list: CaptionCue[] =
    cues && cues.length > 0 ? cues : slots.text ? [{ from: 0, to: FOREVER, text: slots.text, kicker: slots.kicker, scene: '' }] : [];
  const index = activeIndex(list, frame);
  if (index < 0) return null;
  const cue = list[index];
  const bias = biasMotion(theme.style_bias);
  const c = tones(theme);
  const st = styles(theme);
  const { box, over } = captionBandBox({ rects, area, width, height, unit: u, position: params.position, maxWidth: params.max_width, variant });
  const padX = CAPTION_BAND_PAD_X * u;
  const padY = PAD_Y * u;
  const inner = box.w - 2 * padX;
  const lineSize = st.line.size * u;
  const kickerFont = { size: Math.min(st.kicker.size, 15) * u };

  // The run of cues sharing this kicker: the band is sized for its widest line, so it holds still while lines change.
  const [ra, rb] = kickerRun(list, index);
  const run = list.slice(ra, rb + 1);
  const fitLine = (text: string, lines = params.max_lines) =>
    capTextLayout({
      text,
      width: inner,
      maxFontSize: lineSize,
      minFontSize: lineSize * 0.62,
      maxLines: lines,
      lineHeight: 1.16,
      fontFamily: st.line.font,
      fontWeight: st.line.weight,
      letterSpacing: st.line.letter_spacing,
      uppercase: st.line.uppercase,
    });
  const kt = cue.kicker
    ? capTextLayout({
        text: cue.kicker,
        width: Math.max(10, inner - (RULE_W + RULE_GAP) * u),
        maxFontSize: kickerFont.size,
        minFontSize: kickerFont.size * 0.7,
        maxLines: 1,
        lineHeight: 1.2,
        fontFamily: st.kicker.font,
        fontWeight: st.kicker.weight ?? 600,
        letterSpacing: st.kicker.letter_spacing,
        uppercase: st.kicker.uppercase ?? true,
      })
    : null;
  const lines = run.map((q) => fitLine(q.text));
  const line = lines[index - ra];
  const kickerRow = kt ? (RULE_W + RULE_GAP) * u + kt.width : 0;
  const contentW = Math.max(kickerRow, ...lines.map((l) => l.width));
  const bandW = Math.min(box.w, contentW + 2 * padX);
  const lineBand = Math.max(...lines.map((l) => l.band)) + lineSize * 0.22;
  const kickerBand = kt ? kt.capHeight + KICKER_GAP * u : 0;
  const bandH = padY * 2 + kickerBand + lineBand;
  const bandX = params.align === 'left' ? box.x : box.x + (box.w - bandW) / 2;
  const bandY = over ? box.y + box.h - bandH : box.y + Math.max(0, (box.h - bandH) / 2);
  const left = bandX + padX;
  const centreX = bandX + bandW / 2;
  const center = params.align !== 'left';

  // Motion: the band with its kicker rises in with the run's first cue and fades out with its last; lines change inside.
  const edge = Math.round(EDGE_S * fps);
  const runFrom = list[ra].from;
  const runTo = list[rb].to;
  const runLocal = frame - runFrom - (runFrom === 0 ? edge : 0);
  const bandIn = rise(runLocal, fps, { duration: 0.35 * bias.pace, distance: 10 * bias.travel, unit: u, ease: 'entrance' });
  const bandOut = runTo === FOREVER ? 1 : fadeOut(frame - runFrom, fps, runTo - runFrom - (runTo >= durationInFrames ? edge : 0), { duration: 0.25 });
  const settle = bias.settle > 0 ? roundTo(1 - bias.settle * 0.5 * (1 - Math.min(1, bandIn.opacity)), 4) : 1;
  const local = frame - cue.from;
  const lineIn = index === ra ? { opacity: 1, transform: 'none' } : rise(local, fps, { duration: 0.35 * bias.pace, distance: 7 * bias.travel, unit: u, ease: 'entrance' });
  const lineOut = index === rb || cue.to === FOREVER ? 1 : fadeOut(local, fps, cue.to - cue.from, { duration: 0.25 });
  const kickerCapTop = bandY + padY;
  const lineCapTop = kickerCapTop + kickerBand;
  const rowX = center ? centreX - kickerRow / 2 : left;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: roundTo(bandIn.opacity * bandOut, 4),
          transform: settle !== 1 ? `${bandIn.transform} scale(${settle})` : bandIn.transform,
          transformOrigin: `${roundTo(centreX, 2)}px ${roundTo(bandY + bandH, 2)}px`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: roundTo(bandX, 2),
            top: roundTo(bandY, 2),
            width: roundTo(bandW, 2),
            height: roundTo(bandH, 2),
            borderRadius: 16 * u,
            background: withAlpha(c.band, params.opacity),
            boxShadow: `0 ${10 * u}px ${30 * u}px ${withAlpha(c.band, 0.22)}, inset 0 0 0 ${Math.max(1, u)}px ${withAlpha(c.line, 0.08)}`,
          }}
        />
        {kt ? (
          <>
            <div style={{ position: 'absolute', left: roundTo(rowX, 2), top: roundTo(kickerCapTop + kt.capHeight / 2 - u, 2), width: RULE_W * u, height: 2 * u, background: c.kicker }} />
            <CapText layout={kt} x={rowX + (RULE_W + RULE_GAP) * u} capTop={kickerCapTop} color={c.kicker} />
          </>
        ) : null}
        <div style={{ position: 'absolute', inset: 0, opacity: roundTo(lineIn.opacity * lineOut, 4), transform: lineIn.transform }}>
          <CapText layout={line} x={center ? centreX : left} capTop={lineCapTop} align={center ? 'center' : 'left'} color={c.line} />
        </div>
      </div>
    </div>
  );
}

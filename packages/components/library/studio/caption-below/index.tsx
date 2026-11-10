import {
  CapText,
  activeIndex,
  backgroundSample,
  biasMotion,
  capTextLayout,
  captionMaxLines,
  darkLight,
  fadeOut,
  progress,
  readableOn,
  rise,
  roundTo,
  useCurrentFrame,
  withAlpha,
} from '@retake/components/kit';
import type { CaptionCue, ComponentProps, ThemeTextStyle, ThemeTokens } from '@retake/components/kit';

type Params = { position: 'below' | 'above'; align: 'left' | 'center'; max_lines: number; rule: boolean };

const FOREVER = Number.MAX_SAFE_INTEGER;

/**
 * Reference values (docs/reference/look.md, design px from the top-left of the caption area, which the card layout
 * puts 12 px under the card): text inset 6; kicker row centred 28 below the top — an accent rule 36 × 2, a 12 px gap,
 * the kicker; caption line cap-centred 65.5 below the top.
 */
const INSET = 6;
const KICKER_CENTRE = 28;
const LINE_CENTRE = 65.5;
const RULE_W = 36;
const RULE_GAP = 12;
/** Seconds a caption waits after the clip starts / leaves before it ends (half a crossfade, roughly). */
const EDGE_S = 0.15;

function styles(theme: ThemeTokens): { kicker: ThemeTextStyle; line: ThemeTextStyle } {
  const kicker = theme.captions?.kicker ?? { font: theme.fonts.body, size: 15, weight: 600, uppercase: true, color: theme.colors.accent, letter_spacing: 0.14 };
  const line = theme.captions?.line ?? { font: theme.fonts.display, size: 38, color: theme.colors.text };
  // Never unreadable on the theme background (a theme colour picked for another surface falls back to its pair).
  const bg = backgroundSample(theme);
  const { dark, light } = darkLight(theme);
  const fallback = readableOn(bg, dark, light) === dark ? dark : light;
  return { kicker: { ...kicker, color: readableOn(bg, kicker.color, fallback, 2.2) }, line: { ...line, color: readableOn(bg, line.color, fallback, 3) } };
}

/** First and last cue of the run of contiguous cues sharing the kicker of cue `i` (the kicker stays while the line changes). */
function kickerRun(list: CaptionCue[], i: number): [number, number] {
  let a = i;
  let b = i;
  const k = list[i].kicker ?? '';
  while (a > 0 && (list[a - 1].kicker ?? '') === k && list[a - 1].to === list[a].from) a--;
  while (b < list.length - 1 && (list[b + 1].kicker ?? '') === k && list[b + 1].from === list[b].to) b++;
  return [a, b];
}

/**
 * The active cue in the layout's caption area: accent rule + uppercase kicker over one display line, left-aligned with
 * the card. At a cue change the old line fades out (0.25 s) and the new one fades in (0.35 s) with a 7 px rise; a kicker
 * shared by consecutive cues stays put. style_bias balanced / motion: a little more rise, the rule draws in from the left.
 */
export default function CaptionBelow({ theme, slots, params, unit, width, height, fps, durationInFrames, cues, area, variant, rects }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const list: CaptionCue[] =
    cues && cues.length > 0 ? cues : slots.text ? [{ from: 0, to: FOREVER, text: slots.text, kicker: slots.kicker, scene: '' }] : [];
  const index = activeIndex(list, frame);
  if (index < 0) return null;
  const cue = list[index];
  const bias = biasMotion(theme.style_bias);
  const { kicker: ks, line: ls } = styles(theme);
  const below = area ?? { x: 180 * unit, y: height - 150 * unit, w: width - 360 * unit, h: 110 * unit };
  const above = params.position === 'above';
  // A caption area lying over the capture (a full-frame layout): draw on a paper band so the text reads over any UI.
  const sc = rects?.screen;
  const overCapture = !above && !!sc && below.x < sc.x + sc.w && below.x + below.w > sc.x && below.y < sc.y + sc.h && below.y + below.h > sc.y;
  const pad = above || overCapture ? 24 * unit : 0;
  const box = above ? { x: below.x, y: 36 * unit, w: below.w, h: below.h } : below;
  const center = params.align === 'center';
  const left = box.x + pad + INSET * unit;
  const textW = box.w - 2 * (pad + INSET * unit);
  const anchorX = center ? box.x + box.w / 2 : left;

  // Line: the active cue, fading/rising in at its start and fading out at its end. At the clip's edges (where the clip
  // crossfades with its neighbour) the line enters a little after the clip starts and leaves a little before it ends,
  // so two captions never double-expose in the middle of a crossfade.
  const edge = Math.round(EDGE_S * fps);
  const local = frame - cue.from;
  const enter = rise(local - (cue.from === 0 ? edge : 0), fps, { duration: 0.35 * bias.pace, distance: 7 * bias.travel, unit, ease: 'entrance' });
  const exit = cue.to === FOREVER ? 1 : fadeOut(local, fps, cue.to - cue.from - (cue.to >= durationInFrames ? edge : 0), { duration: 0.25 });
  const maxLines = captionMaxLines(variant, params.max_lines, box.w / unit);
  const line = capTextLayout({
    text: cue.text,
    width: textW,
    // From about the cap top of the first line to the bottom of the area (descenders included).
    height: box.h - LINE_CENTRE * unit + ls.size * unit * 0.65,
    maxFontSize: ls.size * unit,
    minFontSize: ls.size * unit * 0.62,
    maxLines,
    lineHeight: 1.18,
    fontFamily: ls.font,
    fontWeight: ls.weight,
    letterSpacing: ls.letter_spacing,
    uppercase: ls.uppercase,
  });
  const lineCapTop = box.y + LINE_CENTRE * unit - line.capHeight / 2;

  // Kicker: shared by a run of contiguous cues; fades in with the run's first cue and out with its last.
  let kicker = null;
  let kickerRowW = 0;
  if (cue.kicker) {
    const [a, b] = kickerRun(list, index);
    const runFrom = list[a].from;
    const runTo = list[b].to;
    const kl = frame - runFrom - (runFrom === 0 ? edge : 0);
    const kIn = rise(kl, fps, { duration: 0.35 * bias.pace, distance: 7 * bias.travel, unit, ease: 'entrance' });
    const kOut = runTo === FOREVER ? 1 : fadeOut(frame - runFrom, fps, runTo - runFrom - (runTo >= durationInFrames ? edge : 0), { duration: 0.25 });
    const draw = bias.travel > 1 ? progress(kl, fps, { delay: 0.05, duration: 0.45, ease: 'entrance' }) : 1;
    const rule = params.rule ? RULE_W * unit : 0;
    const gap = params.rule ? RULE_GAP * unit : 0;
    const kt = capTextLayout({
      text: cue.kicker,
      width: Math.max(10, textW - rule - gap),
      maxFontSize: ks.size * unit,
      minFontSize: ks.size * unit * 0.7,
      maxLines: 1,
      lineHeight: 1.2,
      fontFamily: ks.font,
      fontWeight: ks.weight ?? 600,
      letterSpacing: ks.letter_spacing,
      uppercase: ks.uppercase,
    });
    const centreY = box.y + KICKER_CENTRE * unit;
    const rowW = rule + gap + kt.width;
    kickerRowW = rowW;
    const rowX = center ? anchorX - rowW / 2 : left;
    kicker = (
      <div style={{ position: 'absolute', inset: 0, opacity: roundTo(kIn.opacity * kOut, 4), transform: kIn.transform }}>
        {params.rule ? (
          <div
            style={{
              position: 'absolute',
              left: roundTo(rowX, 2),
              top: roundTo(centreY - unit, 2),
              width: rule,
              height: 2 * unit,
              background: ks.color,
              transform: draw < 1 ? `scaleX(${roundTo(draw, 4)})` : undefined,
              transformOrigin: 'left center',
            }}
          />
        ) : null}
        <CapText layout={kt} x={rowX + rule + gap} capTop={centreY - kt.capHeight / 2} color={ks.color} />
      </div>
    );
  }

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {above ? (
        <div
          style={{
            position: 'absolute',
            left: box.x,
            top: box.y,
            width: box.w,
            height: box.h,
            borderRadius: 14 * unit,
            background: withAlpha(darkLight(theme).light, 0.92),
            opacity: roundTo(Math.max(enter.opacity, 0) * exit, 4),
          }}
        />
      ) : null}
      {overCapture ? (
        <div
          style={{
            position: 'absolute',
            left: roundTo(center ? anchorX - Math.max(line.width, kickerRowW) / 2 - pad : box.x, 2),
            top: box.y,
            width: roundTo(Math.max(line.width, kickerRowW) + 2 * pad + (center ? 0 : 2 * INSET * unit), 2),
            height: roundTo(LINE_CENTRE * unit + (line.lines.length - 1) * line.lineHeightPx + line.capHeight / 2 + 24 * unit, 2),
            borderRadius: 14 * unit,
            // The theme background (the caption colours were chosen to read on it), a touch translucent.
            background: withAlpha(backgroundSample(theme), 0.96),
            boxShadow: `0 ${8 * unit}px ${24 * unit}px ${withAlpha(darkLight(theme).dark, 0.12)}`,
            opacity: roundTo(Math.max(enter.opacity, 0) * exit, 4),
          }}
        />
      ) : null}
      {kicker}
      <div style={{ position: 'absolute', inset: 0, opacity: roundTo(enter.opacity * exit, 4), transform: enter.transform }}>
        <CapText layout={line} x={anchorX} capTop={lineCapTop} align={center ? 'center' : 'left'} color={ls.color} />
      </div>
    </div>
  );
}

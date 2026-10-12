import { useCurrentFrame } from 'remotion';
import {
  CapText,
  KEY_GLYPHS,
  SYSTEM_COLORS,
  biasMotion,
  capTextLayout,
  clamp,
  darkLight,
  fadeOut,
  liftToContrast,
  mixColors,
  nightTone,
  parseShortcut,
  progress,
  readableOn,
  roundTo,
  safeAreaRect,
  shortcutPlateBox,
  shortcutPlateMetrics,
  withAlpha,
} from '@demo-studio/components/kit';
import type { ComponentProps, KeyPlatform } from '@demo-studio/components/kit';

type Params = { platform: KeyPlatform; position: 'bottom' | 'top'; size: number; tone: 'dark' | 'light'; hints: boolean };

/** Seconds between two presses of a repeated key (as the runner paces `press: {times}`). */
const REPEAT_S = 0.16;

/** Depth 0..1 of a key cap pressed at frame `at` (down in 2 frames, held `hold` frames, up in 4). */
function depth(frame: number, at: number, hold: number): number {
  if (frame < at) return 0;
  if (frame < at + 2) return (frame - at + 1) / 2;
  if (frame < at + 2 + hold) return 1;
  return clamp(1 - (frame - at - 2 - hold) / 4);
}

/**
 * Key caps of a shortcut on a plate at the bottom (or top) centre of the capture. The caps rise in, go down on the
 * key press (`moment`; modifiers 2 frames earlier and held longer), a "× N" chip counts repeated presses; fade out
 * over the last 0.25 s.
 */
export default function OverlayShortcut({ theme, slots, params, unit, width, height, fps, durationInFrames, rects, moment, variant, avoid }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const caps = parseShortcut(slots.keys ?? '', params.platform);
  if (caps.length === 0) return null;
  const m = shortcutPlateMetrics(params.size, unit, variant);
  const u = m.u;
  const bias = biasMotion(theme.style_bias);
  const { dark, light } = darkLight(theme);
  const night = nightTone(theme);
  const dk = params.tone !== 'light';
  const plate = dk ? night : light;
  const ink = dk ? readableOn(night, light, theme.colors.paper, 4.5) : readableOn(light, dark, theme.colors.text, 4.5);
  const face = dk ? mixColors(night, ink, 0.12) : mixColors(light, dark, 0.04);
  const edge = dk ? mixColors(night, SYSTEM_COLORS.black, 0.45) : mixColors(light, dark, 0.22);
  const accent = liftToContrast(plate, theme.colors.accent, ink, 2.4);
  const { capH, pad, gap } = m;
  const radius = capH * 0.2;
  const press = moment ?? Math.round(0.3 * fps);
  const times = Math.max(1, Math.min(99, Number.parseInt(slots.times ?? '1', 10) || 1));
  const repeat = Math.max(2, Math.round(REPEAT_S * fps));
  const pc = params.platform !== 'mac';

  // Cap sizes: a symbol or a letter is square; a word is as wide as its text.
  const font = theme.fonts.body;
  const layouts = caps.map((c) => {
    const word = c.glyph ? null : capTextLayout({ text: c.label, width: 600 * u, maxFontSize: capH * (c.label.length > 1 ? 0.34 : 0.44), minFontSize: capH * 0.2, maxLines: 1, lineHeight: 1.1, fontFamily: font, fontWeight: 600 });
    const w = c.glyph || !c.wide ? capH : Math.max(capH, (word?.width ?? 0) + capH * 0.6);
    return { cap: c, word, w };
  });
  const plus = pc ? capTextLayout({ text: '+', width: 200, maxFontSize: capH * 0.36, minFontSize: capH * 0.2, maxLines: 1, fontFamily: font, fontWeight: 500 }) : null;
  const plusW = plus ? plus.width + gap * 2 : gap;
  const label = slots.label ? capTextLayout({ text: slots.label, width: 520 * u, maxFontSize: capH * 0.32, minFontSize: capH * 0.2, maxLines: 1, lineHeight: 1.1, fontFamily: font, fontWeight: 500 }) : null;
  const countLabel = times > 1 ? capTextLayout({ text: `× ${times}`, width: 200 * u, maxFontSize: capH * 0.3, minFontSize: capH * 0.18, maxLines: 1, fontFamily: font, fontWeight: 600 }) : null;
  const capsW = layouts.reduce((s, l) => s + l.w, 0) + (layouts.length - 1) * (pc ? plusW : gap);
  const labelW = label ? label.width + capH * 0.4 : 0;
  const countW = countLabel ? countLabel.width + capH * 0.5 + gap : 0;
  const W = capsW + labelW + countW + 2 * pad;
  const H = m.height;

  const inset = m.inset;
  const screen = rects?.screen;
  const bounds = screen && screen.w > W + 2 * inset ? { x: screen.x + inset, y: screen.y + inset, w: screen.w - 2 * inset, h: screen.h - 2 * inset } : safeAreaRect(width, height, 0.04);
  // Centred at the bottom (or the top) of the capture, moved clear of a caption band drawn over it.
  const { x, y } = shortcutPlateBox({ bounds, w: W, h: H, position: params.position, ...(avoid ? { avoid } : {}), gap: m.clearance });

  const enter = progress(frame, fps, { duration: 0.24 * bias.pace, ease: 'entrance' });
  const out = fadeOut(frame, fps, durationInFrames, { duration: 0.25 });
  const shift = (1 - enter) * 14 * bias.travel * u * (params.position === 'top' ? -1 : 1);
  const pressedCount = frame < press ? 0 : Math.min(times, 1 + Math.floor((frame - press) / repeat));

  let cx = pad;
  const nodes = layouts.map((l, i) => {
    const mod = l.cap.modifier;
    const at = mod ? press - 2 : press;
    let d = depth(frame, at, mod ? 4 + (times - 1) * repeat : 3);
    if (!mod) for (let k = 1; k < times; k++) d = Math.max(d, depth(frame, press + k * repeat, 3));
    const left = cx;
    cx += l.w + (i < layouts.length - 1 ? (pc ? plusW : gap) : 0);
    const sink = d * capH * 0.06;
    const capFace = d > 0 ? mixColors(face, accent, 0.28 * d) : face;
    const iconSize = capH * 0.46;
    const hint = !pc && params.hints && l.cap.hint;
    return (
      <div key={i}>
        <div
          style={{
            position: 'absolute',
            left: roundTo(left, 2),
            top: roundTo(pad + sink, 2),
            width: roundTo(l.w, 2),
            height: roundTo(capH, 2),
            borderRadius: radius,
            background: capFace,
            boxShadow: `0 ${roundTo((1 - d) * capH * 0.06 + 1, 2)}px 0 ${edge}, inset 0 ${Math.max(1, u)}px 0 ${withAlpha(ink, dk ? 0.14 : 0.5)}`,
          }}
        />
        {l.cap.glyph ? (
          <svg
            width={iconSize}
            height={iconSize}
            viewBox="0 0 24 24"
            fill="none"
            stroke={ink}
            strokeWidth={1.9}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ position: 'absolute', left: roundTo(left + (l.w - iconSize) / 2, 2), top: roundTo(pad + sink + (capH - iconSize) / 2 - (hint ? capH * 0.08 : 0), 2) }}
          >
            <path d={KEY_GLYPHS[l.cap.glyph]} />
          </svg>
        ) : l.word ? (
          <CapText layout={l.word} x={left + l.w / 2} capTop={pad + sink + (capH - l.word.capHeight) / 2} align="center" color={ink} />
        ) : null}
        {hint ? (
          <div style={{ position: 'absolute', left: roundTo(left, 2), top: roundTo(pad + sink + capH * 0.7, 2), width: roundTo(l.w, 2), textAlign: 'center', fontFamily: font, fontSize: capH * 0.15, color: withAlpha(ink, 0.7), lineHeight: 1 }}>
            {l.cap.hint}
          </div>
        ) : null}
        {pc && plus && i < layouts.length - 1 ? <CapText layout={plus} x={left + l.w + plusW / 2} capTop={pad + (capH - plus.capHeight) / 2} align="center" color={withAlpha(ink, 0.6)} /> : null}
      </div>
    );
  });
  const after = pad + capsW;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: roundTo(out * clamp(enter * 1.3), 4) }}>
      <div
        style={{
          position: 'absolute',
          left: roundTo(x, 2),
          top: roundTo(y + shift, 2),
          width: roundTo(W, 2),
          height: roundTo(H, 2),
          borderRadius: radius + pad,
          background: withAlpha(plate, dk ? 0.9 : 0.94),
          boxShadow: `0 ${10 * u}px ${30 * u}px ${withAlpha(dark, 0.28)}, inset 0 0 0 ${Math.max(1, u)}px ${withAlpha(ink, 0.08)}`,
        }}
      >
        {nodes}
        {label ? <CapText layout={label} x={after + capH * 0.4} capTop={pad + (capH - label.capHeight) / 2} color={withAlpha(ink, 0.82)} /> : null}
        {countLabel && pressedCount > 1 ? (
          <div
            style={{
              position: 'absolute',
              left: roundTo(after + labelW + gap, 2),
              top: roundTo(pad + capH * 0.18, 2),
              width: roundTo(countLabel.width + capH * 0.5, 2),
              height: roundTo(capH * 0.64, 2),
              borderRadius: capH * 0.32,
              background: accent,
            }}
          >
            <CapText
              layout={capTextLayout({ text: `× ${pressedCount}`, width: 200 * u, maxFontSize: capH * 0.3, minFontSize: capH * 0.18, maxLines: 1, fontFamily: font, fontWeight: 600 })}
              x={(countLabel.width + capH * 0.5) / 2}
              capTop={(capH * 0.64 - countLabel.capHeight) / 2}
              align="center"
              color={readableOn(accent, plate, ink, 3)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

import { useCurrentFrame } from 'remotion';
import {
  Background,
  CapText,
  Logo,
  Wordmark,
  backgroundSample,
  biasMotion,
  capTextLayout,
  darkLight,
  progress,
  readableOn,
  roundTo,
  formatMetrics,
} from '@retake/components/kit';
import type { ComponentProps, ThemeTokens } from '@retake/components/kit';

type Params = { align: 'center' | 'left'; rule: boolean; stagger: number };

/**
 * Reference values (docs/reference/look.md "Intro", design px): logo mark 64 + 18 px gap + wordmark (visual height
 * 33: the brand name in the display font at ≈ 43 px when there is no wordmark image), kicker body SemiBold 18 px
 * uppercase +0.18 em in the accent, title display 96 px tight, accent rule 120 × 2. The vertical rhythm is measured
 * between visual bands (logo row, kicker caps, title caps → baseline, rule); the whole stack is centred, which puts
 * the logo row at y ≈ 417, the kicker at ≈ 529, the title at ≈ 612 and the rule at ≈ 694 on a 1080 frame.
 */
const LOGO = 64;
const WORDMARK = 33;
const ROW_GAP = 18;
const GAP_ROW_KICKER = 73;
const GAP_KICKER_TITLE = 43;
const GAP_ROW_TITLE = 92;
const GAP_TITLE_RULE = 49;
const RULE_W = 120;

function hasBrandRow(theme: ThemeTokens, logo?: string): boolean {
  return !!(logo || theme.logo?.url || theme.wordmark?.url || theme.wordmark?.text || theme.brand.name);
}

/** Eased entrance: opacity 0 → 1 and a rise of `distance` px over [delay, delay + duration] seconds. */
function appear(frame: number, fps: number, delay: number, duration: number, distance: number, settle = 0) {
  const p = progress(frame, fps, { delay, duration, ease: 'easeInOut' });
  const y = roundTo((1 - p) * distance, 2);
  const s = settle > 0 ? roundTo(1 - settle * (1 - p), 4) : 1;
  return { p, style: { opacity: roundTo(p, 4), transform: s !== 1 ? `translateY(${y}px) scale(${s})` : `translateY(${y}px)` } };
}

/**
 * Logo + wordmark row, uppercase kicker, display title and an accent rule drawn from the centre, staggered on the theme
 * background: the row fades in (0–0.5 s), kicker and title fade in with a short rise (0.6–1.2 s), the rule draws
 * (≈ 1.0–1.5 s), then everything holds until the crossfade into the first clip. style_bias balanced / motion: more
 * rise, a small scale settle on the row and a tracking settle on the title.
 */
export default function IntroStack({ theme, slots, params, unit, width, height, fps, variant }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const { u, inset } = formatMetrics(variant, unit);
  const bias = biasMotion(theme.style_bias);
  const center = params.align !== 'left';
  const margin = inset(160);
  const column = Math.min(width - 2 * margin, 1500 * u);
  const bg = backgroundSample(theme);
  const { dark, light } = darkLight(theme);
  const ink = readableOn(bg, theme.colors.text, readableOn(bg, dark, light) === dark ? dark : light);
  const accent = readableOn(bg, theme.colors.accent, ink, 2.2);
  const brand = slots.logo ? { ...theme, logo: { url: slots.logo } } : theme;
  const row = hasBrandRow(theme, slots.logo);

  const kicker = slots.kicker
    ? capTextLayout({ text: slots.kicker, width: column, maxFontSize: 18 * u, minFontSize: 12 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.18, uppercase: true })
    : null;
  const title = capTextLayout({
    text: slots.title ?? '',
    width: column,
    maxFontSize: 96 * u,
    minFontSize: 56 * u,
    maxLines: 2,
    lineHeight: 1.05,
    fontFamily: theme.fonts.display,
    letterSpacing: -0.015,
  });

  // Vertical rhythm: bands and gaps, then centre the whole stack.
  let y = 0;
  const rowTop = row ? y : undefined;
  if (row) y += LOGO * u;
  let kickerTop: number | undefined;
  if (kicker) {
    if (row) y += GAP_ROW_KICKER * u;
    kickerTop = y;
    y += kicker.capHeight;
    y += GAP_KICKER_TITLE * u;
  } else if (row) y += GAP_ROW_TITLE * u;
  const titleTop = y;
  y += title.band;
  let ruleTop: number | undefined;
  if (params.rule) {
    y += GAP_TITLE_RULE * u;
    ruleTop = y;
    y += 2 * u;
  }
  const top = Math.round((height - y) / 2);
  const x = center ? width / 2 : margin;
  const align = center ? 'center' : 'left';

  // Motion (seconds); `stagger` spaces the kicker and the title (0.15 s by default, as in the reference).
  const step = params.stagger;
  const rowIn = appear(frame, fps, 0, 0.5 * bias.pace, bias.travel > 1 ? 6 * bias.travel * u : 0, bias.settle);
  const kickerIn = appear(frame, fps, 0.6, 0.4 * bias.pace, 10 * bias.travel * u);
  const titleIn = appear(frame, fps, 0.6 + step, 0.45 * bias.pace, 12 * bias.travel * u);
  const draw = progress(frame, fps, { delay: 0.6 + step + 0.2, duration: 0.5, ease: bias.travel > 1 ? 'entrance' : 'standard' });
  const tracking = bias.tracking > 0 ? roundTo(-0.015 + bias.tracking * (1 - titleIn.p), 4) : undefined;

  return (
    <Background theme={theme}>
      {row && rowTop !== undefined ? (
        <div
          style={{
            position: 'absolute',
            left: center ? 0 : margin,
            width: center ? width : column,
            top: roundTo(top + rowTop, 2),
            height: LOGO * u,
            display: 'flex',
            alignItems: 'center',
            justifyContent: center ? 'center' : 'flex-start',
            gap: ROW_GAP * u,
            ...rowIn.style,
          }}
        >
          <Logo theme={brand} size={LOGO} unit={u} />
          <Wordmark theme={theme} height={WORDMARK} unit={u} color={ink} />
        </div>
      ) : null}
      {kicker && kickerTop !== undefined ? (
        <div style={{ position: 'absolute', inset: 0, ...kickerIn.style }}>
          <CapText layout={kicker} x={x} capTop={top + kickerTop} align={align} color={accent} />
        </div>
      ) : null}
      <div style={{ position: 'absolute', inset: 0, ...titleIn.style }}>
        <CapText layout={title} x={x} capTop={top + titleTop} align={align} color={ink} style={tracking !== undefined ? { letterSpacing: `${tracking}em` } : undefined} />
      </div>
      {ruleTop !== undefined ? (
        <div
          style={{
            position: 'absolute',
            left: roundTo(center ? x - (RULE_W * u) / 2 : x, 2),
            top: Math.round(top + ruleTop),
            width: RULE_W * u,
            height: 2 * u,
            background: accent,
            transform: `scaleX(${roundTo(draw, 4)})`,
            transformOrigin: center ? 'center' : 'left',
          }}
        />
      ) : null}
    </Background>
  );
}

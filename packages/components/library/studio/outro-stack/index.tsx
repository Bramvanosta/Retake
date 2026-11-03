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
  withAlpha,
  formatMetrics,
} from '@retake/components/kit';
import type { ComponentProps } from '@retake/components/kit';

type Params = { logo_size: number; stagger: number };

/**
 * Reference values (docs/reference/look.md "Outro", design px): logo mark 150, wordmark (visual height 71: the brand
 * name in the display font at ≈ 92 px when there is no wordmark image), accent rule 120 × 2, tagline body Regular 30
 * in the muted colour, url body SemiBold 18 uppercase +0.14 em, muted at 70 %. Bands and gaps as measured; the stack
 * is centred, which puts the logo at y 333–483, the wordmark at ≈ 571, the rule at ≈ 647, the tagline at ≈ 690 and
 * the url at ≈ 737 on a 1080 frame.
 */
const WORDMARK = 71;
const GAP_LOGO_WORDMARK = 53;
const GAP_WORDMARK_RULE = 40;
const GAP_RULE_TAGLINE = 29;
const GAP_TAGLINE_URL = 30;
const RULE_W = 120;

function appear(frame: number, fps: number, delay: number, duration: number, distance: number) {
  const p = progress(frame, fps, { delay, duration, ease: 'easeInOut' });
  return { opacity: roundTo(p, 4), transform: `translateY(${roundTo((1 - p) * distance, 2)}px)` };
}

/**
 * Big logo (fades in while scaling 0.92 → 1), the wordmark 0.2 s later, then the rule, the tagline and the url, each
 * `stagger` s after the previous one; centred, then held. style_bias balanced / motion: more rise and a softer pace.
 */
export default function OutroStack({ theme, slots, params, unit, width, height, fps, variant }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const { u, inset } = formatMetrics(variant, unit);
  const bias = biasMotion(theme.style_bias);
  const bg = backgroundSample(theme);
  const { dark, light } = darkLight(theme);
  const ink = readableOn(bg, theme.colors.text, readableOn(bg, dark, light) === dark ? dark : light);
  const muted = readableOn(bg, theme.colors.muted, ink, 2.5);
  const accent = readableOn(bg, theme.colors.accent, ink, 2.2);
  const brand = slots.logo ? { ...theme, logo: { url: slots.logo } } : theme;
  const hasLogo = !!(brand.logo?.url || theme.brand.name);
  const hasWordmark = !!(theme.wordmark?.url || theme.wordmark?.text || theme.brand.name);
  const column = Math.min(width - 2 * inset(160), 1300 * u);
  const logo = params.logo_size;

  const tagline = slots.tagline
    ? capTextLayout({ text: slots.tagline, width: column, maxFontSize: 30 * u, minFontSize: 20 * u, maxLines: 2, lineHeight: 1.3, fontFamily: theme.fonts.body, fontWeight: 400 })
    : null;
  const url = slots.url
    ? capTextLayout({ text: slots.url, width: column, maxFontSize: 18 * u, minFontSize: 12 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.14, uppercase: true })
    : null;

  // Bands and gaps, then centre the stack.
  let y = 0;
  const logoTop = hasLogo ? y : undefined;
  if (hasLogo) y += logo * u;
  let wordmarkTop: number | undefined;
  if (hasWordmark) {
    if (hasLogo) y += GAP_LOGO_WORDMARK * u;
    wordmarkTop = y;
    y += WORDMARK * u;
  }
  y += GAP_WORDMARK_RULE * u;
  const ruleTop = y;
  y += 2 * u;
  let taglineTop: number | undefined;
  if (tagline) {
    y += GAP_RULE_TAGLINE * u;
    taglineTop = y;
    y += tagline.band;
  }
  let urlTop: number | undefined;
  if (url) {
    y += (tagline ? GAP_TAGLINE_URL : GAP_RULE_TAGLINE) * u;
    urlTop = y;
    y += url.capHeight;
  }
  const top = Math.round((height - y) / 2);
  const cx = width / 2;

  const step = params.stagger;
  const logoP = progress(frame, fps, { delay: 0.1, duration: 0.6 * bias.pace, ease: 'easeInOut' });
  const logoScale = 0.92 + 0.08 * progress(frame, fps, { delay: 0.1, duration: 0.7 * bias.pace, ease: 'entrance' });
  const wordmarkIn = appear(frame, fps, 0.3, 0.5 * bias.pace, 10 * bias.travel * u);
  const ruleAt = 0.3 + 0.25;
  const draw = progress(frame, fps, { delay: ruleAt, duration: 0.45, ease: 'standard' });
  const taglineIn = appear(frame, fps, ruleAt + step, 0.45 * bias.pace, 8 * bias.travel * u);
  const urlIn = appear(frame, fps, ruleAt + 2 * step, 0.45 * bias.pace, 6 * bias.travel * u);

  return (
    <Background theme={theme}>
      {logoTop !== undefined ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            width,
            top: top + logoTop,
            height: logo * u,
            display: 'flex',
            justifyContent: 'center',
            opacity: roundTo(logoP, 4),
            transform: `scale(${roundTo(logoScale, 4)})`,
            transformOrigin: 'center',
          }}
        >
          <Logo theme={brand} size={logo} unit={u} />
        </div>
      ) : null}
      {wordmarkTop !== undefined ? (
        <div style={{ position: 'absolute', left: 0, width, top: top + wordmarkTop, height: WORDMARK * u, display: 'flex', justifyContent: 'center', ...wordmarkIn }}>
          <Wordmark theme={theme} height={WORDMARK} unit={u} color={ink} />
        </div>
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: roundTo(cx - (RULE_W * u) / 2, 2),
          top: Math.round(top + ruleTop),
          width: RULE_W * u,
          height: 2 * u,
          background: accent,
          transform: `scaleX(${roundTo(draw, 4)})`,
          transformOrigin: 'center',
        }}
      />
      {tagline && taglineTop !== undefined ? (
        <div style={{ position: 'absolute', inset: 0, ...taglineIn }}>
          <CapText layout={tagline} x={cx} capTop={top + taglineTop} align="center" color={muted} />
        </div>
      ) : null}
      {url && urlTop !== undefined ? (
        <div style={{ position: 'absolute', inset: 0, ...urlIn }}>
          <CapText layout={url} x={cx} capTop={top + urlTop} align="center" color={withAlpha(muted, 0.7)} />
        </div>
      ) : null}
    </Background>
  );
}

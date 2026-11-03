import type { ReactNode } from 'react';
import { Background, InsetCard, InsetPhone, PIP_BAR, WindowBar, cardShadow, darkLight, nightTone, withAlpha } from '@retake/components/kit';
import type { ComponentProps, LayoutPaneRects, ThemeTokens } from '@retake/components/kit';

type Params = {
  width: number;
  radius: number;
  shadow: 'none' | 'soft' | 'strong';
  chrome: boolean;
  inset_height: number;
  inset_width: number;
  margin: number;
  emphasis: 'auto' | 'none' | 'grow';
};

/**
 * The default panes (output px) — ONLY used outside a plan (unit tests): in a plan the composition passes
 * `rects.panes` (the main page, then the inset at its corner of this frame). A 16:9 page with a phone at the bottom right.
 */
export function defaultPanes(params: Pick<Params, 'width' | 'radius' | 'chrome' | 'inset_height' | 'inset_width' | 'margin'>, unit: number): LayoutPaneRects[] {
  const bar = params.chrome ? PIP_BAR : 0;
  const h = Math.min(Math.round(params.width / (16 / 9)), 878 - bar);
  const w = Math.min(params.width, Math.floor((878 - bar) * (16 / 9)));
  const x = Math.round((1920 - w) / 2);
  const y = Math.round((958 - bar - h) / 2) + bar;
  const a2 = 390 / 844;
  const ih = Math.round(Math.min(h * params.inset_height, (w * params.inset_width) / a2));
  const iw = Math.round(ih * a2);
  const s = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x * unit, y: r.y * unit, w: r.w * unit, h: r.h * unit });
  const main = s({ x, y, w, h });
  const inset = s({ x: x + w - params.margin - iw, y: y + h - params.margin - ih, w: iw, h: ih });
  return [
    { page: 'desktop', screen: main, frame: main, radius: params.radius * unit, acting: 1 },
    { page: 'phone', screen: inset, frame: inset, radius: 18 * unit, acting: 0, inset: true, mobile: true },
  ];
}

/** Stand-in for a page in unit previews: a quiet app skeleton in theme colours. */
function Skeleton({ theme, unit }: { theme: ThemeTokens; unit: number }) {
  const { dark, light } = darkLight(theme);
  const bar = (w: string, h: number, tint = withAlpha(dark, 0.08)) => <div style={{ width: w, height: h * unit, borderRadius: 6 * unit, background: tint }} />;
  return (
    <div style={{ position: 'absolute', inset: 0, background: light, padding: 24 * unit, display: 'flex', flexDirection: 'column', gap: 14 * unit }}>
      {bar('100%', 30)}
      {bar('55%', 22, withAlpha(theme.colors.accent, 0.18))}
      {bar('100%', 80)}
      {bar('80%', 80)}
    </div>
  );
}

/**
 * Picture in picture at the planner's rects: the main page in the reference card (or a browser window with its real
 * URL, `chrome`), the other page floating over the corner the planner chose for this frame — inside a phone drawn in
 * CSS when it is a mobile page, else a smaller card —, grown while its page acts when the theme asks (the planner's
 * rects already say so); with that emphasis the main page dims a little while the inset acts.
 */
export default function LayoutPip({ theme, params, unit, screens, rects }: ComponentProps<Params>) {
  const u = unit;
  const panes = rects?.panes ?? defaultPanes(params, u);
  const mainIndex = Math.max(0, panes.findIndex((p) => !p.inset));
  const main = panes[mainIndex];
  const insetIndex = panes.findIndex((p) => p.inset);
  const inset = insetIndex >= 0 ? panes[insetIndex] : undefined;
  const night = nightTone(theme);
  const bar = params.chrome ? PIP_BAR * u : 0;
  const card = { x: main.frame.x, y: main.frame.y - bar, w: main.frame.w, h: main.frame.h + bar };
  const grows = params.emphasis === 'grow' || (params.emphasis === 'auto' && theme.style_bias !== 'real');
  const insetActs = inset ? inset.acting : 0;
  const mainScreen = screens?.[mainIndex] as ReactNode | undefined;
  const insetScreen = insetIndex >= 0 ? (screens?.[insetIndex] as ReactNode | undefined) : undefined;
  return (
    <Background theme={theme}>
      <div
        style={{
          position: 'absolute',
          left: card.x,
          top: card.y,
          width: card.w,
          height: card.h,
          borderRadius: main.radius,
          boxShadow: cardShadow(theme, params.shadow, u),
          background: night,
          overflow: 'hidden',
          isolation: 'isolate',
        }}
      >
        {bar > 0 ? <WindowBar theme={theme} w={card.w} h={bar} url={main.url} unit={u} /> : null}
        <div style={{ position: 'absolute', left: main.screen.x - card.x, top: main.screen.y - card.y, width: main.screen.w, height: main.screen.h }}>
          {mainScreen ?? <Skeleton theme={theme} unit={u} />}
        </div>
        {grows && insetActs > 0 ? <div style={{ position: 'absolute', inset: 0, background: night, opacity: Math.round(0.12 * insetActs * 1000) / 1000 }} /> : null}
      </div>
      {inset ? (
        inset.mobile ? (
          <InsetPhone theme={theme} display={inset.screen} unit={u}>
            <div style={{ position: 'absolute', inset: 0 }}>{insetScreen ?? <Skeleton theme={theme} unit={u} />}</div>
          </InsetPhone>
        ) : (
          <InsetCard theme={theme} rect={inset.screen} radius={inset.radius} unit={u}>
            <div style={{ position: 'absolute', inset: 0 }}>{insetScreen ?? <Skeleton theme={theme} unit={u} />}</div>
          </InsetCard>
        )
      ) : null}
    </Background>
  );
}

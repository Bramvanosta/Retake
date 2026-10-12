import type { ReactNode } from 'react';
import { Background, PANE_BAR, PANE_LABEL_ROW, PaneLabel, WindowBar, cardShadow, darkLight, nightTone, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps, LayoutPaneRects, ThemeTokens } from '@demo-studio/components/kit';

type Params = { margin: number; gap: number; radius: number; shadow: 'none' | 'soft' | 'strong'; chrome: boolean; labels: boolean; emphasis: 'auto' | 'none' | 'dim' };

/**
 * The default panes (output px) — ONLY used outside a plan (unit tests): in a plan the composition passes
 * `rects.panes`, the manifest geometry evaluated by the planner with both pages' aspects. Two 16:10 pages side by side.
 */
export function defaultPanes(params: Pick<Params, 'margin' | 'gap' | 'radius' | 'chrome' | 'labels'>, unit: number): LayoutPaneRects[] {
  const W = (1920 - 2 * params.margin - params.gap) / 2;
  const h = Math.round(W / 1.6);
  const lab = params.labels ? PANE_LABEL_ROW : 0;
  const bar = params.chrome ? PANE_BAR : 0;
  const top = Math.round((1080 - (lab + bar + h + 12 + 110)) / 2) + lab + bar;
  return [0, 1].map((i) => {
    const r = { x: (params.margin + i * (W + params.gap)) * unit, y: top * unit, w: W * unit, h: h * unit };
    return { page: `page${i + 1}`, label: i === 0 ? 'Page one' : 'Page two', screen: r, frame: r, radius: params.radius * unit, acting: i === 0 ? 1 : 0 };
  });
}

/** Stand-in for a page in unit previews: a quiet app skeleton in theme colours. */
function Skeleton({ theme, unit }: { theme: ThemeTokens; unit: number }) {
  const { dark, light } = darkLight(theme);
  const bar = (w: string, h: number, tint = withAlpha(dark, 0.08)) => <div style={{ width: w, height: h * unit, borderRadius: 6 * unit, background: tint }} />;
  return (
    <div style={{ position: 'absolute', inset: 0, background: light, padding: 28 * unit, display: 'flex', flexDirection: 'column', gap: 16 * unit }}>
      {bar('100%', 36)}
      {bar('55%', 26, withAlpha(theme.colors.accent, 0.18))}
      {bar('100%', 90)}
      {bar('80%', 90)}
    </div>
  );
}

/**
 * Two pages side by side at the planner's rects (`rects.panes`; stacked in vertical): each in a rounded card with the
 * reference soft shadow — or a compact browser window with the page's real URL (`chrome`) —, its label above it (the
 * acting page's in the accent colour). With `emphasis` (auto: style_bias balanced / motion) the idle page is dimmed a
 * little. The composition draws the caption and the brand mark; the frames never move on their own.
 */
export default function LayoutSplit({ theme, params, unit, screens, rects }: ComponentProps<Params>) {
  const u = unit;
  const panes = rects?.panes ?? defaultPanes(params, u);
  const night = nightTone(theme);
  const dim = params.emphasis === 'dim' || (params.emphasis === 'auto' && theme.style_bias !== 'real');
  const bar = params.chrome ? PANE_BAR * u : 0;
  return (
    <Background theme={theme}>
      {panes.map((p, i) => {
        const card = { x: p.frame.x, y: p.frame.y - bar, w: p.frame.w, h: p.frame.h + bar };
        const screen = screens?.[i] as ReactNode | undefined;
        return (
          <div key={p.page}>
            {params.labels && p.label ? <PaneLabel theme={theme} x={card.x + 2 * u} y={card.y - PANE_LABEL_ROW * u} w={card.w} label={p.label} acting={p.acting} unit={u} /> : null}
            <div
              style={{
                position: 'absolute',
                left: card.x,
                top: card.y,
                width: card.w,
                height: card.h,
                borderRadius: p.radius,
                boxShadow: cardShadow(theme, params.shadow, u),
                background: night,
                overflow: 'hidden',
                isolation: 'isolate',
              }}
            >
              {bar > 0 ? <WindowBar theme={theme} w={card.w} h={bar} url={p.url} unit={u} /> : null}
              <div style={{ position: 'absolute', left: p.screen.x - card.x, top: p.screen.y - card.y, width: p.screen.w, height: p.screen.h }}>
                {screen ?? <Skeleton theme={theme} unit={u} />}
              </div>
              {dim && p.acting < 1 ? <div style={{ position: 'absolute', inset: 0, background: night, opacity: Math.round(0.16 * (1 - p.acting) * 1000) / 1000 }} /> : null}
            </div>
          </div>
        );
      })}
    </Background>
  );
}
